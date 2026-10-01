// PixelForge engine core: game loop, input, scenes, entities, camera, tilemap collision, sprites, sound.
// Everything is exposed on the global `Engine` object so it works from plain <script> tags.
(function (global) {
  'use strict';

  // ---------- Math helpers ----------
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  // Move v toward target by at most delta (never overshoots).
  const approach = (v, target, delta) => (v < target ? Math.min(v + delta, target) : Math.max(v - delta, target));
  const rand = (lo, hi) => lo + Math.random() * (hi - lo);
  // Axis-aligned bounding box test. Works on anything with x, y, w, h.
  const overlaps = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

  // True when a key event comes from a text field, so games don't steal typing.
  const isTyping = e => {
    const t = e.target;
    return !!(t && t.closest && t.closest('input, textarea, select, [contenteditable]'));
  };

  // ---------- Input ----------
  class Input {
    constructor(game) {
      this.down = new Set();     // keys currently held
      this.pressed = new Set();  // keys that went down since the last update step
      this.mouse = { x: 0, y: 0, down: false, pressed: false };
      this._handlers = [];
      const on = (target, type, fn) => { target.addEventListener(type, fn); this._handlers.push([target, type, fn]); };

      const noScroll = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
      on(global, 'keydown', e => {
        if (isTyping(e)) return;
        if (noScroll.has(e.code)) e.preventDefault();
        if (!this.down.has(e.code)) this.pressed.add(e.code); // ignore OS key-repeat
        this.down.add(e.code);
      });
      on(global, 'keyup', e => this.down.delete(e.code));
      on(global, 'blur', () => this.down.clear());

      // Mouse position is converted to game (logical) coordinates.
      const c = game.canvas;
      const toLocal = e => {
        const r = c.getBoundingClientRect();
        this.mouse.x = ((e.clientX - r.left) / r.width) * game.width;
        this.mouse.y = ((e.clientY - r.top) / r.height) * game.height;
      };
      on(c, 'mousemove', toLocal);
      on(c, 'mousedown', e => { toLocal(e); this.mouse.down = true; this.mouse.pressed = true; });
      on(global, 'mouseup', () => { this.mouse.down = false; });
    }
    isDown(...codes) { return codes.some(c => this.down.has(c)); }
    wasPressed(...codes) { return codes.some(c => this.pressed.has(c)); }
    // Called after every update step, so each press is seen by exactly one step.
    endStep() { this.pressed.clear(); this.mouse.pressed = false; }
    destroy() { for (const [t, type, fn] of this._handlers) t.removeEventListener(type, fn); this._handlers = []; }
  }

  // ---------- Sound ----------
  // Built-in synthesized effects, usable anywhere a sound name is expected as 'synth:<name>'.
  const SYNTHS = {
    jump: [{ freq: 280, to: 560, dur: 0.12, vol: 0.12 }],
    coin: [{ freq: 990, to: 1480, dur: 0.08, vol: 0.12 }],
    stomp: [{ freq: 160, to: 60, dur: 0.15, vol: 0.2 }],
    hurt: [{ freq: 220, to: 55, dur: 0.4, type: 'sawtooth', vol: 0.2 }],
    win: [523, 659, 784, 1047].map((f, i) => ({ freq: f, dur: 0.15, delay: i * 0.1, type: 'triangle', vol: 0.3 })),
    powerup: [392, 523, 659, 784].map((f, i) => ({ freq: f, dur: 0.08, delay: i * 0.06, vol: 0.12 })),
    bounce: [{ freq: 200, to: 900, dur: 0.18, type: 'triangle', vol: 0.25 }],
    blip: [{ freq: 660, dur: 0.05, vol: 0.1 }],
    select: [{ freq: 440, to: 880, dur: 0.15, vol: 0.15 }],
    explode: [{ freq: 120, to: 30, dur: 0.5, type: 'sawtooth', vol: 0.25 }],
  };

  function dataUrlToArrayBuffer(url) {
    const bin = atob(url.slice(url.indexOf(',') + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }

  class Sound {
    constructor() {
      this.ctx = null; this.volume = 0.5; this.muted = false;
      this.buffers = new Map(); this.music = null; this.musicId = null;
    }
    _ac(resume = true) {
      if (!this.ctx) {
        const AC = global.AudioContext || global.webkitAudioContext;
        if (!AC) return null;
        this.ctx = new AC();
      }
      if (resume && this.ctx.state === 'suspended') this.ctx.resume(); // browsers start audio suspended
      return this.ctx;
    }
    // One blip whose pitch slides from `freq` to `to` over `dur` seconds.
    tone({ freq = 440, to = freq, dur = 0.1, type = 'square', vol = 0.2, delay = 0 } = {}) {
      if (this.muted) return;
      const ac = this._ac();
      if (!ac) return;
      const t = ac.currentTime + delay;
      const osc = ac.createOscillator(), gain = ac.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t);
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), t + dur);
      gain.gain.setValueAtTime(vol * this.volume, t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(gain).connect(ac.destination);
      osc.start(t);
      osc.stop(t + dur + 0.02);
    }
    // Decode an audio file (data URL or ArrayBuffer) so it can be played instantly later.
    async load(id, src) {
      const ac = this._ac(false);
      if (!ac) return;
      try {
        const buf = typeof src === 'string' ? dataUrlToArrayBuffer(src) : src;
        this.buffers.set(id, await ac.decodeAudioData(buf));
      } catch (err) {
        console.warn('Could not decode sound', id, err);
      }
    }
    // name is 'synth:<name>', the id of a loaded sound, or '' for silence.
    play(name, vol = 1) {
      if (!name || this.muted) return null;
      if (name.startsWith('synth:')) {
        const s = SYNTHS[name.slice(6)];
        if (s) s.forEach(t => this.tone(t));
        return null;
      }
      const buf = this.buffers.get(name);
      const ac = buf && this._ac();
      if (!ac) return null;
      const src = ac.createBufferSource(), gain = ac.createGain();
      src.buffer = buf;
      gain.gain.value = vol * this.volume;
      src.connect(gain).connect(ac.destination);
      src.start();
      return src;
    }
    playMusic(id, vol = 0.6) {
      if (this.musicId === id) return;
      this.stopMusic();
      const buf = id && this.buffers.get(id);
      const ac = buf && this._ac();
      if (!ac) return;
      const src = ac.createBufferSource(), gain = ac.createGain();
      src.buffer = buf;
      src.loop = true;
      gain.gain.value = vol * this.volume;
      src.connect(gain).connect(ac.destination);
      src.start();
      this.music = src;
      this.musicId = id;
    }
    stopMusic() {
      if (this.music) { try { this.music.stop(); } catch (e) { /* already stopped */ } }
      this.music = null;
      this.musicId = null;
    }
    close() {
      this.stopMusic();
      if (this.ctx) this.ctx.close();
      this.ctx = null;
    }
  }

  // ---------- Sprites ----------
  // A frame is a rectangle of an image: { img, sx, sy, w, h }.
  function sliceSheet(img, fw, fh) {
    const frames = [];
    for (let y = 0; y + fh <= img.height; y += fh)
      for (let x = 0; x + fw <= img.width; x += fw) frames.push({ img, sx: x, sy: y, w: fw, h: fh });
    return frames;
  }

  // Build a frame from ASCII pixel art. Characters not in `palette` (like '.') are transparent.
  function pixelArt(rows, palette) {
    const w = Math.max(...rows.map(r => r.length)), h = rows.length;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    rows.forEach((row, y) => [...row].forEach((ch, x) => {
      if (palette[ch]) { ctx.fillStyle = palette[ch]; ctx.fillRect(x, y, 1, 1); }
    }));
    return { img: c, sx: 0, sy: 0, w, h };
  }

  function drawFrame(ctx, f, x, y, flipX = false) {
    x = Math.round(x); y = Math.round(y);
    if (flipX) {
      ctx.save();
      ctx.translate(x + f.w, y);
      ctx.scale(-1, 1);
      ctx.drawImage(f.img, f.sx, f.sy, f.w, f.h, 0, 0, f.w, f.h);
      ctx.restore();
    } else {
      ctx.drawImage(f.img, f.sx, f.sy, f.w, f.h, x, y, f.w, f.h);
    }
  }

  class Animation {
    constructor(frames, fps = 8, loop = true) { this.frames = frames; this.fps = fps; this.loop = loop; this.t = 0; }
    reset() { this.t = 0; return this; }
    update(dt) { this.t += dt; }
    get frame() {
      const i = Math.floor(this.t * this.fps);
      return this.frames[this.loop ? i % this.frames.length : Math.min(i, this.frames.length - 1)];
    }
    get done() { return !this.loop && this.t * this.fps >= this.frames.length; }
  }

  function text(ctx, str, x, y, { size = 8, color = '#fff', align = 'left', shadow = '#000' } = {}) {
    ctx.font = `bold ${size}px monospace`;
    ctx.textAlign = align;
    ctx.textBaseline = 'top';
    if (shadow) { ctx.fillStyle = shadow; ctx.fillText(str, x + 1, y + 1); }
    ctx.fillStyle = color;
    ctx.fillText(str, x, y);
  }

  // ---------- Entity ----------
  class Entity {
    constructor(x = 0, y = 0, w = 16, h = 16) {
      this.x = x; this.y = y; this.w = w; this.h = h;
      this.vx = 0; this.vy = 0;
      this.z = 0;            // draw order: higher draws on top
      this.dead = false;     // removed from the scene at the end of the step
      this.scene = null;
      this.color = '#f0f';
      this.tags = new Set();
    }
    get game() { return this.scene && this.scene.game; }
    get cx() { return this.x + this.w / 2; }
    get cy() { return this.y + this.h / 2; }
    get right() { return this.x + this.w; }
    get bottom() { return this.y + this.h; }
    overlaps(o) { return overlaps(this, o); }
    destroy() { this.dead = true; }
    update(dt) {}
    draw(ctx) {
      ctx.fillStyle = this.color;
      ctx.fillRect(Math.round(this.x), Math.round(this.y), this.w, this.h);
    }
  }

  // ---------- Camera ----------
  class Camera {
    constructor(w, h) {
      this.x = 0; this.y = 0; this.w = w; this.h = h;
      this.target = null; this.smooth = 8; this.bounds = null;
      this._shake = 0; this._shakeMag = 0;
    }
    follow(entity, smooth = 8) { this.target = entity; this.smooth = smooth; return this; }
    setBounds(x, y, w, h) { this.bounds = { x, y, w, h }; return this; }
    shake(mag = 3, time = 0.2) { this._shakeMag = mag; this._shake = time; }
    _goal() { return { x: this.target.cx - this.w / 2, y: this.target.cy - this.h / 2 }; }
    snap() {
      if (this.target) { const g = this._goal(); this.x = g.x; this.y = g.y; }
      this._clamp();
    }
    update(dt) {
      if (this.target) {
        // Frame-rate independent smoothing: covers the same fraction of the gap per second.
        const g = this._goal(), k = 1 - Math.exp(-this.smooth * dt);
        this.x += (g.x - this.x) * k;
        this.y += (g.y - this.y) * k;
      }
      this._clamp();
      if (this._shake > 0) this._shake -= dt;
    }
    _clamp() {
      const b = this.bounds;
      if (!b) return;
      this.x = b.w <= this.w ? b.x + (b.w - this.w) / 2 : clamp(this.x, b.x, b.x + b.w - this.w);
      this.y = b.h <= this.h ? b.y + (b.h - this.h) / 2 : clamp(this.y, b.y, b.y + b.h - this.h);
    }
    apply(ctx) {
      let ox = 0, oy = 0;
      if (this._shake > 0) { ox = rand(-1, 1) * this._shakeMag; oy = rand(-1, 1) * this._shakeMag; }
      ctx.translate(-Math.round(this.x + ox), -Math.round(this.y + oy));
    }
  }

  // ---------- Tilemap ----------
  class Tilemap {
    // data: flat row-major array of tile ids (0 = empty).
    // props(id) returns { solid, oneWay, hazard } for a tile id, or null.
    // walls: which outside edges of the map behave like solid walls.
    constructor({ cols, rows, tileSize = 16, data = null, props = id => (id ? { solid: true } : null),
                  walls = { left: true, right: true, top: false, bottom: false } }) {
      this.cols = cols; this.rows = rows; this.tileSize = tileSize;
      this.props = props; this.walls = walls;
      this.data = data ? Array.from(data) : new Array(cols * rows).fill(0);
    }
    get width() { return this.cols * this.tileSize; }
    get height() { return this.rows * this.tileSize; }
    inBounds(c, r) { return c >= 0 && r >= 0 && c < this.cols && r < this.rows; }
    get(c, r) { return this.inBounds(c, r) ? this.data[r * this.cols + c] : 0; }
    set(c, r, id) { if (this.inBounds(c, r)) this.data[r * this.cols + c] = id; }
    _outsideIsWall(c, r) {
      if (c < 0) return this.walls.left;
      if (c >= this.cols) return this.walls.right;
      if (r < 0) return this.walls.top;
      return this.walls.bottom;
    }
    isSolid(c, r) {
      if (!this.inBounds(c, r)) return this._outsideIsWall(c, r);
      const p = this.props(this.get(c, r));
      return !!(p && p.solid && !p.oneWay);
    }
    // One-way platforms only block things falling onto them from above.
    isOneWay(c, r) {
      const p = this.inBounds(c, r) && this.props(this.get(c, r));
      return !!(p && p.oneWay);
    }
    // Calls fn(id, col, row) for every non-empty tile overlapping the rectangle.
    tilesIn(x, y, w, h, fn) {
      const ts = this.tileSize;
      const c0 = Math.floor(x / ts), c1 = Math.floor((x + w - 0.001) / ts);
      const r0 = Math.floor(y / ts), r1 = Math.floor((y + h - 0.001) / ts);
      for (let r = r0; r <= r1; r++)
        for (let c = c0; c <= c1; c++) {
          const id = this.get(c, r);
          if (id) fn(id, c, r);
        }
    }
    // Draws only the tiles the camera can see; drawTile(ctx, id, x, y, col, row) paints each one.
    draw(ctx, camera, drawTile) {
      const ts = this.tileSize;
      const c0 = Math.max(0, Math.floor(camera.x / ts) - 1), c1 = Math.min(this.cols - 1, Math.floor((camera.x + camera.w) / ts) + 1);
      const r0 = Math.max(0, Math.floor(camera.y / ts) - 1), r1 = Math.min(this.rows - 1, Math.floor((camera.y + camera.h) / ts) + 1);
      for (let r = r0; r <= r1; r++)
        for (let c = c0; c <= c1; c++) {
          const id = this.data[r * this.cols + c];
          if (id) drawTile(ctx, id, c * ts, r * ts, c, r);
        }
    }
  }

  // Moves an entity by its velocity one axis at a time, stopping it against solid tiles.
  // Sets e.onGround, e.hitCeiling and e.hitWall (-1 left, 1 right, 0 none).
  // Set e.dropThrough = true to fall through one-way platforms.
  // Assumes an entity moves less than one tile per step (true for sane speeds at 60 steps/sec).
  function moveAndCollide(e, map, dt) {
    const ts = map.tileSize, eps = 0.001;
    e.onGround = false; e.hitCeiling = false; e.hitWall = 0;

    e.x += e.vx * dt;
    const r0 = Math.floor(e.y / ts), r1 = Math.floor((e.y + e.h - eps) / ts);
    if (e.vx > 0) {
      const c = Math.floor((e.x + e.w - eps) / ts);
      for (let r = r0; r <= r1; r++) if (map.isSolid(c, r)) { e.x = c * ts - e.w; e.vx = 0; e.hitWall = 1; break; }
    } else if (e.vx < 0) {
      const c = Math.floor(e.x / ts);
      for (let r = r0; r <= r1; r++) if (map.isSolid(c, r)) { e.x = (c + 1) * ts; e.vx = 0; e.hitWall = -1; break; }
    }

    const prevBottom = e.y + e.h;
    e.y += e.vy * dt;
    const c0 = Math.floor(e.x / ts), c1 = Math.floor((e.x + e.w - eps) / ts);
    if (e.vy > 0) {
      const r = Math.floor((e.y + e.h - eps) / ts);
      for (let c = c0; c <= c1; c++) {
        const oneWay = !e.dropThrough && map.isOneWay(c, r) && prevBottom <= r * ts + eps;
        if (map.isSolid(c, r) || oneWay) { e.y = r * ts - e.h; e.vy = 0; e.onGround = true; break; }
      }
    } else if (e.vy < 0) {
      const r = Math.floor(e.y / ts);
      for (let c = c0; c <= c1; c++) if (map.isSolid(c, r)) { e.y = (r + 1) * ts; e.vy = 0; e.hitCeiling = true; break; }
    }
  }

  // ---------- Scene ----------
  class Scene {
    constructor(game) {
      this.game = game;
      this.entities = [];
      this.camera = new Camera(game.width, game.height);
      this.timers = [];
      this.time = 0;
    }
    add(e) { e.scene = this; this.entities.push(e); if (e.added) e.added(); return e; }
    all(tag) { return this.entities.filter(e => !e.dead && e.tags.has(tag)); }
    first(tag) { return this.entities.find(e => !e.dead && e.tags.has(tag)); }
    after(seconds, fn) { this.timers.push({ t: seconds, fn }); }

    enter() {}  // called when the scene becomes active
    exit() {}   // called when another scene replaces it

    update(dt) {
      this.time += dt;
      for (const e of this.entities) if (!e.dead) e.update(dt);
      this.entities = this.entities.filter(e => !e.dead);
      for (const t of this.timers) if ((t.t -= dt) <= 0) t.fn();
      this.timers = this.timers.filter(t => t.t > 0);
      this.camera.update(dt);
    }

    // Override these three. Background and UI are in screen space, world is in camera space.
    drawBackground(ctx) {}
    drawWorld(ctx) {}
    drawUI(ctx) {}

    draw(ctx) {
      this.drawBackground(ctx);
      ctx.save();
      this.camera.apply(ctx);
      this.drawWorld(ctx);
      const sorted = this.entities.slice().sort((a, b) => a.z - b.z);
      for (const e of sorted) e.draw(ctx);
      if (this.game.debug) {
        ctx.strokeStyle = '#0f0';
        ctx.lineWidth = 0.5;
        for (const e of sorted) ctx.strokeRect(e.x, e.y, e.w, e.h);
      }
      ctx.restore();
      this.drawUI(ctx);
      if (this.game.debug)
        text(ctx, `${Math.round(this.game.fps)} fps  ${this.entities.length} entities`, this.game.width - 4, this.game.height - 12, { align: 'right', color: '#0f0' });
    }
  }

  // ---------- Game ----------
  class Game {
    // width/height are the logical resolution; the canvas is `scale` times bigger for crisp pixels.
    constructor({ canvas, width = 320, height = 180, scale = 3, fps = 60, background = '#000' }) {
      this.canvas = canvas;
      this.width = width; this.height = height; this.scale = scale;
      canvas.width = width * scale;
      canvas.height = height * scale;
      this.ctx = canvas.getContext('2d');
      this.step = 1 / fps;
      this.background = background;
      this.input = new Input(this);
      this.sound = new Sound();
      this.scene = null;
      this._next = null;
      this.state = {};       // data that survives scene changes (lives, score, ...)
      this.debug = false;
      this.fps = 60;
      this.running = false;
      this.onError = null;   // set to a function to receive errors instead of throwing
    }

    // Scene changes are deferred to the start of the next step so nothing switches mid-update.
    go(scene) { this._next = scene; }
    _swap() {
      if (!this._next) return;
      if (this.scene) this.scene.exit();
      this.scene = this._next;
      this._next = null;
      this.scene.enter();
    }

    // Fixed-timestep loop: rendering happens once per display frame, but updates always use the
    // same dt, so physics behaves the same at 30, 60 or 144 Hz.
    start(scene) {
      if (scene) this.go(scene);
      this.running = true;
      let last = performance.now(), acc = 0;
      const frame = now => {
        if (!this.running) return;
        try {
          const dt = Math.min((now - last) / 1000, 0.25); // cap so a backgrounded tab doesn't catch up for ages
          last = now;
          acc += dt;
          if (dt > 0) this.fps = lerp(this.fps, 1 / dt, 0.05);
          while (acc >= this.step) {
            this._swap();
            if (this.input.wasPressed('Backquote')) this.debug = !this.debug;
            if (this.scene) this.scene.update(this.step);
            this.input.endStep();
            acc -= this.step;
          }
          this._swap();
          this.render();
        } catch (err) {
          this.running = false;
          if (this.onError) { this.onError(err); return; }
          throw err;
        }
        this._raf = requestAnimationFrame(frame);
      };
      this._raf = requestAnimationFrame(frame);
    }

    stop() { this.running = false; cancelAnimationFrame(this._raf); }
    destroy() { this.stop(); this.input.destroy(); this.sound.close(); }

    render() {
      const ctx = this.ctx;
      ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.fillStyle = this.background;
      ctx.fillRect(0, 0, this.width, this.height);
      if (this.scene) this.scene.draw(ctx);
    }
  }

  global.Engine = {
    Game, Scene, Entity, Camera, Tilemap, Input, Sound, Animation, SYNTHS,
    moveAndCollide, pixelArt, sliceSheet, drawFrame, text, dataUrlToArrayBuffer,
    clamp, lerp, approach, rand, overlaps,
  };
})(window);
