// Starter projects: a ready-to-play platformer, a top-down adventure, and blank projects.
// All art is drawn here in code, so new projects work without any image files.
(function (global) {
  'use strict';
  const PF = global.PixelForge;

  // Draws n frames of fw x fh side by side. Returns the sprite fields { src, frameW, frameH }.
  function sheet(fw, fh, n, draw) {
    const c = document.createElement('canvas');
    c.width = fw * n; c.height = fh;
    const ctx = c.getContext('2d');
    for (let i = 0; i < n; i++) {
      ctx.save();
      ctx.translate(i * fw, 0);
      ctx.beginPath(); ctx.rect(0, 0, fw, fh); ctx.clip();
      draw(ctx, i);
      ctx.restore();
    }
    return { src: c.toDataURL('image/png'), frameW: fw, frameH: fh };
  }

  // Sprite sheet from ASCII pixel-art frames.
  function art(frames, palette) {
    const fs = frames.map(f => Engine.pixelArt(f, palette));
    const fw = Math.max(...fs.map(f => f.w)), fh = Math.max(...fs.map(f => f.h));
    return sheet(fw, fh, fs.length, (ctx, i) => ctx.drawImage(fs[i].img, 0, 0));
  }

  const rect = (ctx, x, y, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(x, y, w, h); };
  const sprite = (id, name, data, fps = 8) => Object.assign({ id, name, fps }, data);
  const sp = n => ' '.repeat(n);

  // ---------- Shared art ----------
  const PAL = { h: '#e43b44', s: '#ffcd75', b: '#3b5dc9', k: '#1a1c2c', g: '#38b764', w: '#f4f4f4', y: '#ffd23f', o: '#d0821c', c: '#73eff7', l: '#41a6f6' };
  const BODY = [
    '...hhhh...', '..hhhhhhh.', '..sssss...', '..sssksk..', '..ssssss..', '...ssss...',
    '..bbbbbb..', '.bbbbbbbb.', '.sbbbbbbs.', '..bbbbbb..', '..bbbbbb..',
  ];
  const LEGS = {
    idle: ['..kk..kk..', '..kk..kk..', '.kkk..kkk.'],
    run1: ['..kk..kk..', '.kk....kk.', 'kk......kk'],
    run2: ['...kkkk...', '...kkkk...', '..kkkkk...'],
    jump: ['..kk.kk...', '.kk...kk..', '.k.....k..'],
  };
  const pose = p => [...BODY, ...LEGS[p]];

  const heroSprites = () => [
    sprite('hero', 'Hero', art([pose('idle')], PAL)),
    sprite('hero-run', 'Hero run', art([pose('run1'), pose('idle'), pose('run2'), pose('idle')], PAL), 12),
    sprite('hero-jump', 'Hero jump', art([pose('jump')], PAL)),
  ];

  // color recolors the slime's body (the default green would vanish on top-down grass).
  const slimeSprite = (color = PAL.g) => sprite('slime', 'Slime', art([
    ['....gggg....', '..gggggggg..', '.gggggggggg.', '.ggwkggwkgg.', 'gggwkggwkggg',
     'gggggggggggg', 'gggggggggggg', 'gggggggggggg', 'gggggggggggg', '.gggggggggg.'],
    ['............', '...gggggg...', '.gggggggggg.', 'gggwkggwkggg', 'gggwkggwkggg',
     'gggggggggggg', 'gggggggggggg', 'gggggggggggg', 'gggggggggggg', 'gggggggggggg'],
  ], Object.assign({}, PAL, { g: color })), 4);

  const signSprite = () => sprite('sign', 'Sign', sheet(12, 12, 1, ctx => {
    rect(ctx, 5, 7, 2, 5, '#6e4420');
    rect(ctx, 0, 0, 12, 8, '#6e4420');
    rect(ctx, 1, 1, 10, 6, '#c28a50');
    rect(ctx, 2, 2, 8, 1, '#6e4420');
    rect(ctx, 2, 4, 6, 1, '#6e4420');
  }));

  const DEFAULT_SCRIPT = `// Optional game script. Define any of these functions to add custom logic:
//
// function onStart(game) {}              // once, when the game starts
// function onLevelStart(scene) {}        // each time a level begins
// function onUpdate(scene, dt) {}        // every step (60 per second)
// function onDraw(scene, ctx) {}         // draw extra things on top of the HUD
// function onCollect(scene, item) {}     // a collectible was picked up
// function onDeath(scene) {}             // the player got hurt
// function onLevelComplete(scene) {}     // the goal was reached
//
// Handy: scene.player, scene.score, game.state.lives, game.sound.play('synth:coin'),
// scene.all('enemy'), scene.camera.shake(3, 0.2), Engine.text(ctx, 'hi', x, y)
`;

  // Builds a level from ASCII rows. legend maps a character to a tile id (number) or object type id.
  function fromAscii(project, name, rows, legend) {
    const ts = project.settings.tileSize;
    const cols = Math.max(...rows.map(r => r.length)), nrows = rows.length;
    const tiles = new Array(cols * nrows).fill(0), objects = [];
    rows.forEach((row, r) => [...row].forEach((ch, c) => {
      const v = legend[ch];
      if (v == null) return;
      if (typeof v === 'number') { tiles[r * cols + c] = v; return; }
      const type = project.objects.find(o => o.id === v);
      const pos = PF.snapToCell(type, c, r, ts);
      objects.push({ id: PF.uid(), type: v, x: pos.x, y: pos.y });
    }));
    return { id: PF.uid(), name, cols, rows: nrows, tiles, objects, background: '', bgSprite: '', music: '' };
  }

  function place(project, level, typeId, col, row, props) {
    const type = project.objects.find(o => o.id === typeId);
    const pos = PF.snapToCell(type, col, row, project.settings.tileSize);
    const inst = { id: PF.uid(), type: typeId, x: pos.x, y: pos.y };
    if (props) inst.props = props;
    level.objects.push(inst);
    return inst;
  }

  const base = (name, mode) => ({
    format: 'pixelforge', version: 1, name,
    settings: Object.assign({}, PF.DEFAULT_SETTINGS, { title: name, mode }),
    sprites: [], sounds: [], tiles: [], objects: [], levels: [], script: DEFAULT_SCRIPT,
  });

  // ---------- Platformer starter ----------
  function platformer(name) {
    const p = base(name, 'platformer');
    const dirt = ctx => {
      rect(ctx, 0, 0, 16, 16, '#8b5a2b');
      [[3, 7], [10, 5], [6, 11], [12, 12], [2, 13]].forEach(([x, y]) => rect(ctx, x, y, 2, 2, '#6e4420'));
    };
    p.sprites.push(
      ...heroSprites(),
      slimeSprite(),
      signSprite(),
      sprite('tiles', 'Ground tiles', sheet(16, 16, 4, (ctx, i) => {
        if (i === 0) {
          dirt(ctx);
          rect(ctx, 0, 0, 16, 4, '#38b764'); rect(ctx, 0, 4, 16, 1, '#2a8f5a');
          rect(ctx, 2, 4, 2, 2, '#38b764'); rect(ctx, 9, 4, 3, 2, '#38b764');
        } else if (i === 1) {
          dirt(ctx);
        } else if (i === 2) {
          rect(ctx, 0, 0, 16, 16, '#3b2433');
          for (let row = 0; row < 4; row++)
            for (let x = row % 2 ? -4 : 0; x < 16; x += 8) rect(ctx, x, row * 4, 7, 3, '#b13e53');
        } else {
          rect(ctx, 0, 0, 16, 5, '#7a4b2a'); rect(ctx, 0, 0, 16, 4, '#c28a50'); rect(ctx, 0, 1, 16, 1, '#d6a86a');
          rect(ctx, 2, 5, 2, 3, '#7a4b2a'); rect(ctx, 12, 5, 2, 3, '#7a4b2a');
        }
      })),
      sprite('lava', 'Lava', sheet(16, 16, 2, (ctx, i) => {
        rect(ctx, 0, 0, 16, 16, '#e43b44'); rect(ctx, 0, 0, 16, 3, '#ef7d57');
        for (let x = 0; x < 16; x += 4) rect(ctx, x + (i ? 2 : 0), 0, 2, 1, '#ffcd75');
        rect(ctx, i ? 4 : 10, i ? 8 : 6, 2, 2, '#ffcd75'); rect(ctx, i ? 11 : 3, i ? 12 : 11, 1, 1, '#ffcd75');
      }), 3),
      sprite('coin', 'Coin', art([
        ['..yyyy..', '.yywyyy.', 'yywyyyyo', 'yywyyyyo', 'yyyyyyyo', 'yyyyyyyo', '.yyyyyo.', '..oooo..'],
        ['...yy...', '..ywyo..', '..ywyo..', '..yyyo..', '..yyyo..', '..yyyo..', '..yyyo..', '...oo...'],
      ], PAL), 4),
      sprite('spikes', 'Spikes', art([[
        '...ww......ww...', '...wd......wd...', '..wwdd....wwdd..', '..wwdd....wwdd..',
        '.wwwddd..wwwddd.', '.wwwddd..wwwddd.', 'wwwwddddwwwwdddd', 'wwwwddddwwwwdddd',
      ]], { w: '#c0cbdc', d: '#8b9bb4' })),
      sprite('spring', 'Spring', sheet(14, 8, 1, ctx => {
        rect(ctx, 0, 0, 14, 2, '#e43b44'); rect(ctx, 0, 2, 14, 1, '#a82d36');
        for (let y = 3; y < 6; y++) rect(ctx, y % 2 ? 3 : 5, y, 6, 1, '#c0cbdc');
        rect(ctx, 1, 6, 12, 2, '#566c86');
      })),
      sprite('checkpoint', 'Checkpoint', sheet(10, 16, 2, (ctx, i) => {
        rect(ctx, 1, 0, 2, 16, '#c0cbdc');
        for (let y = 0; y < 7; y++) rect(ctx, 3, 1 + y, 7 - Math.abs(3 - y) * 2, 1, i ? '#38b764' : '#566c86');
      })),
      sprite('flag', 'Flag', sheet(16, 32, 2, (ctx, i) => {
        rect(ctx, 4, 0, 2, 32, '#c0cbdc'); rect(ctx, 3, 0, 4, 2, '#ffd23f');
        for (let y = 0; y < 10; y++) rect(ctx, 6, 2 + y + (i && y > 4 ? 1 : 0), 10 - Math.round(Math.abs(4.5 - y) * 2), 1, '#e43b44');
      }), 3),
      sprite('sky', 'Sky and hills', sheet(320, 180, 1, ctx => {
        const g = ctx.createLinearGradient(0, 0, 0, 180);
        g.addColorStop(0, '#3b5dc9'); g.addColorStop(1, '#a7f0ff');
        ctx.fillStyle = g; ctx.fillRect(0, 0, 320, 180);
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        [[20, 30], [130, 18], [230, 44]].forEach(([x, y]) => { ctx.fillRect(x, y, 30, 6); ctx.fillRect(x + 6, y - 4, 16, 4); });
        // Both hill curves repeat every 320px so the image tiles seamlessly.
        const hill = (base, amp, waves, color) => {
          ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(0, 180);
          for (let x = 0; x <= 320; x += 2) ctx.lineTo(x, base - (Math.sin((x / 320) * Math.PI * 2 * waves) * 0.5 + 0.5) * amp);
          ctx.lineTo(320, 180); ctx.fill();
        };
        hill(135, 30, 2, '#257179');
        hill(160, 22, 3, '#2a8f5a');
      })),
    );
    p.tiles.push(
      { id: 1, name: 'Grass', sprite: 'tiles', frame: 0, color: '#38b764', solid: true },
      { id: 2, name: 'Dirt', sprite: 'tiles', frame: 1, color: '#8b5a2b', solid: true },
      { id: 3, name: 'Brick', sprite: 'tiles', frame: 2, color: '#b13e53', solid: true },
      { id: 4, name: 'Platform', sprite: 'tiles', frame: 3, color: '#c28a50', solid: true, oneWay: true },
      { id: 5, name: 'Lava', sprite: 'lava', frame: 0, animate: true, color: '#e43b44', solid: true, hazard: true },
    );
    p.objects.push(
      { id: 'hero', name: 'Hero', behavior: 'player', w: 10, h: 14, sprite: 'hero', color: '#3b5dc9', props: { runSprite: 'hero-run', jumpSprite: 'hero-jump' }, sounds: {} },
      { id: 'coin', name: 'Coin', behavior: 'collectible', w: 8, h: 8, sprite: 'coin', color: '#ffd23f', props: {}, sounds: {} },
      { id: 'slime', name: 'Slime', behavior: 'enemy', w: 12, h: 10, sprite: 'slime', color: '#38b764', props: {}, sounds: {} },
      { id: 'spikes', name: 'Spikes', behavior: 'hazard', w: 12, h: 7, sprite: 'spikes', color: '#c0cbdc', props: {}, sounds: {} },
      { id: 'spring', name: 'Spring', behavior: 'spring', w: 14, h: 6, sprite: 'spring', color: '#e43b44', props: {}, sounds: {} },
      { id: 'checkpoint', name: 'Checkpoint', behavior: 'checkpoint', w: 8, h: 16, sprite: 'checkpoint', color: '#566c86', props: {}, sounds: {} },
      { id: 'flag', name: 'Flag', behavior: 'goal', w: 8, h: 32, sprite: 'flag', color: '#e43b44', props: {}, sounds: {} },
      { id: 'sign', name: 'Sign', behavior: 'sign', w: 12, h: 12, sprite: 'sign', color: '#a0662e', props: {}, sounds: {} },
    );
    const legend = { '#': 1, '=': 2, '-': 4, L: 5, P: 'hero', o: 'coin', e: 'slime', '^': 'spikes', S: 'spring', C: 'checkpoint', F: 'flag', i: 'sign' };

    const l1 = fromAscii(p, 'Green Hills', [
      '', '', '', '', '',
      sp(23) + 'oooo',
      sp(23) + '----' + sp(40) + 'F',
      sp(18) + 'oooo' + sp(16) + 'oo' + sp(7) + 'o' + sp(16) + '######',
      sp(18) + '----' + sp(24) + '###' + sp(2) + '##' + sp(9) + '##======',
      ' i P   o' + sp(15) + 'S ' + 'e' + sp(8) + 'C' + sp(3) + '^^' + sp(4) + 'e' + sp(15) + '##========',
      '############   ###############   #################    ################',
      '============   ===============   =================    ================',
    ], legend);
    l1.bgSprite = 'sky';
    l1.objects.find(o => o.type === 'sign').props = { message: 'Arrows move, Space jumps, Down drops through platforms.' };

    const l2 = fromAscii(p, 'Lava Leap', [
      '', '', '',
      sp(22) + 'oooooo',
      sp(22) + '------',
      '', '',
      sp(11) + 'oo' + sp(11) + '--' + sp(13) + 'oo',
      sp(11) + '--' + sp(26) + '--',
      'i P     o' + sp(11) + 'S' + sp(11) + 'e' + sp(13) + 'F',
      '##########LLLL########LLLLLL##########LLLL########',
      '==========LLLL========LLLLLL==========LLLL========',
    ], legend);
    l2.background = '#2a1a2e';
    l2.objects.find(o => o.type === 'sign').props = { message: 'Springs launch you high. Lava hurts!' };
    p.levels.push(l1, l2);
    return p;
  }

  // ---------- Top-down starter ----------
  function topdown(name) {
    const p = base(name, 'topdown');
    p.settings.background = '#1a1c2c';
    p.sprites.push(
      ...heroSprites(),
      slimeSprite('#a64ca6'),
      signSprite(),
      sprite('td-tiles', 'Overworld tiles', sheet(16, 16, 4, (ctx, i) => {
        if (i === 0) {
          rect(ctx, 0, 0, 16, 16, '#38b764');
          [[3, 4], [11, 2], [7, 10], [13, 12], [2, 13]].forEach(([x, y]) => rect(ctx, x, y, 1, 2, '#2a8f5a'));
        } else if (i === 1) {
          rect(ctx, 0, 0, 16, 16, '#d6b37a');
          [[4, 3], [11, 7], [6, 12]].forEach(([x, y]) => rect(ctx, x, y, 2, 1, '#b8935a'));
        } else if (i === 2) {
          rect(ctx, 0, 0, 16, 16, '#333c57');
          for (let row = 0; row < 4; row++)
            for (let x = row % 2 ? -4 : 0; x < 16; x += 8) rect(ctx, x, row * 4, 7, 3, '#566c86');
        } else {
          rect(ctx, 0, 0, 16, 16, '#38b764');
          rect(ctx, 2, 3, 12, 11, '#1e5a3a'); rect(ctx, 1, 5, 14, 7, '#1e5a3a'); rect(ctx, 4, 2, 8, 13, '#1e5a3a');
          rect(ctx, 4, 4, 3, 2, '#2a8f5a'); rect(ctx, 9, 6, 3, 2, '#2a8f5a');
        }
      })),
      sprite('water', 'Water', sheet(16, 16, 2, (ctx, i) => {
        rect(ctx, 0, 0, 16, 16, '#3b5dc9');
        for (let y = 2; y < 16; y += 5) rect(ctx, (y + i * 4) % 12, y, 4, 1, '#41a6f6');
      }), 2),
      sprite('gem', 'Gem', art([
        ['...cc...', '..cwcc..', '.cwccll.', 'ccccclll', '.ccllll.', '..clll..', '...ll...', '........'],
        ['...cc...', '..cccc..', '.ccwcll.', 'cccwclll', '.ccllll.', '..clll..', '...ll...', '........'],
      ], PAL), 3),
      sprite('ghost', 'Ghost', art([
        ['...wwwwww...', '..wwwwwwww..', '.wwwwwwwwww.', '.wwkwwwwkww.', '.wwkwwwwkww.', '.wwwwwwwwww.',
         '.wwwwkkwwww.', '.wwwwwwwwww.', '.wwwwwwwwww.', '.wwwwwwwwww.', '.ww.www.www.', '.w...w...w..'],
        ['...wwwwww...', '..wwwwwwww..', '.wwwwwwwwww.', '.wwkwwwwkww.', '.wwkwwwwkww.', '.wwwwwwwwww.',
         '.wwwwkkwwww.', '.wwwwwwwwww.', '.wwwwwwwwww.', '.wwwwwwwwww.', '.www.www.ww.', '..w...w...w.'],
      ], PAL), 4),
      sprite('portal', 'Portal', sheet(16, 16, 2, (ctx, i) => {
        const cols = i ? ['#ef7d57', '#b13e53', '#5d275d', '#1a1c2c'] : ['#5d275d', '#b13e53', '#ef7d57', '#ffcd75'];
        cols.forEach((c, k) => rect(ctx, 1 + k * 2, 1 + k * 2, 14 - k * 4, 14 - k * 4, c));
      }), 4),
    );
    p.tiles.push(
      { id: 1, name: 'Grass', sprite: 'td-tiles', frame: 0, color: '#38b764', solid: false },
      { id: 2, name: 'Path', sprite: 'td-tiles', frame: 1, color: '#d6b37a', solid: false },
      { id: 3, name: 'Wall', sprite: 'td-tiles', frame: 2, color: '#566c86', solid: true },
      { id: 4, name: 'Bush', sprite: 'td-tiles', frame: 3, color: '#1e5a3a', solid: true },
      { id: 5, name: 'Water', sprite: 'water', frame: 0, animate: true, color: '#3b5dc9', solid: true },
    );
    p.objects.push(
      { id: 'hero', name: 'Hero', behavior: 'player', w: 10, h: 14, sprite: 'hero', color: '#3b5dc9', props: { runSprite: 'hero-run', speed: 90 }, sounds: {} },
      { id: 'gem', name: 'Gem', behavior: 'collectible', w: 8, h: 8, sprite: 'gem', color: '#73eff7', props: {}, sounds: {} },
      { id: 'slime', name: 'Slime', behavior: 'enemy', w: 12, h: 10, sprite: 'slime', color: '#a64ca6', props: { direction: 'chase', speed: 35 }, sounds: {} },
      { id: 'ghost', name: 'Ghost', behavior: 'enemy', w: 12, h: 12, sprite: 'ghost', color: '#f4f4f4', props: { direction: 'vertical', speed: 50 }, sounds: {} },
      { id: 'portal', name: 'Portal', behavior: 'goal', w: 14, h: 14, sprite: 'portal', color: '#b13e53', props: { requireAll: true }, sounds: {} },
      { id: 'sign', name: 'Sign', behavior: 'sign', w: 12, h: 12, sprite: 'sign', color: '#a0662e', props: {}, sounds: {} },
    );

    const W = 32, H = 18, GRASS = 1, PATH = 2, WALL = 3, BUSH = 4, WATER = 5;
    const level = { id: PF.uid(), name: 'The Meadow', cols: W, rows: H, tiles: new Array(W * H).fill(GRASS), objects: [], background: '', bgSprite: '', music: '' };
    const set = (x, y, id) => { if (x >= 0 && y >= 0 && x < W && y < H) level.tiles[y * W + x] = id; };
    const fill = (x, y, w, h, id) => { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) set(x + i, y + j, id); };
    fill(1, 9, W - 2, 1, PATH);                          // east-west road
    fill(16, 1, 1, H - 2, PATH);                         // north-south road
    fill(0, 0, W, 1, WALL); fill(0, H - 1, W, 1, WALL);  // outer walls
    fill(0, 0, 1, H, WALL); fill(W - 1, 0, 1, H, WALL);
    fill(10, 1, 1, 6, WALL); fill(10, 12, 1, 5, WALL);   // a wall with a gap around the road
    fill(21, 2, 6, 4, WATER);                            // pond
    fill(22, 12, 9, 1, WALL); fill(22, 12, 1, 5, WALL);  // walled garden in the corner...
    set(22, 14, PATH);                                   // ...with a doorway
    [[4, 5], [5, 5], [13, 3], [13, 14], [19, 13], [6, 13], [26, 8], [28, 7]].forEach(([x, y]) => set(x, y, BUSH));

    place(p, level, 'hero', 2, 2);
    place(p, level, 'sign', 4, 2, { message: 'Collect every gem, then step into the portal!' });
    [[7, 3], [3, 14], [14, 6], [19, 4], [28, 4], [25, 15], [12, 15], [29, 10]].forEach(([x, y]) => place(p, level, 'gem', x, y));
    [[6, 11], [13, 12], [26, 14]].forEach(([x, y]) => place(p, level, 'slime', x, y));
    [[18, 3], [8, 14]].forEach(([x, y]) => place(p, level, 'ghost', x, y));
    place(p, level, 'portal', 28, 15);
    p.levels.push(level);
    return p;
  }

  // ---------- Blank projects ----------
  function blank(name, mode) {
    const p = base(name, mode);
    const top = mode === 'topdown';
    p.tiles.push(top
      ? { id: 1, name: 'Floor', color: '#2a8f5a', solid: false, frame: 0 }
      : { id: 1, name: 'Ground', color: '#8b5a2b', solid: true, frame: 0 });
    if (top) p.tiles.push({ id: 2, name: 'Wall', color: '#566c86', solid: true, frame: 0 });
    p.objects.push({ id: 'player', name: 'Player', behavior: 'player', w: 10, h: 14, color: '#3b5dc9', sprite: '', props: {}, sounds: {} });
    const cols = top ? 24 : 40, rows = top ? 14 : 12;
    const level = { id: PF.uid(), name: 'Level 1', cols, rows, tiles: new Array(cols * rows).fill(top ? 1 : 0), objects: [], background: '', bgSprite: '', music: '' };
    for (let c = 0; c < cols; c++)
      for (let r = 0; r < rows; r++) {
        if (top && (r === 0 || c === 0 || r === rows - 1 || c === cols - 1)) level.tiles[r * cols + c] = 2;
        if (!top && r >= rows - 2) level.tiles[r * cols + c] = 1;
      }
    place(p, level, 'player', 2, top ? 2 : rows - 3);
    p.levels.push(level);
    return p;
  }

  const LIST = [
    { id: 'platformer', name: 'Platformer starter', desc: 'Two playable levels with coins, enemies, springs, checkpoints and lava.', make: platformer },
    { id: 'topdown', name: 'Top-down starter', desc: 'An overworld with gems to collect, chasing slimes, ghosts and a portal.', make: topdown },
    { id: 'blank-platformer', name: 'Blank platformer', desc: 'Gravity and jumping, a strip of ground and a player.', make: n => blank(n, 'platformer') },
    { id: 'blank-topdown', name: 'Blank top-down', desc: 'Free movement in four directions inside a walled room.', make: n => blank(n, 'topdown') },
  ];

  global.Templates = {
    LIST,
    DEFAULT_SCRIPT,
    create(id, name) {
      const t = LIST.find(x => x.id === id) || LIST[0];
      return PF.normalizeProject(t.make(name));
    },
  };
})(window);
