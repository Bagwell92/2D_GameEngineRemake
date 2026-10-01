// PixelForge runtime: turns a project (plain JSON made by the editor) into a playable game.
// Used both by the editor's playtest and by exported standalone games.
(function (global) {
  'use strict';
  const E = global.Engine;
  const { Game, Scene, Entity, Tilemap, moveAndCollide, drawFrame, text, approach, rand, overlaps } = E;

  const MAX_FALL = 400;

  const DEFAULT_SETTINGS = {
    title: '', mode: 'platformer', width: 320, height: 180, scale: 3, tileSize: 16,
    gravity: 900, lives: 3, background: '#1a1c2c', showTitle: true,
  };

  // ---------- Behaviors ----------
  // Every object type picks one behavior. Each behavior lists its editable properties and sound
  // slots, so the editor can build its inspector automatically. `mode` limits a field to one game mode.
  const BEHAVIORS = {
    player: {
      label: 'Player', size: [10, 14], color: '#3b5dc9',
      desc: 'The character you control. Only one per level.',
      props: [
        { key: 'speed', label: 'Move speed', type: 'number', default: 110 },
        { key: 'jump', label: 'Jump strength', type: 'number', default: 300, mode: 'platformer' },
        { key: 'runSprite', label: 'Moving sprite', type: 'sprite', default: '' },
        { key: 'jumpSprite', label: 'Jumping sprite', type: 'sprite', default: '', mode: 'platformer' },
      ],
      sounds: [{ key: 'jump', label: 'Jump', default: 'synth:jump' }, { key: 'hurt', label: 'Hurt', default: 'synth:hurt' }],
    },
    collectible: {
      label: 'Collectible', size: [8, 8], color: '#ffd23f',
      desc: 'Picked up on touch and adds to the score.',
      props: [
        { key: 'value', label: 'Points', type: 'number', default: 1 },
        { key: 'heal', label: 'Gives an extra life', type: 'bool', default: false },
      ],
      sounds: [{ key: 'collect', label: 'Collect', default: 'synth:coin' }],
    },
    enemy: {
      label: 'Enemy', size: [12, 10], color: '#38b764',
      desc: 'Moves around and hurts the player on touch. In platformers you can jump on it.',
      props: [
        { key: 'speed', label: 'Speed', type: 'number', default: 30 },
        { key: 'direction', label: 'Movement', type: 'select', options: ['horizontal', 'vertical', 'chase', 'still'], default: 'horizontal' },
        { key: 'stompable', label: 'Can be stomped', type: 'bool', default: true, mode: 'platformer' },
        { key: 'gravity', label: 'Falls with gravity', type: 'bool', default: true, mode: 'platformer' },
        { key: 'turnAtEdges', label: 'Turns around at ledges', type: 'bool', default: true, mode: 'platformer' },
      ],
      sounds: [{ key: 'defeat', label: 'Defeated', default: 'synth:stomp' }],
    },
    hazard: {
      label: 'Hazard', size: [12, 7], color: '#c0cbdc',
      desc: 'Hurts the player on touch (spikes, saws, fire...).',
      props: [], sounds: [],
    },
    spring: {
      label: 'Spring', size: [14, 6], color: '#e43b44', mode: 'platformer',
      desc: 'Launches the player into the air.',
      props: [{ key: 'power', label: 'Launch strength', type: 'number', default: 450 }],
      sounds: [{ key: 'bounce', label: 'Bounce', default: 'synth:bounce' }],
    },
    checkpoint: {
      label: 'Checkpoint', size: [8, 16], color: '#566c86',
      desc: 'Once touched, the player respawns here. A 2-frame sprite shows frame 2 when active.',
      props: [],
      sounds: [{ key: 'activate', label: 'Activate', default: 'synth:powerup' }],
    },
    goal: {
      label: 'Goal', size: [8, 32], color: '#e43b44',
      desc: 'Finishes the level: goes to the next level, or wins the game after the last one.',
      props: [{ key: 'requireAll', label: 'Needs every collectible first', type: 'bool', default: false }],
      sounds: [{ key: 'reach', label: 'Reached', default: 'synth:win' }],
    },
    sign: {
      label: 'Sign', size: [12, 12], color: '#a0662e',
      desc: 'Shows a message while the player is next to it. Each placed sign can have its own message.',
      props: [{ key: 'message', label: 'Message', type: 'text', default: 'Hello!' }],
      sounds: [],
    },
    decoration: {
      label: 'Decoration', size: [16, 16], color: '#8b9bb4',
      desc: 'Only for looks; nothing collides with it.',
      props: [{ key: 'front', label: 'Draw in front of the player', type: 'bool', default: false }],
      sounds: [],
    },
  };

  const uid = () => Math.random().toString(36).slice(2, 10);

  // Effective property values: behavior defaults, then the object type's values, then a placed
  // instance's own overrides.
  function propsOf(type, inst) {
    const b = BEHAVIORS[type.behavior] || BEHAVIORS.decoration, out = {};
    for (const p of b.props) out[p.key] = p.default;
    return Object.assign(out, type.props || {}, (inst && inst.props) || {});
  }

  function soundOf(type, key) {
    if (type.sounds && key in type.sounds) return type.sounds[key];
    const b = BEHAVIORS[type.behavior], def = b && b.sounds.find(s => s.key === key);
    return def ? def.default : '';
  }

  // Top-left position that sits an object of this type on the bottom-center of a grid cell.
  function snapToCell(type, col, row, ts) {
    return { x: col * ts + Math.floor((ts - type.w) / 2), y: row * ts + ts - type.h };
  }

  function makeSprite(img, def) {
    const fw = Math.min(def.frameW || img.width, img.width), fh = Math.min(def.frameH || img.height, img.height);
    const frames = E.sliceSheet(img, fw, fh);
    return {
      frames: frames.length ? frames : [{ img, sx: 0, sy: 0, w: img.width, h: img.height }],
      fps: def.fps || 8, w: fw, h: fh,
    };
  }

  // Fills in anything missing so older or hand-edited projects still load.
  function normalizeProject(p) {
    p = p || {};
    p.format = 'pixelforge';
    p.version = 1;
    p.name = p.name || 'Untitled';
    p.settings = Object.assign({}, DEFAULT_SETTINGS, p.settings || {});
    for (const k of ['sprites', 'sounds', 'tiles', 'objects', 'levels']) if (!Array.isArray(p[k])) p[k] = [];
    p.script = p.script || '';
    for (const t of p.tiles) {
      t.name = t.name || 'Tile ' + t.id;
      if (t.color == null) t.color = '#8b5a2b';
      t.frame = t.frame || 0;
    }
    for (const o of p.objects) {
      const b = BEHAVIORS[o.behavior] ? o.behavior : 'decoration';
      o.behavior = b;
      o.id = o.id || uid();
      o.name = o.name || BEHAVIORS[b].label;
      o.w = o.w || BEHAVIORS[b].size[0];
      o.h = o.h || BEHAVIORS[b].size[1];
      o.color = o.color || BEHAVIORS[b].color;
      o.props = o.props || {};
      o.sounds = o.sounds || {};
    }
    for (const l of p.levels) {
      l.id = l.id || uid();
      l.name = l.name || 'Level';
      l.cols = l.cols || 40;
      l.rows = l.rows || 12;
      if (!Array.isArray(l.tiles) || l.tiles.length !== l.cols * l.rows) {
        const t = new Array(l.cols * l.rows).fill(0);
        if (Array.isArray(l.tiles)) for (let i = 0; i < Math.min(t.length, l.tiles.length); i++) t[i] = l.tiles[i] || 0;
        l.tiles = t;
      }
      l.objects = Array.isArray(l.objects) ? l.objects : [];
      for (const o of l.objects) o.id = o.id || uid();
    }
    return p;
  }

  // ---------- Runtime context ----------
  function createRuntime(project, opts) {
    const settings = Object.assign({}, DEFAULT_SETTINGS, project.settings);
    const tiles = new Map(project.tiles.map(t => [t.id, t]));
    const types = new Map(project.objects.map(o => [o.id, o]));
    const rt = {
      project, settings, opts,
      topdown: settings.mode === 'topdown',
      gravity: settings.gravity,
      sprites: new Map(),
      hooks: {},
      sprite: id => (id && rt.sprites.get(id)) || null,
      tile: id => tiles.get(id) || null,
      objectType: id => types.get(id) || null,
      spawn(type, inst) {
        const C = CLASSES[type.behavior] || Thing;
        return new C(rt, type, inst);
      },
      hook(name, ...args) {
        const fn = rt.hooks[name];
        if (fn) fn(...args);
      },
    };
    return rt;
  }

  async function loadAssets(project, sound) {
    const sprites = new Map();
    await Promise.all(project.sprites.map(s => new Promise(resolve => {
      const img = new Image();
      img.onload = () => { sprites.set(s.id, makeSprite(img, s)); resolve(); };
      img.onerror = () => resolve();
      img.src = s.src;
    })));
    await Promise.all(project.sounds.map(a => sound.load(a.id, a.src)));
    return sprites;
  }

  const HOOKS = ['onStart', 'onLevelStart', 'onUpdate', 'onDraw', 'onCollect', 'onDeath', 'onLevelComplete'];

  // Runs the project's script and collects whichever hook functions it defines.
  function compileScript(src, game) {
    if (!src || !src.trim()) return {};
    const body = src + '\n;return {' + HOOKS.map(n => `${n}: typeof ${n} === 'function' ? ${n} : null`).join(',') + '};';
    return new Function('game', 'Engine', 'PixelForge', body)(game, E, global.PixelForge);
  }

  // ---------- Entities ----------
  // Draws an animated sprite sitting on the bottom-center of an entity's hitbox, or a colored box.
  class Look {
    constructor(sprite, color) { this.sprite = sprite; this.color = color; this.t = 0; }
    update(dt) { this.t += dt; }
    frame(i) { const s = this.sprite; return s.frames[(i == null ? Math.floor(this.t * s.fps) : i) % s.frames.length]; }
    draw(ctx, e, flip, frameIndex) {
      if (!this.sprite) {
        ctx.fillStyle = this.color || '#f0f';
        ctx.fillRect(Math.round(e.x), Math.round(e.y), e.w, e.h);
        return;
      }
      const f = this.frame(frameIndex);
      drawFrame(ctx, f, e.x + (e.w - f.w) / 2, e.y + e.h - f.h, flip);
    }
  }

  class Thing extends Entity {
    constructor(rt, type, inst) {
      super(inst.x, inst.y, type.w, type.h);
      this.rt = rt; this.type = type; this.inst = inst;
      this.p = propsOf(type, inst);
      this.look = new Look(rt.sprite(type.sprite), type.color);
      this.look.t = Math.random();
      this.tags.add(type.behavior);
      this.tags.add(type.name);
      this.flip = false;
    }
    sound(key) { this.game.sound.play(soundOf(this.type, key)); }
    update(dt) { this.look.update(dt); }
    draw(ctx) { this.look.draw(ctx, this, this.flip); }
  }

  const JUMP_KEYS = ['Space', 'ArrowUp', 'KeyW', 'KeyZ'];

  class Player extends Thing {
    constructor(rt, type, inst) {
      super(rt, type, inst);
      this.z = 10;
      this.facing = 1;
      this.coyote = 0; this.jumpBuffer = 0; this.boost = 0;
      this.invuln = 0; this.dying = 0;
      this.look.t = 0;
      const alt = id => (rt.sprite(id) ? new Look(rt.sprite(id), type.color) : this.look);
      this.looks = { idle: this.look, run: alt(this.p.runSprite), jump: alt(this.p.jumpSprite) };
    }

    update(dt) {
      if (this.dying > 0) {
        if ((this.dying -= dt) <= 0) this.scene.respawnPlayer();
        return;
      }
      const input = this.game.input, map = this.scene.map, rt = this.rt;
      const dx = (input.isDown('ArrowRight', 'KeyD') ? 1 : 0) - (input.isDown('ArrowLeft', 'KeyA') ? 1 : 0);

      if (rt.topdown) {
        const dy = (input.isDown('ArrowDown', 'KeyS') ? 1 : 0) - (input.isDown('ArrowUp', 'KeyW') ? 1 : 0);
        const len = Math.hypot(dx, dy) || 1; // diagonal movement isn't faster
        this.vx = approach(this.vx, (dx / len) * this.p.speed, 1200 * dt);
        this.vy = approach(this.vy, (dy / len) * this.p.speed, 1200 * dt);
        if (dx) this.facing = dx;
      } else {
        // Accelerate toward the target speed instead of snapping to it; less control in the air.
        if (dx) {
          this.vx = approach(this.vx, dx * this.p.speed, (this.onGround ? 1000 : 600) * dt);
          this.facing = dx;
        } else {
          this.vx = approach(this.vx, 0, (this.onGround ? 1000 : 300) * dt);
        }
        // Coyote time: you can still jump for a moment after running off a ledge.
        this.coyote = this.onGround ? 0.1 : this.coyote - dt;
        // Jump buffering: pressing jump just before landing still counts.
        this.jumpBuffer = input.wasPressed(...JUMP_KEYS) ? 0.12 : this.jumpBuffer - dt;
        if (this.jumpBuffer > 0 && this.coyote > 0) {
          this.vy = -this.p.jump;
          this.coyote = 0;
          this.jumpBuffer = 0;
          this.sound('jump');
        }
        // Variable jump height: releasing jump while rising adds extra gravity (not after springs).
        this.boost -= dt;
        if (this.vy < 0 && this.boost <= 0 && !input.isDown(...JUMP_KEYS)) this.vy += rt.gravity * 2 * dt;
        this.vy = Math.min(this.vy + rt.gravity * dt, MAX_FALL);
        this.dropThrough = input.isDown('ArrowDown', 'KeyS');
      }

      moveAndCollide(this, map, dt);

      const moving = Math.abs(this.vx) > 10 || (rt.topdown && Math.abs(this.vy) > 10);
      const next = !rt.topdown && !this.onGround ? this.looks.jump : moving ? this.looks.run : this.looks.idle;
      if (next !== this.look) { this.look = next; this.look.t = 0; }
      this.look.update(dt);
      if (this.invuln > 0) this.invuln -= dt;

      if (!rt.topdown && this.y > map.height + 32) return this.scene.hurtPlayer(true);
      // Hazard tiles hurt on touch, including one you're standing on (hence the +1 height).
      let hazard = false;
      map.tilesIn(this.x + 1, this.y + 1, this.w - 2, this.h, id => { const t = rt.tile(id); if (t && t.hazard) hazard = true; });
      if (hazard) this.scene.hurtPlayer();
    }

    draw(ctx) {
      if (this.dying > 0) return;
      if (this.invuln > 0 && Math.floor(this.invuln * 20) % 2) return;
      this.look.draw(ctx, this, this.facing < 0);
    }
  }

  class Enemy extends Thing {
    constructor(rt, type, inst) {
      super(rt, type, inst);
      const dir = this.p.direction, s = this.p.speed;
      if (dir === 'horizontal') this.vx = -s;
      else if (dir === 'vertical') this.vy = -s;
      this.usesGravity = !rt.topdown && this.p.gravity && dir !== 'vertical';
    }
    update(dt) {
      const map = this.scene.map, ts = map.tileSize, p = this.p;
      if (p.direction === 'chase') {
        const pl = this.scene.player;
        const near = pl && pl.dying <= 0 && Math.hypot(pl.cx - this.cx, pl.cy - this.cy) < 160;
        this.vx = near ? Math.sign(Math.round(pl.cx - this.cx)) * p.speed : 0;
        if (!this.usesGravity) this.vy = near ? Math.sign(Math.round(pl.cy - this.cy)) * p.speed : 0;
      }
      const svx = this.vx, svy = this.vy; // collisions zero velocity, so remember the direction
      if (this.usesGravity) this.vy = Math.min(this.vy + this.rt.gravity * dt, MAX_FALL);
      moveAndCollide(this, map, dt);
      if (p.direction === 'horizontal') {
        if (this.hitWall) this.vx = -svx;
        else if (this.usesGravity && this.onGround && p.turnAtEdges) {
          const aheadX = svx > 0 ? this.right + 1 : this.x - 1;
          const below = Math.floor((this.bottom + 1) / ts), col = Math.floor(aheadX / ts);
          const t = this.rt.tile(map.get(col, below));
          if ((!map.isSolid(col, below) && !map.isOneWay(col, below)) || (t && t.hazard)) this.vx = -svx;
        }
      } else if (p.direction === 'vertical') {
        if (this.hitCeiling || this.onGround) this.vy = -svy;
      }
      if (this.vx) this.flip = this.vx < 0;
      this.look.update(dt);
    }
  }

  class Checkpoint extends Thing {
    draw(ctx) {
      const two = this.look.sprite && this.look.sprite.frames.length >= 2;
      if (two) return this.look.draw(ctx, this, false, this.active ? 1 : 0);
      ctx.globalAlpha = this.active ? 1 : 0.5;
      this.look.draw(ctx, this, false);
      ctx.globalAlpha = 1;
    }
  }

  class Spring extends Thing {
    update(dt) { super.update(dt); this.squash = Math.max(0, (this.squash || 0) - dt); }
    draw(ctx) {
      if (this.squash > 0) { ctx.save(); ctx.translate(0, 2); this.look.draw(ctx, this, false); ctx.restore(); }
      else this.look.draw(ctx, this, false);
    }
  }

  class Decoration extends Thing {
    constructor(rt, type, inst) { super(rt, type, inst); this.z = this.p.front ? 20 : -5; }
  }

  class Particle extends Entity {
    constructor(x, y, color, gravity) {
      super(x, y, 2, 2);
      this.vx = rand(-60, 60);
      this.vy = rand(-120, -30);
      this.life = rand(0.3, 0.6);
      this.color = color;
      this.gravity = gravity;
      this.z = 30;
    }
    update(dt) {
      this.vy += this.gravity * 0.5 * dt;
      this.x += this.vx * dt;
      this.y += this.vy * dt;
      if ((this.life -= dt) <= 0) this.destroy();
    }
  }

  const CLASSES = { player: Player, enemy: Enemy, checkpoint: Checkpoint, spring: Spring, decoration: Decoration };

  const HEART = E.pixelArt(['.rr.rr.', 'rrrrrrr', 'rrrrrrr', '.rrrrr.', '..rrr..', '...r...'], { r: '#e43b44' });

  // ---------- Scenes ----------
  class LevelScene extends Scene {
    constructor(game, rt, index, spawn) {
      super(game);
      this.rt = rt;
      this.index = index;
      const level = this.level = rt.project.levels[index];
      this.map = new Tilemap({
        cols: level.cols, rows: level.rows, tileSize: rt.settings.tileSize, data: level.tiles,
        props: id => rt.tile(id),
        walls: rt.topdown ? { left: true, right: true, top: true, bottom: true } : { left: true, right: true, top: false, bottom: false },
      });
      this.score = 0;
      this.total = 0;
      this.banner = 2;
      this.message = null;
      this.finished = false;
      this.paused = false;

      for (const inst of level.objects) {
        const type = rt.objectType(inst.type);
        if (!type) continue;
        if (type.behavior === 'player' && this.player) continue; // only the first player counts
        const e = this.add(rt.spawn(type, inst));
        if (type.behavior === 'player') this.player = e;
        if (type.behavior === 'collectible') this.total++;
      }
      if (this.player && spawn) { this.player.x = spawn.x; this.player.y = spawn.y; }
      this.respawn = this.player && { x: this.player.x, y: this.player.y };
      if (this.player) this.camera.follow(this.player, 6);
      this.camera.setBounds(0, 0, this.map.width, this.map.height);
      this.camera.snap();
      this.bgSprite = rt.sprite(level.bgSprite);
    }

    enter() {
      this.game.sound.playMusic(this.level.music || '');
      this.rt.hook('onLevelStart', this);
    }

    burst(x, y, color, n) { for (let i = 0; i < n; i++) this.add(new Particle(x, y, color, this.rt.topdown ? 0 : this.rt.gravity)); }

    update(dt) {
      const game = this.game, rt = this.rt;
      if (game.input.wasPressed('KeyP') || (!rt.opts.editor && game.input.wasPressed('Escape'))) this.paused = !this.paused;
      if (this.paused) return;
      super.update(dt);
      this.banner -= dt;
      rt.hook('onUpdate', this, dt);

      const p = this.player;
      if (!p || p.dying > 0 || this.finished) return;
      this.message = null;
      for (const e of this.entities) {
        if (e.dead || e === p || !(e instanceof Thing)) continue;
        const b = e.type.behavior;
        const touching = b === 'sign' ? overlaps({ x: e.x - 6, y: e.y - 6, w: e.w + 12, h: e.h + 12 }, p) : p.overlaps(e);
        if (!touching) continue;

        if (b === 'collectible') {
          e.destroy();
          this.score += Number(e.p.value) || 0;
          game.state.score += Number(e.p.value) || 0;
          if (e.p.heal && rt.settings.lives > 0) game.state.lives++;
          this.burst(e.cx, e.cy, e.type.color || '#ffd23f', 6);
          e.sound('collect');
          rt.hook('onCollect', this, e);
        } else if (b === 'enemy') {
          if (p.invuln > 0) continue;
          if (!rt.topdown && e.p.stompable && p.vy > 0 && p.bottom - e.y < 8) {
            // Falling onto the top of an enemy defeats it.
            e.destroy();
            p.vy = -220;
            this.burst(e.cx, e.cy, e.type.color || '#38b764', 10);
            this.camera.shake(2, 0.1);
            e.sound('defeat');
          } else {
            this.hurtPlayer();
          }
        } else if (b === 'hazard') {
          this.hurtPlayer();
        } else if (b === 'spring') {
          if (!rt.topdown && p.vy >= 0) {
            p.vy = -e.p.power;
            p.boost = 0.4;
            e.squash = 0.15;
            e.sound('bounce');
          }
        } else if (b === 'checkpoint') {
          if (!e.active) {
            for (const c of this.all('checkpoint')) c.active = false;
            e.active = true;
            this.respawn = { x: e.x + (e.w - p.w) / 2, y: e.bottom - p.h };
            this.burst(e.cx, e.y, '#38b764', 8);
            e.sound('activate');
          }
        } else if (b === 'goal') {
          if (e.p.requireAll && this.all('collectible').length) this.message = 'Collect everything first!';
          else this.finish(e);
        } else if (b === 'sign') {
          this.message = String(e.p.message || '');
        }
        if (this.finished || p.dying > 0) return;
      }
    }

    hurtPlayer(fell = false) {
      const p = this.player, st = this.game.state;
      if (!p || this.finished || p.dying > 0) return;
      if (!fell && p.invuln > 0) return;
      p.sound('hurt');
      this.burst(p.cx, p.cy, '#e43b44', 14);
      this.camera.shake(4, 0.3);
      if (this.rt.settings.lives > 0) st.lives--;
      p.dying = 0.8;
      this.rt.hook('onDeath', this);
    }

    respawnPlayer() {
      const p = this.player, st = this.game.state;
      if (this.rt.settings.lives > 0 && st.lives <= 0) {
        this.game.go(new EndScene(this.game, this.rt, 'lose'));
        return;
      }
      p.x = this.respawn.x; p.y = this.respawn.y;
      p.vx = 0; p.vy = 0;
      p.invuln = 1.5;
      this.camera.snap();
    }

    finish(goal) {
      this.finished = true;
      goal.sound('reach');
      this.rt.hook('onLevelComplete', this);
      this.after(1.5, () => {
        const next = this.index + 1;
        if (this.rt.opts.singleLevel) this.game.go(new EndScene(this.game, this.rt, 'level'));
        else if (next >= this.rt.project.levels.length) this.game.go(new EndScene(this.game, this.rt, 'win'));
        else this.game.go(new LevelScene(this.game, this.rt, next));
      });
    }

    drawBackground(ctx) {
      const { width: W, height: H } = this.game;
      ctx.fillStyle = this.level.background || this.rt.settings.background;
      ctx.fillRect(0, 0, W, H);
      const s = this.bgSprite;
      if (s) {
        // Background image with parallax: it scrolls slower than the level. Images at least as tall
        // as the screen repeat sideways only (like scenery); smaller ones tile like a pattern.
        const f = s.frames[0];
        const ox = -Math.round(this.camera.x * 0.3) % f.w;
        let y0, y1;
        if (f.h >= H) { y0 = Math.max(H - f.h, Math.min(0, -Math.round(this.camera.y * 0.3))); y1 = y0 + 1; }
        else { y0 = -Math.round(this.camera.y * 0.3) % f.h; y1 = H; }
        for (let y = y0; y < y1; y += f.h)
          for (let x = ox; x < W; x += f.w) drawFrame(ctx, f, x, y);
      }
    }

    drawWorld(ctx) {
      const ts = this.map.tileSize, rt = this.rt;
      this.map.draw(ctx, this.camera, (ctx, id, x, y) => {
        const t = rt.tile(id);
        if (!t) return;
        const s = rt.sprite(t.sprite);
        if (s) {
          const i = t.animate ? Math.floor(this.time * s.fps) : t.frame || 0;
          const f = s.frames[i % s.frames.length];
          ctx.drawImage(f.img, f.sx, f.sy, f.w, f.h, x, y, ts, ts);
        } else {
          ctx.fillStyle = t.color || '#888';
          ctx.fillRect(x, y, ts, ts);
        }
      });
    }

    drawUI(ctx) {
      const { width: W, height: H } = this.game, st = this.game.state;
      if (this.rt.settings.lives > 0) for (let i = 0; i < st.lives; i++) drawFrame(ctx, HEART, 6 + i * 9, 6);
      if (this.total > 0) text(ctx, `${this.total - this.all('collectible').length}/${this.total}`, W - 6, 5, { align: 'right', color: '#ffd23f' });
      else text(ctx, `SCORE ${st.score}`, W - 6, 5, { align: 'right' });

      if (this.banner > 0) {
        ctx.globalAlpha = Math.min(1, this.banner);
        text(ctx, this.level.name, W / 2, 24, { size: 10, align: 'center' });
        ctx.globalAlpha = 1;
      }
      if (this.message) {
        ctx.font = 'bold 7px monospace';
        const w = Math.min(W - 16, ctx.measureText(this.message).width + 12);
        ctx.fillStyle = 'rgba(10,10,20,0.85)';
        ctx.fillRect((W - w) / 2, H - 26, w, 16);
        text(ctx, this.message, W / 2, H - 22, { size: 7, align: 'center', shadow: null });
      }
      if (this.finished) text(ctx, 'LEVEL CLEAR!', W / 2, H / 2 - 10, { size: 14, align: 'center', color: '#ffd23f' });
      if (!this.player) text(ctx, 'No player in this level - place one in the editor', W / 2, H / 2, { size: 7, align: 'center', color: '#ff8080' });
      if (this.paused) {
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.fillRect(0, 0, W, H);
        text(ctx, 'PAUSED', W / 2, H / 2 - 6, { size: 12, align: 'center' });
      }
      this.rt.hook('onDraw', this, ctx);
    }
  }

  const START_KEYS = ['Enter', 'NumpadEnter', 'Space'];

  class TitleScene extends Scene {
    constructor(game, rt) {
      super(game);
      this.rt = rt;
      const hero = rt.project.objects.find(o => o.behavior === 'player');
      this.hero = hero && rt.sprite(hero.sprite);
      resetState(game, rt);
    }
    update(dt) {
      super.update(dt);
      const input = this.game.input;
      if (input.wasPressed(...START_KEYS) || input.mouse.pressed) {
        this.game.sound.play('synth:select');
        this.game.go(new LevelScene(this.game, this.rt, 0));
      }
    }
    drawUI(ctx) {
      const { width: W, height: H } = this.game;
      text(ctx, this.rt.settings.title || this.rt.project.name, W / 2, H * 0.22, { size: 20, align: 'center', color: '#ffd23f', shadow: '#e43b44' });
      if (this.hero) {
        const bob = Math.round(Math.abs(Math.sin(this.time * 3)) * -8), f = this.hero.frames[0];
        drawFrame(ctx, f, W / 2 - f.w / 2, H * 0.55 - f.h + bob);
      }
      if (Math.floor(this.time * 2) % 2 === 0) text(ctx, 'PRESS ENTER', W / 2, H * 0.68, { align: 'center' });
      const help = this.rt.topdown ? 'arrows/WASD move   P pause' : 'arrows/WASD move   space jump   P pause';
      text(ctx, help, W / 2, H - 16, { size: 6, align: 'center', color: '#8b9bb4' });
    }
  }

  class EndScene extends Scene {
    // kind: 'win' (finished the game), 'lose' (out of lives) or 'level' (editor single-level test).
    constructor(game, rt, kind) { super(game); this.rt = rt; this.kind = kind; }
    update(dt) {
      super.update(dt);
      // Short delay so a held jump key doesn't skip this screen instantly.
      if (this.time > 0.5 && this.game.input.wasPressed(...START_KEYS)) {
        if (this.rt.opts.singleLevel || !this.rt.settings.showTitle) {
          resetState(this.game, this.rt);
          this.game.go(new LevelScene(this.game, this.rt, this.rt.opts.singleLevel ? this.rt.opts.startLevel || 0 : 0));
        } else {
          this.game.go(new TitleScene(this.game, this.rt));
        }
      }
    }
    drawUI(ctx) {
      const W = this.game.width, H = this.game.height;
      const title = { win: 'YOU WIN!', lose: 'GAME OVER', level: 'LEVEL COMPLETE' }[this.kind];
      text(ctx, title, W / 2, H * 0.28, { size: 18, align: 'center', color: this.kind === 'lose' ? '#e43b44' : '#ffd23f' });
      text(ctx, `score ${this.game.state.score}`, W / 2, H * 0.5, { align: 'center' });
      if (this.time > 0.5) text(ctx, 'press enter', W / 2, H * 0.66, { align: 'center', color: '#8b9bb4' });
    }
  }

  function resetState(game, rt) { game.state = { lives: rt.settings.lives > 0 ? rt.settings.lives : Infinity, score: 0 }; }

  // ---------- Entry point ----------
  // Creates and starts a game from a project. Resolves to the Game; call game.destroy() to shut it down.
  // opts: { startLevel, singleLevel, spawn: {x, y}, showTitle, editor, scale, onError }
  async function play(project, canvas, opts = {}) {
    project = normalizeProject(project);
    if (!project.levels.length) throw new Error('This project has no levels yet.');
    const s = Object.assign({}, DEFAULT_SETTINGS, project.settings);
    const game = new Game({ canvas, width: s.width, height: s.height, scale: opts.scale || s.scale || 3, background: s.background });
    game.onError = opts.onError || null;
    const rt = createRuntime(project, opts);
    game.rt = rt;
    rt.sprites = await loadAssets(project, game.sound);
    try {
      rt.hooks = compileScript(project.script, game);
      resetState(game, rt);
      rt.hook('onStart', game);
    } catch (err) {
      if (opts.onError) opts.onError(err); else throw err;
    }
    const showTitle = opts.showTitle != null ? opts.showTitle : s.showTitle;
    const start = Math.min(opts.startLevel || 0, project.levels.length - 1);
    game.start(showTitle ? new TitleScene(game, rt) : new LevelScene(game, rt, start, opts.spawn));
    return game;
  }

  global.PixelForge = {
    BEHAVIORS, DEFAULT_SETTINGS, HOOKS,
    play, normalizeProject, propsOf, soundOf, snapToCell, makeSprite, compileScript, uid,
    LevelScene, TitleScene, EndScene, Thing,
  };
})(window);
