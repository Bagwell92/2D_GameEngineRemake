// PixelForge editor: start screen, level editor, asset managers, playtest and project files.
(function () {
  'use strict';
  const { h, clear } = UI;
  const PF = PixelForge, BEHAVIORS = PF.BEHAVIORS;
  const $ = id => document.getElementById(id);
  const clamp = Engine.clamp;

  // ---------- State ----------
  const S = {
    project: null,
    file: null,              // file name the project saves to
    dirty: false,
    view: 'level',           // level | sprites | sounds | script | settings
    levelIndex: 0,
    brush: null,             // { kind: 'tile' | 'object', id }
    tool: 'brush',           // brush | rect | fill | erase | pick | select
    selection: null,         // id of the selected placed object
    inspect: { kind: 'level' },
    zoom: 3, panX: 40, panY: 40,
    grid: true,
    hover: null,             // last cursor position over the level canvas
    spriteSel: null,
    playing: null,
  };

  const PREFS_KEY = 'pixelforge.prefs';
  try { Object.assign(S, JSON.parse(localStorage.getItem(PREFS_KEY) || '{}')); } catch (e) { /* defaults */ }
  const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify({ grid: S.grid })); } catch (e) { /* ignore */ } };

  // ---------- Lookups ----------
  const P = () => S.project;
  const level = () => S.project.levels[S.levelIndex];
  const ts = () => S.project.settings.tileSize;
  const tileDef = id => S.project.tiles.find(t => t.id === id);
  const objType = id => S.project.objects.find(o => o.id === id);
  const spriteDef = id => id && S.project.sprites.find(s => s.id === id);
  const soundDef = id => id && S.project.sounds.find(s => s.id === id);
  const isTopdown = () => S.project.settings.mode === 'topdown';
  const modeOk = item => !item.mode || item.mode === S.project.settings.mode;
  const instAt = id => level().objects.find(o => o.id === id);

  function clone(v) {
    if (Array.isArray(v)) return v.map(clone);
    if (v && typeof v === 'object') { const o = {}; for (const k in v) o[k] = clone(v[k]); return o; }
    return v; // strings (including big image data URLs) are shared, not copied
  }

  // ---------- Sprite image cache ----------
  const Sprites = {
    map: new Map(),
    entry(id) {
      const def = spriteDef(id);
      if (!def) return null;
      let e = this.map.get(id);
      if (!e || e.src !== def.src) {
        e = { src: def.src, img: new Image(), ready: false, waiters: [], key: null, sprite: null };
        const entry = e;
        e.img.onload = () => { entry.ready = true; entry.waiters.splice(0).forEach(f => f()); requestRender(); };
        e.img.src = def.src;
        this.map.set(id, e);
      }
      return e;
    },
    get(id) {
      if (!id) return null;
      const e = this.entry(id);
      if (!e || !e.ready) return null;
      const def = spriteDef(id), key = `${def.frameW}x${def.frameH}@${def.fps}`;
      if (e.key !== key) { e.key = key; e.sprite = PF.makeSprite(e.img, def); }
      return e.sprite;
    },
    whenReady(id, fn) { const e = this.entry(id); if (e) { if (e.ready) fn(); else e.waiters.push(fn); } },
    size(id) { const e = this.entry(id); return e && e.ready ? { w: e.img.width, h: e.img.height } : null; },
    clear() { this.map.clear(); },
  };

  // A small canvas showing one frame of a sprite (or a color swatch when there's no sprite).
  function thumb(spriteId, frame, size, color) {
    const c = h('canvas', { width: size, height: size, class: 'thumb' });
    const draw = () => {
      const ctx = c.getContext('2d');
      ctx.clearRect(0, 0, size, size);
      ctx.imageSmoothingEnabled = false;
      const s = Sprites.get(spriteId);
      if (s) {
        const f = s.frames[(frame || 0) % s.frames.length];
        let k = Math.min(size / f.w, size / f.h);
        if (k >= 1) k = Math.floor(k);
        const w = f.w * k, hh = f.h * k;
        ctx.drawImage(f.img, f.sx, f.sy, f.w, f.h, Math.floor((size - w) / 2), Math.floor((size - hh) / 2), w, hh);
      } else if (spriteDef(spriteId)) {
        Sprites.whenReady(spriteId, draw);
      } else {
        ctx.fillStyle = color || '#888';
        ctx.fillRect(Math.round(size * 0.15), Math.round(size * 0.15), Math.round(size * 0.7), Math.round(size * 0.7));
      }
    };
    draw();
    return c;
  }

  // ---------- Undo / redo ----------
  // Each entry is a snapshot of the whole project. Images are shared strings, so this stays cheap.
  const History = {
    undoStack: [], redoStack: [], lastKey: null, lastTime: 0,
    reset() { this.undoStack = []; this.redoStack = []; this.lastKey = null; updateUndoButtons(); },
    // Call before changing the project. Changes with the same key within 1.5s merge into one step
    // (so typing a name is one undo, not one per letter).
    record(key) {
      const now = performance.now();
      if (key && key === this.lastKey && now - this.lastTime < 1500) { this.lastTime = now; return; }
      this.undoStack.push(clone(S.project));
      if (this.undoStack.length > 100) this.undoStack.shift();
      this.redoStack = [];
      this.lastKey = key || null;
      this.lastTime = now;
      updateUndoButtons();
    },
    undo() { if (!this.undoStack.length) return; this.redoStack.push(clone(S.project)); S.project = this.undoStack.pop(); this.after(); },
    redo() { if (!this.redoStack.length) return; this.undoStack.push(clone(S.project)); S.project = this.redoStack.pop(); this.after(); },
    after() { this.lastKey = null; validateState(); markDirty(); refresh(); updateUndoButtons(); },
  };

  function updateUndoButtons() {
    const u = document.querySelector('[data-cmd="undo"]'), r = document.querySelector('[data-cmd="redo"]');
    if (u) u.disabled = !History.undoStack.length;
    if (r) r.disabled = !History.redoStack.length;
  }

  // Keeps selections pointing at things that still exist (after undo, deletes, etc.).
  function validateState() {
    S.levelIndex = clamp(S.levelIndex, 0, Math.max(0, P().levels.length - 1));
    if (S.selection && !(level() && instAt(S.selection))) S.selection = null;
    if (S.brush && !(S.brush.kind === 'tile' ? tileDef(S.brush.id) : objType(S.brush.id))) S.brush = firstBrush();
    const k = S.inspect.kind;
    if ((k === 'tile' && !tileDef(S.inspect.id)) || (k === 'object' && !objType(S.inspect.id)) || (k === 'instance' && !S.selection)) S.inspect = { kind: 'level' };
    if (S.spriteSel && !spriteDef(S.spriteSel)) S.spriteSel = null;
  }

  function firstBrush() {
    const t = P().tiles[0];
    if (t) return { kind: 'tile', id: t.id };
    const o = P().objects[0];
    return o ? { kind: 'object', id: o.id } : null;
  }

  // ---------- Change tracking & refresh ----------
  function markDirty() { S.dirty = true; updateTitle(); }

  function updateTitle() {
    if (!S.project) { document.title = 'PixelForge'; return; }
    $('projectName').textContent = S.project.name;
    $('projectName').classList.toggle('dirty', S.dirty);
    $('projectName').title = `${S.file}${S.dirty ? ' (unsaved changes)' : ''} - click to rename`;
    document.title = (S.dirty ? '• ' : '') + S.project.name + ' - PixelForge';
  }

  // Re-renders parts of the UI: palette, levels, inspector, toolbar, views, canvas. No args = all.
  function refresh(...parts) {
    if (!S.project) return;
    const all = !parts.length, has = p => all || parts.includes(p);
    if (has('palette')) renderPalette();
    if (has('levels')) renderLevels();
    if (has('inspector')) renderInspector();
    if (has('toolbar')) renderToolbar();
    if (has('views')) renderCurrentView();
    requestRender();
    updateTitle();
    updateStatus();
  }

  // Records an undo step, applies a change, marks the project dirty and refreshes some UI parts.
  function edit(key, fn, ...parts) {
    History.record(key);
    fn();
    markDirty();
    refresh(...(parts.length ? parts : ['canvas']));
  }

  // ---------- Start screen ----------
  async function showStart() {
    stopPlay();
    S.project = null;
    S.file = null;
    S.dirty = false;
    document.title = 'PixelForge';
    $('editor').hidden = true;
    const root = clear($('start'));
    root.hidden = false;

    const recent = h('div', { class: 'recent-list' }, h('div', { class: 'muted' }, 'Loading…'));
    const recovery = h('div');
    root.appendChild(h('div', { class: 'start-inner' },
      h('div', { class: 'start-hero' },
        logo(56),
        h('div', null, h('h1', null, 'PixelForge'), h('p', { class: 'muted' }, 'Make 2D games: paint levels, add sprites and sounds, press Play.'))),
      h('div', { class: 'start-actions' },
        h('button', { class: 'primary big', onclick: newProjectDialog }, 'New project'),
        h('button', { class: 'big', onclick: importProjectFile }, 'Open project file…')),
      recovery,
      h('h3', null, 'Your projects'),
      recent,
      Storage.desktop
        ? h('p', { class: 'muted small' }, 'Projects are saved in ',
          h('a', { href: '#', onclick: e => { e.preventDefault(); Storage.reveal('projects'); } }, Storage.info.projectsDir))
        : h('p', { class: 'muted small' }, 'Running in a browser, so projects are stored inside this browser. Use File → Download project file to keep a copy, or run PixelForge.exe to save real files.')));

    const auto = await Storage.autosave.load();
    if (auto && auto.project) {
      recovery.appendChild(h('div', { class: 'recovery' },
        h('div', null, h('strong', null, 'Unsaved work found. '), `"${auto.project.name}" was autosaved ${UI.timeAgo(auto.time)} but never saved.`),
        h('div', { class: 'row' },
          h('button', { class: 'primary', onclick: () => openProject(auto.project, auto.file || Storage.fileNameFor(auto.project.name), true) }, 'Recover it'),
          h('button', { onclick: async () => { await Storage.autosave.clear(); recovery.remove(); } }, 'Discard'))));
    }

    let list = [];
    try { list = await Storage.list(); } catch (err) { UI.toast('Could not list projects: ' + err.message, { kind: 'error' }); }
    clear(recent);
    if (!list.length) recent.appendChild(h('div', { class: 'empty' }, 'No projects yet. Create one to get started!'));
    for (const p of list) {
      recent.appendChild(h('div', { class: 'recent-item', ondblclick: () => openFromList(p.file) },
        h('div', { class: 'recent-info' }, h('strong', null, p.name || p.file), h('span', { class: 'muted small' }, `${p.file} · ${UI.timeAgo(p.modified)}`)),
        h('button', { class: 'primary', onclick: () => openFromList(p.file) }, 'Open'),
        h('button', { class: 'ghost', title: 'Delete project', onclick: () => deleteProject(p) }, 'Delete')));
    }
  }

  function logo(size) {
    const c = h('canvas', { width: 20, height: 20, class: 'logo', style: { width: size + 'px', height: size + 'px' } });
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#5b8cff'; ctx.fillRect(0, 0, 20, 20);
    ctx.fillStyle = '#29366f'; ctx.fillRect(0, 15, 20, 5);
    ctx.fillStyle = '#ffd23f'; ctx.fillRect(13, 4, 4, 4);
    ctx.fillStyle = '#1a1c2c'; ctx.fillRect(4, 7, 6, 8);
    ctx.fillStyle = '#ffcd75'; ctx.fillRect(5, 4, 4, 4);
    ctx.fillStyle = '#e43b44'; ctx.fillRect(4, 3, 6, 2);
    return c;
  }

  async function deleteProject(p) {
    const msg = Storage.desktop ? `Move "${p.name || p.file}" to the Recycle Bin?` : `Delete "${p.name || p.file}" from this browser? This can't be undone.`;
    if (!(await UI.confirm('Delete project', msg, 'Delete', true))) return;
    try { await Storage.remove(p.file); UI.toast('Deleted ' + p.file); } catch (err) { UI.toast('Delete failed: ' + err.message, { kind: 'error' }); }
    showStart();
  }

  async function newProjectDialog() {
    let choice = 'platformer';
    const name = h('input', { type: 'text', value: 'My Game' });
    const cards = h('div', { class: 'template-grid' }, Templates.LIST.map(t =>
      h('button', {
        class: 'template' + (t.id === choice ? ' active' : ''), 'data-id': t.id,
        onclick: () => { choice = t.id; cards.querySelectorAll('.template').forEach(b => b.classList.toggle('active', b.dataset.id === choice)); },
      }, h('strong', null, t.name), h('span', null, t.desc))));
    const res = await UI.modal({
      title: 'New project', width: '640px',
      body: [UI.field('Name', name), h('div', { class: 'field-label' }, 'Start from'), cards],
      buttons: [{ label: 'Cancel', value: null }, { label: 'Create', primary: true, value: () => ({ name: name.value.trim() || 'My Game', template: choice }) }],
    });
    if (!res || !(await confirmDiscard())) return;
    const project = Templates.create(res.template, res.name);
    openProject(project, await Storage.uniqueFile(res.name), true);
    await saveProject();
  }

  // Asks what to do with unsaved changes. Resolves true if it's OK to continue.
  async function confirmDiscard() {
    if (!S.project || !S.dirty) return true;
    const choice = await UI.modal({
      title: 'Unsaved changes', body: h('p', null, `Save changes to "${S.project.name}" first?`),
      buttons: [{ label: 'Cancel', value: null }, { label: "Don't save", value: 'discard', danger: true }, { label: 'Save', value: 'save', primary: true }],
    });
    if (choice === 'save') return saveProject();
    if (choice === 'discard') { await Storage.autosave.clear(); return true; }
    return false;
  }

  async function openFromList(file) {
    if (!(await confirmDiscard())) return;
    try { openProject(await Storage.load(file), file, false); }
    catch (err) { UI.toast('Could not open project: ' + err.message, { kind: 'error', time: 6000 }); }
  }

  async function importProjectFile() {
    const [file] = await UI.pickFiles('.pixelforge,.json', false);
    if (file) importProjectFromFile(file);
  }

  async function importProjectFromFile(file) {
    let project;
    try {
      project = JSON.parse(await UI.readAsText(file));
      if (!project || (project.format !== 'pixelforge' && !Array.isArray(project.levels))) throw new Error('This is not a PixelForge project.');
    } catch (err) {
      return UI.toast('Could not open ' + file.name + ': ' + err.message, { kind: 'error', time: 6000 });
    }
    if (!(await confirmDiscard())) return;
    openProject(project, await Storage.uniqueFile(project.name || file.name.replace(/\.\w+$/, '')), true);
    UI.toast('Opened ' + file.name + '. Press Ctrl+S to save it to your projects.', { time: 5000 });
  }

  function openProject(project, file, dirty) {
    stopPlay();
    S.project = PF.normalizeProject(clone(project));
    S.file = file;
    S.dirty = !!dirty;
    S.levelIndex = 0;
    S.selection = null;
    S.inspect = { kind: 'level' };
    S.brush = firstBrush();
    S.tool = 'brush';
    S.spriteSel = null;
    History.reset();
    Sprites.clear();
    $('start').hidden = true;
    $('editor').hidden = false;
    setView('level');
    requestAnimationFrame(fitView);
  }

  // ---------- Saving, exporting ----------
  async function saveProject() {
    if (!S.project) return false;
    try {
      await Storage.save(S.file, S.project);
      S.dirty = false;
      updateTitle();
      Storage.autosave.clear();
      UI.toast('Saved ' + S.file, { kind: 'ok', time: 1800 });
      return true;
    } catch (err) {
      UI.toast('Save failed: ' + err.message, { kind: 'error', time: 6000 });
      return false;
    }
  }

  async function saveAs() {
    const name = await UI.prompt('Save as', 'Project name', S.project.name, 'Save');
    if (!name) return;
    const file = Storage.fileNameFor(name);
    if (file.toLowerCase() !== S.file.toLowerCase() && (await Storage.exists(file)) &&
        !(await UI.confirm('Replace project?', `A project called "${file}" already exists. Replace it?`, 'Replace', true))) return;
    S.project.name = name;
    S.file = file;
    await saveProject();
  }

  async function renameProject() {
    const name = await UI.prompt('Rename game', 'Name', S.project.name, 'Rename');
    if (!name) return;
    edit(null, () => { S.project.name = name; });
    UI.toast('Renamed. The file is still ' + S.file + ' (use Save as to change it).', { time: 4500 });
  }

  function downloadProject() {
    Storage.download(S.file, JSON.stringify(S.project), 'application/json');
  }

  const escapeHtml = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  // Builds one self-contained HTML file with the engine, runtime and project inside.
  async function exportGame() {
    try {
      const [engine, runtime] = await Promise.all(['js/engine.js', 'js/runtime.js'].map(u =>
        fetch(u).then(r => { if (!r.ok) throw new Error('could not read ' + u); return r.text(); })));
      const s = S.project.settings;
      const data = JSON.stringify(S.project).replace(/</g, '\\u003c');
      const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(s.title || S.project.name)}</title>
<style>
html, body { margin: 0; height: 100%; background: #111; }
body { display: flex; align-items: center; justify-content: center; }
canvas { width: min(100vw, calc(100vh * ${s.width} / ${s.height})); aspect-ratio: ${s.width} / ${s.height}; image-rendering: pixelated; background: #000; }
</style>
</head>
<body>
<canvas id="game"></canvas>
<script>${engine}</script>
<script>${runtime}</script>
<script>
PixelForge.play(${data}, document.getElementById('game')).catch(function (e) { document.body.textContent = 'Could not start the game: ' + e.message; });
</script>
</body>
</html>
`;
      const name = S.file.replace(/\.pixelforge$/i, '') + '.html';
      const path = await Storage.exportGame(name, html);
      if (path) UI.toast('Exported to ' + path, { kind: 'ok', time: 8000, action: { label: 'Show in folder', onClick: () => Storage.reveal(path) } });
      else UI.toast('Downloaded ' + name + '. Open it in any browser to play.', { kind: 'ok', time: 5000 });
    } catch (err) {
      const hint = location.protocol === 'file:' ? ' Start PixelForge with PixelForge.exe to export.' : '';
      UI.toast('Export failed: ' + err.message + '.' + hint, { kind: 'error', time: 8000 });
    }
  }

  // ---------- Views ----------
  function setView(v) {
    S.view = v;
    document.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === v));
    for (const name of ['level', 'sprites', 'sounds', 'script', 'settings']) $('view-' + name).hidden = name !== v;
    refresh();
  }

  function renderCurrentView() {
    if (S.view === 'sprites') renderSpritesView();
    else if (S.view === 'sounds') renderSoundsView();
    else if (S.view === 'script') renderScriptView();
    else if (S.view === 'settings') renderSettingsView();
  }

  // ---------- Palette (left panel) ----------
  function renderPalette() {
    const tp = clear($('tilePalette'));
    for (const t of P().tiles) {
      const active = S.brush && S.brush.kind === 'tile' && S.brush.id === t.id;
      const flags = [t.solid && !t.oneWay && 'solid', t.oneWay && 'one-way', t.hazard && 'hazard'].filter(Boolean).join(', ') || 'decorative';
      tp.appendChild(h('button', { class: 'tile-item' + (active ? ' active' : ''), title: `${t.name} (${flags})`, onclick: () => selectBrush('tile', t.id) },
        thumb(t.sprite, t.frame, 32, t.color)));
    }
    if (!P().tiles.length) tp.appendChild(h('div', { class: 'muted small' }, 'No tiles yet.'));

    const op = clear($('objectPalette'));
    for (const o of P().objects) {
      const active = S.brush && S.brush.kind === 'object' && S.brush.id === o.id;
      op.appendChild(h('button', { class: 'object-item' + (active ? ' active' : ''), onclick: () => selectBrush('object', o.id), title: BEHAVIORS[o.behavior].desc },
        thumb(o.sprite, 0, 24, o.color), h('span', { class: 'object-name' }, o.name), h('span', { class: 'object-kind' }, BEHAVIORS[o.behavior].label)));
    }
    if (!P().objects.length) op.appendChild(h('div', { class: 'muted small' }, 'No objects yet.'));
  }

  function selectBrush(kind, id) {
    S.brush = { kind, id };
    if (!['brush', 'rect', 'fill'].includes(S.tool) || (kind === 'object' && S.tool !== 'brush')) S.tool = 'brush';
    S.selection = null;
    S.inspect = { kind, id };
    refresh('palette', 'inspector', 'toolbar');
  }

  function addTile() {
    const id = P().tiles.reduce((m, t) => Math.max(m, t.id), 0) + 1;
    const color = PixelEditor.PALETTE[(id * 5) % PixelEditor.PALETTE.length];
    edit(null, () => P().tiles.push({ id, name: 'Tile ' + id, sprite: '', frame: 0, color, solid: true }));
    selectBrush('tile', id);
  }

  function addObjectMenu(anchor) {
    UI.menu(anchor, Object.entries(BEHAVIORS).map(([key, b]) => ({
      label: b.label + (b.mode && b.mode !== P().settings.mode ? ' (platformer only)' : ''),
      onClick: () => addObject(key),
    })));
  }

  function addObject(behavior) {
    const b = BEHAVIORS[behavior];
    let name = b.label, n = 2;
    while (P().objects.some(o => o.name === name)) name = b.label + ' ' + n++;
    const o = { id: PF.uid(), name, behavior, w: b.size[0], h: b.size[1], color: b.color, sprite: '', props: {}, sounds: {} };
    edit(null, () => P().objects.push(o));
    selectBrush('object', o.id);
  }

  // ---------- Levels list ----------
  function renderLevels() {
    const el = clear($('levelList'));
    P().levels.forEach((l, i) => {
      el.appendChild(h('div', { class: 'level-item' + (i === S.levelIndex ? ' active' : ''), onclick: () => openLevel(i) },
        h('span', { class: 'level-num' }, i + 1),
        h('span', { class: 'level-name' }, l.name),
        h('span', { class: 'level-actions' },
          h('button', { class: 'icon', title: 'Move up', disabled: i === 0, onclick: e => { e.stopPropagation(); moveLevel(i, -1); } }, '▲'),
          h('button', { class: 'icon', title: 'Move down', disabled: i === P().levels.length - 1, onclick: e => { e.stopPropagation(); moveLevel(i, 1); } }, '▼'))));
    });
  }

  function openLevel(i) {
    S.levelIndex = i;
    S.selection = null;
    S.inspect = { kind: 'level' };
    if (S.view !== 'level') setView('level');
    refresh();
    fitView();
  }

  function moveLevel(i, d) {
    const j = i + d, L = P().levels;
    if (j < 0 || j >= L.length) return;
    edit(null, () => { [L[i], L[j]] = [L[j], L[i]]; }, 'levels');
    if (S.levelIndex === i) S.levelIndex = j; else if (S.levelIndex === j) S.levelIndex = i;
    refresh('levels');
  }

  function addLevel() {
    const cur = level() || { cols: 40, rows: 12 };
    const l = { id: PF.uid(), name: 'Level ' + (P().levels.length + 1), cols: cur.cols, rows: cur.rows, tiles: new Array(cur.cols * cur.rows).fill(0), objects: [], background: '', bgSprite: '', music: '' };
    // Start with some ground and the player so the new level is playable right away.
    const ground = P().tiles.find(t => t.solid && !t.hazard && !t.oneWay);
    if (ground && !isTopdown()) for (let r = l.rows - 2; r < l.rows; r++) for (let c = 0; c < l.cols; c++) l.tiles[r * l.cols + c] = ground.id;
    const player = P().objects.find(o => o.behavior === 'player');
    if (player) { const pos = PF.snapToCell(player, 2, isTopdown() ? 2 : l.rows - 3, ts()); l.objects.push({ id: PF.uid(), type: player.id, x: pos.x, y: pos.y }); }
    edit(null, () => P().levels.push(l));
    openLevel(P().levels.length - 1);
  }

  function duplicateLevel() {
    const copy = clone(level());
    copy.id = PF.uid();
    copy.name = level().name + ' copy';
    copy.objects.forEach(o => { o.id = PF.uid(); });
    edit(null, () => P().levels.splice(S.levelIndex + 1, 0, copy));
    openLevel(S.levelIndex + 1);
  }

  async function deleteLevel() {
    if (P().levels.length <= 1) return UI.toast('A game needs at least one level.', { kind: 'warn' });
    if (!(await UI.confirm('Delete level', `Delete "${level().name}"? You can undo this with Ctrl+Z.`, 'Delete', true))) return;
    edit(null, () => P().levels.splice(S.levelIndex, 1));
    openLevel(Math.max(0, S.levelIndex - 1));
  }

  function resizeLevel(l, cols, rows) {
    cols = clamp(Math.round(cols), 1, 1000);
    rows = clamp(Math.round(rows), 1, 500);
    const dy = rows - l.rows, T = ts(), tiles = new Array(cols * rows).fill(0);
    // Rows are added or removed at the top, so the ground at the bottom stays where it is.
    for (let r = 0; r < rows; r++) {
      const sr = r - dy;
      if (sr < 0 || sr >= l.rows) continue;
      for (let c = 0; c < Math.min(cols, l.cols); c++) tiles[r * cols + c] = l.tiles[sr * l.cols + c];
    }
    for (const o of l.objects) o.y += dy * T;
    l.objects = l.objects.filter(o => { const t = objType(o.type); return o.x < cols * T && o.y + (t ? t.h : 0) > 0; });
    l.cols = cols; l.rows = rows; l.tiles = tiles;
  }

  // ---------- Level editing ----------
  const getTile = (l, c, r) => (c < 0 || r < 0 || c >= l.cols || r >= l.rows ? -1 : l.tiles[r * l.cols + c]);
  function setTile(l, c, r, id) {
    if (getTile(l, c, r) === -1 || getTile(l, c, r) === id) return false;
    l.tiles[r * l.cols + c] = id;
    return true;
  }
  function floodFill(l, c, r, id) {
    const target = getTile(l, c, r);
    if (target === -1 || target === id) return false;
    const stack = [[c, r]];
    while (stack.length) {
      const [x, y] = stack.pop();
      if (getTile(l, x, y) !== target) continue;
      l.tiles[y * l.cols + x] = id;
      stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
    }
    return true;
  }
  function cellsOnLine(c0, r0, c1, r1, fn) {
    const dx = Math.abs(c1 - c0), dy = -Math.abs(r1 - r0), sx = c0 < c1 ? 1 : -1, sy = r0 < r1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      fn(c0, r0);
      if (c0 === c1 && r0 === r1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; c0 += sx; }
      if (e2 <= dx) { err += dx; r0 += sy; }
    }
  }

  // The area an object covers on screen: its hitbox plus its sprite.
  function instRect(inst) {
    const t = objType(inst.type);
    if (!t) return { x: inst.x, y: inst.y, w: 8, h: 8 };
    const s = Sprites.get(t.sprite), f = s && s.frames[0];
    if (!f) return { x: inst.x, y: inst.y, w: t.w, h: t.h };
    const sx = inst.x + (t.w - f.w) / 2, sy = inst.y + t.h - f.h;
    const x = Math.min(inst.x, sx), y = Math.min(inst.y, sy);
    return { x, y, w: Math.max(inst.x + t.w, sx + f.w) - x, h: Math.max(inst.y + t.h, sy + f.h) - y };
  }

  function instanceAt(wx, wy) {
    const objs = level().objects;
    for (let i = objs.length - 1; i >= 0; i--) {
      const r = instRect(objs[i]);
      if (wx >= r.x && wy >= r.y && wx < r.x + r.w && wy < r.y + r.h) return objs[i];
    }
    return null;
  }

  // Places an object snapped to a cell. Players are unique, so placing one moves the existing player.
  function placeObject(type, col, row) {
    const l = level(), pos = PF.snapToCell(type, col, row, ts());
    if (col < 0 || row < 0 || col >= l.cols || row >= l.rows) return null;
    if (type.behavior === 'player') {
      const existing = l.objects.find(o => { const t = objType(o.type); return t && t.behavior === 'player'; });
      if (existing) { existing.x = pos.x; existing.y = pos.y; return existing; }
    }
    if (l.objects.some(o => o.type === type.id && o.x === pos.x && o.y === pos.y)) return null;
    const inst = { id: PF.uid(), type: type.id, x: pos.x, y: pos.y };
    l.objects.push(inst);
    return inst;
  }

  function selectInstance(inst) {
    S.selection = inst ? inst.id : null;
    S.inspect = inst ? { kind: 'instance' } : { kind: 'level' };
    refresh('inspector');
  }

  function deleteSelection() {
    if (!S.selection) return;
    const id = S.selection;
    edit(null, () => { level().objects = level().objects.filter(o => o.id !== id); });
    selectInstance(null);
  }

  function duplicateSelection() {
    const inst = S.selection && instAt(S.selection);
    if (!inst) return;
    const copy = clone(inst);
    copy.id = PF.uid();
    copy.x += ts();
    edit(null, () => level().objects.push(copy));
    selectInstance(copy);
  }

  // ---------- Level canvas ----------
  const cv = $('levelCanvas'), cctx = cv.getContext('2d');
  const ZOOMS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 5, 6, 8, 10, 12, 16];
  let renderQueued = false;
  function requestRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; renderLevel(); });
  }

  function resizeLevelCanvas() {
    const wrap = $('canvasWrap'), dpr = devicePixelRatio || 1;
    cv.width = Math.max(1, Math.round(wrap.clientWidth * dpr));
    cv.height = Math.max(1, Math.round(wrap.clientHeight * dpr));
    requestRender();
  }
  new ResizeObserver(resizeLevelCanvas).observe($('canvasWrap'));

  function fitView() {
    if (!S.project || !level()) return;
    const wrap = $('canvasWrap'), W = wrap.clientWidth, H = wrap.clientHeight;
    if (!W || !H) return;
    const LW = level().cols * ts(), LH = level().rows * ts();
    const ideal = Math.min((W - 40) / LW, (H - 40) / LH);
    S.zoom = ZOOMS.filter(z => z <= ideal).pop() || ZOOMS[0];
    S.panX = Math.round((W - LW * S.zoom) / 2);
    S.panY = Math.round((H - LH * S.zoom) / 2);
    refresh('toolbar');
  }

  function zoomAt(mx, my, z) {
    z = clamp(z, ZOOMS[0], ZOOMS[ZOOMS.length - 1]);
    const wx = (mx - S.panX) / S.zoom, wy = (my - S.panY) / S.zoom;
    S.zoom = z;
    S.panX = Math.round(mx - wx * z);
    S.panY = Math.round(my - wy * z);
    refresh('toolbar');
  }
  function zoomStep(dir, mx, my) {
    const wrap = $('canvasWrap');
    if (mx == null) { mx = wrap.clientWidth / 2; my = wrap.clientHeight / 2; }
    const i = ZOOMS.findIndex(z => z >= S.zoom - 1e-6);
    const next = ZOOMS[clamp((ZOOMS[i] === S.zoom ? i : dir > 0 ? i - 1 : i) + dir, 0, ZOOMS.length - 1)];
    zoomAt(mx, my, next);
  }

  function drawTile(ctx, id, x, y, T) {
    const t = tileDef(id);
    if (!t) return;
    const s = Sprites.get(t.sprite);
    if (s) {
      const f = s.frames[(t.frame || 0) % s.frames.length];
      ctx.drawImage(f.img, f.sx, f.sy, f.w, f.h, x, y, T, T);
    } else {
      ctx.fillStyle = t.color || '#888';
      ctx.fillRect(x, y, T, T);
    }
  }

  function drawInstance(ctx, inst, x = inst.x, y = inst.y) {
    const t = objType(inst.type);
    if (!t) return;
    const s = Sprites.get(t.sprite);
    if (s) {
      const f = s.frames[0];
      ctx.drawImage(f.img, f.sx, f.sy, f.w, f.h, Math.round(x + (t.w - f.w) / 2), Math.round(y + t.h - f.h), f.w, f.h);
    } else {
      ctx.fillStyle = t.color || '#f0f';
      ctx.fillRect(x, y, t.w, t.h);
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.font = `bold ${Math.max(4, Math.min(t.w, t.h) * 0.7)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(t.name[0] || '?', x + t.w / 2, y + t.h / 2 + 0.5);
    }
  }

  function renderLevel() {
    if (!S.project || S.view !== 'level') return;
    const dpr = devicePixelRatio || 1, W = cv.width, H = cv.height, l = level(), T = ts(), z = S.zoom;
    cctx.setTransform(1, 0, 0, 1, 0, 0);
    cctx.fillStyle = '#0f1017';
    cctx.fillRect(0, 0, W, H);
    if (!l) return;
    const LW = l.cols * T, LH = l.rows * T;
    const world = () => cctx.setTransform(dpr * z, 0, 0, dpr * z, dpr * S.panX, dpr * S.panY);
    world();
    cctx.imageSmoothingEnabled = false;
    cctx.fillStyle = l.background || P().settings.background;
    cctx.fillRect(0, 0, LW, LH);

    const bg = Sprites.get(l.bgSprite);
    if (bg) {
      const f = bg.frames[0];
      cctx.save();
      cctx.beginPath(); cctx.rect(0, 0, LW, LH); cctx.clip();
      const tall = f.h >= P().settings.height;
      for (let y = tall ? Math.max(0, LH - f.h) : 0; y < LH; y += f.h) {
        for (let x = 0; x < LW; x += f.w) cctx.drawImage(f.img, f.sx, f.sy, f.w, f.h, x, y, f.w, f.h);
        if (tall) break;
      }
      cctx.restore();
    }

    // Only draw tiles that are on screen.
    const c0 = Math.max(0, Math.floor(-S.panX / z / T)), c1 = Math.min(l.cols - 1, Math.floor((W / dpr - S.panX) / z / T));
    const r0 = Math.max(0, Math.floor(-S.panY / z / T)), r1 = Math.min(l.rows - 1, Math.floor((H / dpr - S.panY) / z / T));
    for (let r = r0; r <= r1; r++)
      for (let c = c0; c <= c1; c++) {
        const id = l.tiles[r * l.cols + c];
        if (id) drawTile(cctx, id, c * T, r * T, T);
      }
    for (const inst of l.objects) drawInstance(cctx, inst);

    // Grid and border in screen pixels, so lines stay 1px sharp at any zoom.
    cctx.setTransform(1, 0, 0, 1, 0, 0);
    const sx = wx => Math.round((S.panX + wx * z) * dpr), sy = wy => Math.round((S.panY + wy * z) * dpr);
    if (S.grid && T * z >= 6) {
      cctx.fillStyle = 'rgba(255,255,255,0.13)';
      for (let c = c0; c <= c1 + 1; c++) cctx.fillRect(sx(c * T), sy(0), 1, sy(LH) - sy(0));
      for (let r = r0; r <= r1 + 1; r++) cctx.fillRect(sx(0), sy(r * T), sx(LW) - sx(0), 1);
    }
    cctx.strokeStyle = 'rgba(91,140,255,0.6)';
    cctx.lineWidth = 1;
    cctx.strokeRect(sx(0) - 0.5, sy(0) - 0.5, sx(LW) - sx(0) + 1, sy(LH) - sy(0) + 1);

    // Selection outline.
    const sel = S.selection && instAt(S.selection);
    if (sel) {
      const r = instRect(sel);
      cctx.strokeStyle = '#ffd23f';
      cctx.setLineDash([4, 3]);
      cctx.strokeRect(sx(r.x) - 1.5, sy(r.y) - 1.5, sx(r.x + r.w) - sx(r.x) + 3, sy(r.y + r.h) - sy(r.y) + 3);
      cctx.setLineDash([]);
    }

    // Tool previews.
    const hv = S.hover;
    if (drag && drag.mode === 'rect') {
      const a = drag.start, b = drag.end;
      const x0 = Math.min(a.col, b.col), y0 = Math.min(a.row, b.row), x1 = Math.max(a.col, b.col) + 1, y1 = Math.max(a.row, b.row) + 1;
      cctx.fillStyle = drag.erase ? 'rgba(229,72,77,0.25)' : 'rgba(91,140,255,0.25)';
      cctx.fillRect(sx(x0 * T), sy(y0 * T), sx(x1 * T) - sx(x0 * T), sy(y1 * T) - sy(y0 * T));
      cctx.strokeStyle = drag.erase ? '#e5484d' : '#5b8cff';
      cctx.strokeRect(sx(x0 * T) + 0.5, sy(y0 * T) + 0.5, sx(x1 * T) - sx(x0 * T) - 1, sy(y1 * T) - sy(y0 * T) - 1);
    } else if (hv && hv.inside && !drag) {
      if (S.tool === 'erase' || (S.tool === 'select' && instanceAt(hv.wx, hv.wy))) {
        const inst = instanceAt(hv.wx, hv.wy);
        const r = inst ? instRect(inst) : { x: hv.col * T, y: hv.row * T, w: T, h: T };
        cctx.strokeStyle = S.tool === 'erase' ? '#e5484d' : '#ffd23f';
        cctx.strokeRect(sx(r.x) + 0.5, sy(r.y) + 0.5, sx(r.x + r.w) - sx(r.x) - 1, sy(r.y + r.h) - sy(r.y) - 1);
      } else if (S.brush && ['brush', 'rect', 'fill'].includes(S.tool)) {
        world();
        cctx.globalAlpha = 0.55;
        if (S.brush.kind === 'tile') drawTile(cctx, S.brush.id, hv.col * T, hv.row * T, T);
        else { const t = objType(S.brush.id); if (t) { const pos = PF.snapToCell(t, hv.col, hv.row, T); drawInstance(cctx, { type: t.id }, pos.x, pos.y); } }
        cctx.globalAlpha = 1;
        cctx.setTransform(1, 0, 0, 1, 0, 0);
        cctx.strokeStyle = 'rgba(255,255,255,0.6)';
        cctx.strokeRect(sx(hv.col * T) + 0.5, sy(hv.row * T) + 0.5, sx((hv.col + 1) * T) - sx(hv.col * T) - 1, sy((hv.row + 1) * T) - sy(hv.row * T) - 1);
      }
    }
  }

  // ---------- Canvas mouse handling ----------
  let drag = null, spaceDown = false;

  function pointInfo(e) {
    const r = cv.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
    const wx = (mx - S.panX) / S.zoom, wy = (my - S.panY) / S.zoom, T = ts();
    const col = Math.floor(wx / T), row = Math.floor(wy / T), l = level();
    return { mx, my, wx, wy, col, row, inside: col >= 0 && row >= 0 && col < l.cols && row < l.rows };
  }

  // The first real change of a drag records one undo step for the whole stroke.
  function strokeChange(fn) {
    if (!drag.recorded) { History.record(); drag.recorded = true; }
    if (fn() !== false) { markDirty(); requestRender(); }
  }

  function eraseAt(p) {
    const inst = instanceAt(p.wx, p.wy);
    if (inst) {
      strokeChange(() => { level().objects = level().objects.filter(o => o !== inst); if (S.selection === inst.id) S.selection = null; });
      return;
    }
    if (getTile(level(), p.col, p.row) > 0) strokeChange(() => setTile(level(), p.col, p.row, 0));
  }

  function paintTo(p) {
    const l = level(), id = S.brush.id;
    cellsOnLine(drag.last.col, drag.last.row, p.col, p.row, (c, r) => {
      if (getTile(l, c, r) !== -1 && getTile(l, c, r) !== id) strokeChange(() => setTile(l, c, r, id));
    });
    drag.last = p;
  }

  function pickAt(p) {
    const inst = instanceAt(p.wx, p.wy);
    if (inst && objType(inst.type)) return selectBrush('object', inst.type);
    const id = getTile(level(), p.col, p.row);
    if (id > 0) { selectBrush('tile', id); setTool('brush'); }
  }

  cv.addEventListener('contextmenu', e => e.preventDefault());
  cv.addEventListener('pointerdown', e => {
    if (!S.project) return;
    cv.focus();
    cv.setPointerCapture(e.pointerId);
    const p = pointInfo(e);
    if (e.button === 1 || (e.button === 0 && spaceDown)) {
      drag = { mode: 'pan', sx: e.clientX, sy: e.clientY, px: S.panX, py: S.panY };
      cv.style.cursor = 'grabbing';
      return;
    }
    const erase = e.button === 2;
    let tool = S.tool;
    if (e.altKey && !erase && tool !== 'select') tool = 'pick';
    if (erase && tool !== 'rect' && tool !== 'fill') tool = 'erase';

    if (tool === 'brush') {
      if (!S.brush) return UI.toast('Pick a tile or object on the left first.');
      if (S.brush.kind === 'tile') {
        drag = { mode: 'paint', last: p };
        paintTo(p);
      } else {
        const type = objType(S.brush.id);
        drag = { mode: 'place', cells: new Set() };
        drag.cells.add(p.col + ',' + p.row);
        strokeChange(() => !!placeObject(type, p.col, p.row));
      }
    } else if (tool === 'erase') {
      drag = { mode: 'erase' };
      eraseAt(p);
    } else if (tool === 'rect') {
      drag = { mode: 'rect', start: p, end: p, erase };
    } else if (tool === 'fill') {
      if (!erase && (!S.brush || S.brush.kind !== 'tile')) return UI.toast('Fill works with tiles. Pick a tile on the left.');
      drag = { mode: 'fill' };
      strokeChange(() => floodFill(level(), p.col, p.row, erase ? 0 : S.brush.id));
      drag = null;
    } else if (tool === 'pick') {
      pickAt(p);
    } else if (tool === 'select') {
      const inst = instanceAt(p.wx, p.wy);
      selectInstance(inst);
      if (inst) drag = { mode: 'move', inst, ox: p.wx - inst.x, oy: p.wy - inst.y };
    }
    requestRender();
  });

  cv.addEventListener('pointermove', e => {
    if (!S.project) return;
    const p = pointInfo(e);
    S.hover = p;
    updateStatus();
    if (!drag) { requestRender(); return; }
    if (drag.mode === 'pan') {
      S.panX = drag.px + (e.clientX - drag.sx);
      S.panY = drag.py + (e.clientY - drag.sy);
    } else if (drag.mode === 'paint') {
      paintTo(p);
    } else if (drag.mode === 'place') {
      const key = p.col + ',' + p.row;
      if (!drag.cells.has(key)) { drag.cells.add(key); strokeChange(() => !!placeObject(objType(S.brush.id), p.col, p.row)); }
    } else if (drag.mode === 'erase') {
      eraseAt(p);
    } else if (drag.mode === 'rect') {
      drag.end = p;
    } else if (drag.mode === 'move') {
      const t = objType(drag.inst.type), T = ts();
      let x, y;
      if (e.altKey) { x = Math.round(p.wx - drag.ox); y = Math.round(p.wy - drag.oy); }
      else {
        // Snap by the cell under the object's bottom-center.
        const pos = PF.snapToCell(t, Math.floor((p.wx - drag.ox + t.w / 2) / T), Math.floor((p.wy - drag.oy + t.h - 1) / T), T);
        x = pos.x; y = pos.y;
      }
      if (x !== drag.inst.x || y !== drag.inst.y) strokeChange(() => { drag.inst.x = x; drag.inst.y = y; });
    }
    requestRender();
  });

  const endDrag = () => {
    if (!drag) return;
    if (drag.mode === 'rect') {
      const a = drag.start, b = drag.end, l = level();
      if (!drag.erase && (!S.brush || S.brush.kind !== 'tile')) UI.toast('The rectangle tool paints tiles. Pick a tile on the left.');
      else {
        const id = drag.erase ? 0 : S.brush.id;
        strokeChange(() => {
          let changed = false;
          for (let r = Math.min(a.row, b.row); r <= Math.max(a.row, b.row); r++)
            for (let c = Math.min(a.col, b.col); c <= Math.max(a.col, b.col); c++) changed = setTile(l, c, r, id) || changed;
          return changed;
        });
      }
    }
    const moved = drag.mode === 'move' && drag.recorded;
    drag = null;
    cv.style.cursor = spaceDown ? 'grab' : '';
    if (moved) refresh('inspector');
    requestRender();
  };
  cv.addEventListener('pointerup', endDrag);
  cv.addEventListener('pointercancel', endDrag);
  cv.addEventListener('pointerleave', () => { if (S.hover) S.hover.inside = false; requestRender(); });
  cv.addEventListener('dblclick', e => {
    const p = pointInfo(e), inst = instanceAt(p.wx, p.wy);
    if (inst) { setTool('select'); selectInstance(inst); }
  });
  cv.addEventListener('wheel', e => {
    e.preventDefault();
    const p = pointInfo(e);
    if (e.shiftKey) { S.panX -= e.deltaY || e.deltaX; requestRender(); return; }
    // Trackpads send small fractional deltas; treat sideways scrolling as panning.
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) { S.panX -= e.deltaX; requestRender(); return; }
    zoomStep(e.deltaY < 0 ? 1 : -1, p.mx, p.my);
  }, { passive: false });

  // ---------- Toolbar ----------
  const TOOLS = [
    ['brush', 'Brush', 'B', 'Paint tiles or place objects. Right-click erases.'],
    ['rect', 'Rectangle', 'R', 'Drag to fill a rectangle with tiles. Right-drag clears.'],
    ['fill', 'Fill', 'F', 'Flood-fill an area with a tile. Right-click clears the area.'],
    ['erase', 'Eraser', 'E', 'Remove tiles and objects.'],
    ['pick', 'Picker', 'I', 'Click a tile or object to use it as the brush (or hold Alt).'],
    ['select', 'Select', 'V', 'Select and drag objects (hold Alt to move off-grid). Delete removes.'],
  ];
  function setTool(t) { S.tool = t; if (t !== 'select') { S.selection = null; if (S.inspect.kind === 'instance') S.inspect = { kind: 'level' }; } refresh('toolbar', 'inspector'); }

  function renderToolbar() {
    const el = clear($('toolbar'));
    const brush = S.brush && (S.brush.kind === 'tile' ? tileDef(S.brush.id) : objType(S.brush.id));
    el.append(
      h('div', { class: 'tool-group' }, TOOLS.map(([id, label, key, tip]) =>
        h('button', { class: 'tool' + (S.tool === id ? ' active' : ''), title: `${label} (${key}): ${tip}`, onclick: () => setTool(id) }, label))),
      h('div', { class: 'tool-group' },
        h('button', { class: 'icon', title: 'Zoom out (-)', onclick: () => zoomStep(-1) }, '−'),
        h('span', { class: 'zoom-label' }, Math.round(S.zoom * 100) + '%'),
        h('button', { class: 'icon', title: 'Zoom in (+)', onclick: () => zoomStep(1) }, '+'),
        h('button', { title: 'Fit level to view (0)', onclick: fitView }, 'Fit'),
        h('button', { class: S.grid ? 'active' : '', title: 'Toggle grid (G)', onclick: () => { S.grid = !S.grid; savePrefs(); refresh('toolbar'); } }, 'Grid')),
      h('div', { class: 'spacer' }),
      brush && h('div', { class: 'brush-info' }, h('span', { class: 'muted' }, 'Brush:'),
        thumb(brush.sprite, brush.frame, 20, brush.color), h('span', null, brush.name)));
  }

  function updateStatus() {
    const el = $('status');
    if (!S.project || !el) return;
    const l = level(), hv = S.hover, parts = [];
    if (S.view === 'level' && l) {
      parts.push(TOOLS.find(t => t[0] === S.tool)[1]);
      if (hv && hv.inside) parts.push(`cell ${hv.col}, ${hv.row}`);
      parts.push(`${l.cols}×${l.rows} tiles`, `${l.objects.length} objects`);
      const hasPlayer = l.objects.some(o => { const t = objType(o.type); return t && t.behavior === 'player'; });
      if (!hasPlayer) parts.push('⚠ no player in this level');
    }
    parts.push(Storage.desktop ? S.file : S.file + ' (browser storage)');
    el.textContent = parts.join('   ·   ');
  }

  // ---------- Inspector (right panel) ----------
  const section = (title, ...children) => h('div', { class: 'insp-section' }, title && h('div', { class: 'insp-title' }, title), children);
  const head = (spriteId, frame, color, kind, name) =>
    h('div', { class: 'insp-head' }, thumb(spriteId, frame, 40, color), h('div', null, h('div', { class: 'insp-kind' }, kind), h('div', { class: 'insp-name' }, name)));

  function spritePicker(value, onChange) {
    const opts = [{ value: '', label: '(none)' }, ...P().sprites.map(s => ({ value: s.id, label: s.name }))];
    return h('div', { class: 'picker-row' },
      thumb(value, 0, 24),
      UI.select(opts, value || '', onChange),
      h('button', { class: 'icon', title: 'Upload a new image', onclick: async () => { const added = await uploadSprites(); if (added[0]) onChange(added[0].id); } }, '⤒'));
  }

  function soundPicker(value, onChange, { builtins = true } = {}) {
    const opts = [{ value: '', label: '(none)' }];
    if (builtins) for (const k of Object.keys(Engine.SYNTHS)) opts.push({ value: 'synth:' + k, label: k, group: 'Built-in' });
    for (const s of P().sounds) opts.push({ value: s.id, label: s.name, group: 'Project sounds' });
    const sel = UI.select(opts, value || '', onChange);
    return h('div', { class: 'picker-row' },
      sel,
      h('button', { class: 'icon', title: 'Preview', onclick: () => previewSound(sel.value) }, '▶'),
      h('button', { class: 'icon', title: 'Upload a sound file', onclick: async () => { const added = await uploadSounds(); if (added[0]) onChange(added[0].id); } }, '⤒'));
  }

  const previewSynth = new Engine.Sound();
  let previewAudio = null;
  function previewSound(name) {
    if (!name) return;
    if (previewAudio) { previewAudio.pause(); previewAudio = null; }
    if (name.startsWith('synth:')) return previewSynth.play(name);
    const s = soundDef(name);
    if (s) { previewAudio = new Audio(s.src); previewAudio.play().catch(() => {}); }
  }

  function framePicker(spriteId, current, onPick) {
    const s = Sprites.get(spriteId);
    if (!s || s.frames.length < 2) return null;
    return UI.field('Frame', h('div', { class: 'frame-grid' }, s.frames.slice(0, 256).map((f, i) =>
      h('button', { class: 'frame-btn' + (i === current ? ' active' : ''), title: 'Frame ' + (i + 1), onclick: () => onPick(i) }, thumb(spriteId, i, 24)))));
  }

  function propField(p, value, onChange) {
    let control;
    if (p.type === 'number') control = UI.numberInput(value, onChange);
    else if (p.type === 'bool') return UI.checkbox(p.label, value, onChange);
    else if (p.type === 'select') control = UI.select(p.options, value, onChange);
    else if (p.type === 'sprite') control = spritePicker(value, onChange);
    else control = UI.textInput(value, onChange);
    return UI.field(p.label, control);
  }

  function renderInspector() {
    const el = clear($('inspector'));
    const k = S.inspect.kind;
    if (k === 'tile' && tileDef(S.inspect.id)) return inspectTile(el, tileDef(S.inspect.id));
    if (k === 'object' && objType(S.inspect.id)) return inspectObject(el, objType(S.inspect.id));
    if (k === 'instance' && S.selection && instAt(S.selection)) return inspectInstance(el, instAt(S.selection));
    if (level()) inspectLevel(el, level());
  }

  function inspectTile(el, t) {
    el.append(
      head(t.sprite, t.frame, t.color, 'Tile', t.name),
      section('Look',
        UI.field('Name', UI.textInput(t.name, v => edit('tile-name', () => { t.name = v; }, 'palette'))),
        UI.field('Sprite', spritePicker(t.sprite, v => edit(null, () => { t.sprite = v; t.frame = 0; }, 'palette', 'inspector'))),
        t.sprite && framePicker(t.sprite, t.frame, i => edit(null, () => { t.frame = i; }, 'palette', 'inspector')),
        t.sprite && UI.checkbox('Animate (cycle through all frames)', t.animate, v => edit(null, () => { t.animate = v; })),
        UI.field('Color', UI.colorInput(t.color, v => edit('tile-color', () => { t.color = v; }, 'palette')), t.sprite ? 'Shown only when the sprite is missing.' : null)),
      section('Behavior',
        UI.checkbox('Solid (blocks movement)', t.solid, v => edit(null, () => { t.solid = v; })),
        UI.checkbox('One-way platform (land on top, jump up through)', t.oneWay, v => edit(null, () => { t.oneWay = v; if (v) t.solid = true; }, 'inspector')),
        UI.checkbox('Hazard (hurts the player)', t.hazard, v => edit(null, () => { t.hazard = v; })),
        h('p', { class: 'muted small' }, 'Turn Solid off for background tiles like grass floors in top-down games.')),
      section(null, h('button', { class: 'danger', onclick: () => deleteTile(t) }, 'Delete tile type')));
  }

  async function deleteTile(t) {
    const uses = P().levels.reduce((n, l) => n + l.tiles.filter(x => x === t.id).length, 0);
    if (uses && !(await UI.confirm('Delete tile', `"${t.name}" is used ${uses} times. Delete it and clear those cells?`, 'Delete', true))) return;
    edit(null, () => {
      P().tiles = P().tiles.filter(x => x !== t);
      for (const l of P().levels) l.tiles = l.tiles.map(x => (x === t.id ? 0 : x));
    });
    S.inspect = { kind: 'level' };
    validateState();
    refresh();
  }

  function inspectObject(el, o) {
    const b = BEHAVIORS[o.behavior];
    const count = P().levels.reduce((n, l) => n + l.objects.filter(i => i.type === o.id).length, 0);
    const behaviorOpts = Object.entries(BEHAVIORS).map(([k, v]) => ({ value: k, label: v.label + (v.mode && v.mode !== P().settings.mode ? ' (platformer only)' : '') }));
    // Resizing keeps every placed copy anchored at its bottom-center.
    const resize = (w, hh) => edit('obj-size', () => {
      w = clamp(Math.round(w), 1, 512); hh = clamp(Math.round(hh), 1, 512);
      for (const l of P().levels) for (const i of l.objects) if (i.type === o.id) { i.x += Math.round((o.w - w) / 2); i.y += o.h - hh; }
      o.w = w; o.h = hh;
    });
    const spr = Sprites.get(o.sprite);
    el.append(
      head(o.sprite, 0, o.color, 'Object · ' + b.label, o.name),
      section('Object',
        UI.field('Name', UI.textInput(o.name, v => edit('obj-name', () => { o.name = v; }, 'palette'))),
        UI.field('Behavior', UI.select(behaviorOpts, o.behavior, v => edit(null, () => { o.behavior = v; }, 'palette', 'inspector'))),
        h('p', { class: 'muted small' }, b.desc),
        UI.field('Sprite', spritePicker(o.sprite, v => edit(null, () => { o.sprite = v; }, 'palette', 'inspector'))),
        !o.sprite && UI.field('Color', UI.colorInput(o.color, v => edit('obj-color', () => { o.color = v; }, 'palette'))),
        UI.field('Hitbox size', h('div', { class: 'row' },
          UI.numberInput(o.w, v => resize(v, o.h), { min: 1, max: 512, live: false }), '×',
          UI.numberInput(o.h, v => resize(o.w, v), { min: 1, max: 512, live: false }),
          spr && h('button', { title: 'Match the sprite frame size', onclick: () => { resize(spr.w, spr.h); refresh('inspector'); } }, 'Fit sprite')),
          'The area that collides. The sprite is drawn centered on its bottom edge.')),
      b.props.some(modeOk) && section('Properties', b.props.filter(modeOk).map(p =>
        propField(p, PF.propsOf(o)[p.key], v => edit('prop-' + p.key, () => { o.props[p.key] = v; })))),
      b.sounds.length > 0 && section('Sounds', b.sounds.map(s =>
        UI.field(s.label, soundPicker(PF.soundOf(o, s.key), v => edit(null, () => { o.sounds[s.key] = v; }, 'inspector'))))),
      section(null,
        h('p', { class: 'muted small' }, count ? `Placed ${count} time${count > 1 ? 's' : ''} in this game.` : 'Not placed in any level yet. Click the level to place it.'),
        h('button', { class: 'danger', onclick: () => deleteObjectType(o, count) }, 'Delete object type')));
  }

  async function deleteObjectType(o, count) {
    if (count && !(await UI.confirm('Delete object', `"${o.name}" is placed ${count} times. Delete it and all its copies?`, 'Delete', true))) return;
    edit(null, () => {
      P().objects = P().objects.filter(x => x !== o);
      for (const l of P().levels) l.objects = l.objects.filter(i => i.type !== o.id);
    });
    S.inspect = { kind: 'level' };
    validateState();
    refresh();
  }

  function inspectInstance(el, inst) {
    const t = objType(inst.type), b = BEHAVIORS[t.behavior];
    const props = b.props.filter(p => modeOk(p) && p.type !== 'sprite');
    const eff = PF.propsOf(t, inst), own = inst.props || {};
    el.append(
      head(t.sprite, 0, t.color, 'Placed object', t.name),
      section('Position',
        h('div', { class: 'row' },
          UI.field('X', UI.numberInput(inst.x, v => edit('inst-x', () => { inst.x = Math.round(v); }))),
          UI.field('Y', UI.numberInput(inst.y, v => edit('inst-y', () => { inst.y = Math.round(v); })))),
        h('button', { onclick: () => edit(null, () => {
          const T = ts(), pos = PF.snapToCell(t, Math.floor((inst.x + t.w / 2) / T), Math.floor((inst.y + t.h - 1) / T), T);
          inst.x = pos.x; inst.y = pos.y;
        }, 'inspector') }, 'Snap to grid')),
      props.length > 0 && section('This copy only',
        h('p', { class: 'muted small' }, 'Changes here affect only this placed copy. Highlighted fields differ from the object type.'),
        props.map(p => {
          const f = propField(p, eff[p.key], v => edit('iprop-' + p.key, () => { inst.props = inst.props || {}; inst.props[p.key] = v; }));
          if (p.key in own) f.classList.add('overridden');
          return f;
        }),
        Object.keys(own).length > 0 && h('button', { onclick: () => edit(null, () => { delete inst.props; }, 'inspector') }, 'Reset to type values')),
      section(null, h('div', { class: 'row wrap' },
        h('button', { onclick: () => selectBrush('object', t.id) }, `Edit "${t.name}" type`),
        h('button', { onclick: duplicateSelection, title: 'Ctrl+D' }, 'Duplicate'),
        h('button', { class: 'danger', onclick: deleteSelection, title: 'Delete key' }, 'Delete'))));
  }

  function inspectLevel(el, l) {
    const hasPlayer = l.objects.some(o => { const t = objType(o.type); return t && t.behavior === 'player'; });
    const tileCount = l.tiles.filter(Boolean).length;
    el.append(
      h('div', { class: 'insp-head' }, h('div', null, h('div', { class: 'insp-kind' }, `Level ${S.levelIndex + 1} of ${P().levels.length}`), h('div', { class: 'insp-name' }, l.name))),
      section('Level',
        UI.field('Name', UI.textInput(l.name, v => edit('level-name', () => { l.name = v; }, 'levels'))),
        h('div', { class: 'row' },
          UI.field('Width', UI.numberInput(l.cols, v => edit(null, () => resizeLevel(l, v, l.rows), 'inspector'), { min: 1, max: 1000, live: false })),
          UI.field('Height', UI.numberInput(l.rows, v => edit(null, () => resizeLevel(l, l.cols, v), 'inspector'), { min: 1, max: 500, live: false }))),
        h('p', { class: 'muted small' }, 'Size in tiles. Height changes add or remove rows at the top.')),
      section('Look & sound',
        UI.checkbox('Custom background color', !!l.background, v => edit(null, () => { l.background = v ? P().settings.background : ''; }, 'inspector')),
        l.background && UI.field('Background color', UI.colorInput(l.background, v => edit('level-bg', () => { l.background = v; }))),
        UI.field('Background image', spritePicker(l.bgSprite, v => edit(null, () => { l.bgSprite = v; }, 'inspector')), 'Scrolls slowly behind the level (parallax).'),
        UI.field('Music', soundPicker(l.music, v => edit(null, () => { l.music = v; }, 'inspector'), { builtins: false }), 'Loops while this level plays. Upload a sound to use it.')),
      section('Info',
        h('p', { class: 'muted small' }, `${tileCount} tiles, ${l.objects.length} objects.`),
        !hasPlayer && h('p', { class: 'warn small' }, '⚠ This level has no player. Pick a Player object and click to place it.')),
      section(null, h('div', { class: 'row wrap' },
        h('button', { class: 'primary', onclick: () => play('level') }, '▶ Play level'),
        h('button', { onclick: duplicateLevel }, 'Duplicate'),
        h('button', { class: 'danger', onclick: deleteLevel }, 'Delete'))));
  }

  // ---------- Sprites view ----------
  async function addSpriteFiles(files) {
    const added = [];
    for (const f of files) {
      try {
        const src = await UI.readAsDataURL(f);
        const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('not an image')); i.src = src; });
        // Guess a horizontal strip of square frames when the image is several times wider than tall.
        const strip = img.width > img.height && img.width % img.height === 0;
        added.push({ id: PF.uid(), name: f.name.replace(/\.[^.]+$/, ''), src, frameW: strip ? img.height : img.width, frameH: img.height, fps: 8 });
      } catch (err) {
        UI.toast(`Skipped ${f.name}: ${err.message}`, { kind: 'warn' });
      }
    }
    if (added.length) {
      edit(null, () => P().sprites.push(...added));
      UI.toast(`Added ${added.length} sprite${added.length > 1 ? 's' : ''}.`, { kind: 'ok' });
      refresh();
    }
    return added;
  }

  async function uploadSprites() {
    const files = await UI.pickFiles('image/png,image/gif,image/jpeg,image/webp,image/bmp');
    return files.length ? addSpriteFiles(files) : [];
  }

  async function newBlankSprite() {
    const v = await UI.prompt('New sprite', 'Size in pixels (width x height)', '16x16', 'Create');
    const m = v && v.match(/^\s*(\d+)\s*[x×*, ]\s*(\d+)\s*$/i);
    if (!m) return;
    const w = clamp(+m[1], 1, 1024), hh = clamp(+m[2], 1, 1024);
    const s = { id: PF.uid(), name: 'Sprite ' + (P().sprites.length + 1), src: PixelEditor.blank(w, hh), frameW: w, frameH: hh, fps: 8 };
    edit(null, () => P().sprites.push(s));
    S.spriteSel = s.id;
    refresh();
    editPixels(s);
  }

  async function editPixels(s) {
    const res = await PixelEditor.open(s);
    if (!res) return;
    edit(null, () => Object.assign(s, res), 'views', 'palette', 'inspector');
  }

  function spriteUsage(id) {
    const uses = [];
    for (const t of P().tiles) if (t.sprite === id) uses.push('tile "' + t.name + '"');
    for (const o of P().objects) if (o.sprite === id || Object.values(o.props || {}).includes(id)) uses.push('object "' + o.name + '"');
    for (const l of P().levels) if (l.bgSprite === id) uses.push('level "' + l.name + '" background');
    return uses;
  }

  async function deleteSprite(s) {
    const uses = spriteUsage(s.id);
    const msg = uses.length ? `"${s.name}" is used by ${uses.join(', ')}. Delete it anyway? Those will fall back to plain colors.` : `Delete "${s.name}"?`;
    if (!(await UI.confirm('Delete sprite', msg, 'Delete', true))) return;
    edit(null, () => {
      P().sprites = P().sprites.filter(x => x !== s);
      for (const t of P().tiles) if (t.sprite === s.id) t.sprite = '';
      for (const o of P().objects) {
        if (o.sprite === s.id) o.sprite = '';
        for (const k in o.props) if (o.props[k] === s.id) o.props[k] = '';
      }
      for (const l of P().levels) if (l.bgSprite === s.id) l.bgSprite = '';
    });
    S.spriteSel = null;
    refresh();
  }

  // Creates one tile type per non-empty frame of a sprite (great for tilesets).
  function makeTilesFrom(s) {
    const sp = Sprites.get(s.id);
    if (!sp) return;
    const c = document.createElement('canvas'), ctx = c.getContext('2d', { willReadFrequently: true });
    const isEmpty = f => {
      c.width = f.w; c.height = f.h;
      ctx.clearRect(0, 0, f.w, f.h);
      ctx.drawImage(f.img, f.sx, f.sy, f.w, f.h, 0, 0, f.w, f.h);
      const d = ctx.getImageData(0, 0, f.w, f.h).data;
      for (let i = 3; i < d.length; i += 4) if (d[i]) return false;
      return true;
    };
    const fresh = [];
    let id = P().tiles.reduce((m, t) => Math.max(m, t.id), 0) + 1;
    sp.frames.forEach((f, i) => {
      if (isEmpty(f) || P().tiles.some(t => t.sprite === s.id && t.frame === i)) return;
      fresh.push({ id: id++, name: sp.frames.length > 1 ? `${s.name} ${i + 1}` : s.name, sprite: s.id, frame: i, color: '#888888', solid: true });
    });
    if (!fresh.length) return UI.toast('Every frame already has a tile.');
    edit(null, () => P().tiles.push(...fresh));
    UI.toast(`Created ${fresh.length} tile${fresh.length > 1 ? 's' : ''}. Find them in the Level view's tile palette.`, { kind: 'ok', time: 4500 });
    refresh();
  }

  async function replaceImage(s) {
    const [file] = await UI.pickFiles('image/*', false);
    if (!file) return;
    const src = await UI.readAsDataURL(file);
    edit(null, () => { s.src = src; }, 'views', 'palette');
  }

  let previewLoop = 0;
  function renderSpritesView() {
    const root = clear($('view-sprites'));
    const sprites = P().sprites;
    const grid = h('div', { class: 'asset-grid' }, sprites.map(s => {
      const meta = h('div', { class: 'asset-meta' });
      Sprites.whenReady(s.id, () => {
        const sp = Sprites.get(s.id);
        if (sp) meta.textContent = `${sp.frames.length} frame${sp.frames.length > 1 ? 's' : ''} · ${sp.w}×${sp.h}`;
      });
      return h('button', { class: 'asset-card' + (s.id === S.spriteSel ? ' active' : ''), onclick: () => { S.spriteSel = s.id; renderSpritesView(); }, ondblclick: () => editPixels(s) },
        thumb(s.id, 0, 72),
        h('div', { class: 'asset-name' }, s.name),
        meta);
    }));
    const sel = spriteDef(S.spriteSel);
    root.append(
      h('div', { class: 'asset-main' },
        h('div', { class: 'asset-toolbar' },
          h('button', { class: 'primary', onclick: uploadSprites }, 'Upload images…'),
          h('button', { onclick: newBlankSprite }, 'Draw a new sprite'),
          h('span', { class: 'muted small' }, 'Tip: drag image files onto the window. A wide image of square frames becomes an animation automatically.')),
        sprites.length ? grid : h('div', { class: 'empty' }, 'No sprites yet. Upload PNG images or draw one.')),
      h('aside', { class: 'asset-side' }, sel ? spriteDetail(sel) : h('p', { class: 'muted' }, 'Select a sprite to edit its frames, or double-click to draw on it.')));
  }

  function spriteDetail(s) {
    const sizeInfo = h('p', { class: 'muted small' });
    Sprites.whenReady(s.id, () => { const z = Sprites.size(s.id); if (z) sizeInfo.textContent = `Image: ${z.w}×${z.h}px`; });
    const preview = h('canvas', { class: 'sprite-preview', width: 128, height: 128 });
    const uses = spriteUsage(s.id);
    const loop = ++previewLoop, t0 = performance.now();
    // Starts on the next frame, once the preview canvas is on the page.
    requestAnimationFrame(function tick(now) {
      if (loop !== previewLoop || !document.body.contains(preview)) return;
      const sp = Sprites.get(s.id), ctx = preview.getContext('2d');
      ctx.clearRect(0, 0, 128, 128);
      if (sp) {
        const f = sp.frames[Math.floor(((now - t0) / 1000) * sp.fps) % sp.frames.length];
        const k = Math.max(1, Math.floor(Math.min(128 / f.w, 128 / f.h)));
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(f.img, f.sx, f.sy, f.w, f.h, (128 - f.w * k) / 2, (128 - f.h * k) / 2, f.w * k, f.h * k);
      }
      requestAnimationFrame(tick);
    });
    const setFrame = (key, v) => edit(null, () => { s[key] = clamp(Math.round(v), 1, 4096); }, 'views', 'palette');
    return h('div', null,
      h('div', { class: 'insp-kind' }, 'Sprite'),
      preview,
      UI.field('Name', UI.textInput(s.name, v => edit('sprite-name', () => { s.name = v; }))),
      sizeInfo,
      h('div', { class: 'row' },
        UI.field('Frame width', UI.numberInput(s.frameW, v => setFrame('frameW', v), { min: 1, live: false })),
        UI.field('Frame height', UI.numberInput(s.frameH, v => setFrame('frameH', v), { min: 1, live: false }))),
      UI.field('Animation speed (frames per second)', UI.numberInput(s.fps, v => edit('sprite-fps', () => { s.fps = clamp(v, 0.1, 60); }), { min: 0.1, max: 60, step: 0.5 })),
      h('div', { class: 'row wrap' },
        h('button', { class: 'primary', onclick: () => editPixels(s) }, 'Edit pixels'),
        h('button', { onclick: () => makeTilesFrom(s), title: 'Create a tile type from each frame' }, 'Make tiles'),
        h('button', { onclick: () => replaceImage(s) }, 'Replace image…'),
        h('button', { class: 'danger', onclick: () => deleteSprite(s) }, 'Delete')),
      h('p', { class: 'muted small' }, uses.length ? 'Used by ' + uses.join(', ') + '.' : 'Not used yet. Pick it as the sprite of a tile, object or level background.'));
  }

  // ---------- Sounds view ----------
  async function addSoundFiles(files) {
    const added = [];
    for (const f of files) {
      if (f.size > 15e6) { UI.toast(`${f.name} is over 15 MB. Big files make projects slow; try a shorter or compressed (OGG/MP3) version.`, { kind: 'warn', time: 6000 }); continue; }
      added.push({ id: PF.uid(), name: f.name.replace(/\.[^.]+$/, ''), src: await UI.readAsDataURL(f), size: f.size });
    }
    if (added.length) {
      edit(null, () => P().sounds.push(...added));
      UI.toast(`Added ${added.length} sound${added.length > 1 ? 's' : ''}.`, { kind: 'ok' });
      refresh();
    }
    return added;
  }

  async function uploadSounds() {
    const files = await UI.pickFiles('audio/*,.wav,.mp3,.ogg');
    return files.length ? addSoundFiles(files) : [];
  }

  function soundUsage(id) {
    const uses = [];
    for (const o of P().objects) for (const k in o.sounds) if (o.sounds[k] === id) uses.push(`"${o.name}" ${k}`);
    for (const l of P().levels) if (l.music === id) uses.push(`music of "${l.name}"`);
    return uses;
  }

  async function deleteSound(s) {
    const uses = soundUsage(s.id);
    if (!(await UI.confirm('Delete sound', `Delete "${s.name}"?${uses.length ? ' It is used by ' + uses.join(', ') + '.' : ''}`, 'Delete', true))) return;
    edit(null, () => {
      P().sounds = P().sounds.filter(x => x !== s);
      for (const o of P().objects) for (const k in o.sounds) if (o.sounds[k] === s.id) o.sounds[k] = '';
      for (const l of P().levels) if (l.music === s.id) l.music = '';
    });
    refresh();
  }

  function renderSoundsView() {
    const root = clear($('view-sounds'));
    const fmtSize = s => (s.size ? (s.size / 1024 / 1024).toFixed(2) + ' MB' : '');
    root.appendChild(h('div', { class: 'sounds-page' },
      h('div', { class: 'asset-toolbar' },
        h('button', { class: 'primary', onclick: uploadSounds }, 'Upload sounds…'),
        h('span', { class: 'muted small' }, 'WAV, MP3 or OGG. Use them as object sound effects or level music. You can also drag files onto the window.')),
      h('h3', null, 'Project sounds'),
      P().sounds.length ? h('div', { class: 'sound-list' }, P().sounds.map(s => {
        const uses = soundUsage(s.id);
        return h('div', { class: 'sound-row' },
          h('button', { class: 'icon', title: 'Play', onclick: () => previewSound(s.id) }, '▶'),
          UI.textInput(s.name, v => edit('sound-name', () => { s.name = v; })),
          h('span', { class: 'muted small' }, [fmtSize(s), uses.length ? 'used by ' + uses.join(', ') : 'not used yet'].filter(Boolean).join(' · ')),
          h('button', { class: 'danger', onclick: () => deleteSound(s) }, 'Delete'));
      })) : h('div', { class: 'empty' }, 'No sounds uploaded yet.'),
      h('h3', null, 'Built-in sounds'),
      h('p', { class: 'muted small' }, 'Generated on the fly, so they cost nothing. Pick them in any object\'s Sounds section.'),
      h('div', { class: 'synth-grid' }, Object.keys(Engine.SYNTHS).map(k =>
        h('button', { onclick: () => previewSound('synth:' + k) }, '▶ ' + k)))));
  }

  // ---------- Script view ----------
  function renderScriptView() {
    const root = clear($('view-script'));
    const ta = h('textarea', { class: 'code', spellcheck: 'false' });
    ta.value = P().script;
    ta.addEventListener('input', () => { History.record('script'); P().script = ta.value; markDirty(); });
    ta.addEventListener('keydown', e => {
      if (e.key === 'Tab') {
        e.preventDefault();
        const a = ta.selectionStart;
        ta.setRangeText('  ', a, ta.selectionEnd, 'end');
        ta.dispatchEvent(new Event('input'));
      }
    });
    const result = h('div', { class: 'small' });
    const check = () => {
      try { new Function('game', 'Engine', 'PixelForge', P().script); result.className = 'ok small'; result.textContent = 'No syntax errors found.'; }
      catch (err) { result.className = 'warn small'; result.textContent = 'Syntax error: ' + err.message; }
    };
    root.append(
      h('div', { class: 'script-main' },
        h('div', { class: 'asset-toolbar' },
          h('button', { onclick: check }, 'Check for errors'),
          h('button', { class: 'primary', onclick: () => play('level') }, '▶ Test'),
          result),
        ta),
      h('aside', { class: 'asset-side script-help' },
        h('h3', null, 'Scripting'),
        h('p', { class: 'muted small' }, 'Most games need no code. When you want custom rules, define any of these functions:'),
        h('ul', { class: 'small' },
          ['onStart(game)', 'onLevelStart(scene)', 'onUpdate(scene, dt)', 'onDraw(scene, ctx)', 'onCollect(scene, item)', 'onDeath(scene)', 'onLevelComplete(scene)']
            .map(s => h('li', null, h('code', null, s)))),
        h('h3', null, 'Useful things'),
        h('ul', { class: 'small' },
          h('li', null, h('code', null, 'scene.player'), ': x, y, vx, vy, w, h'),
          h('li', null, h('code', null, "scene.all('enemy')"), ': objects by behavior or object name'),
          h('li', null, h('code', null, 'game.state.lives'), ', ', h('code', null, 'game.state.score')),
          h('li', null, h('code', null, "game.sound.play('synth:coin')")),
          h('li', null, h('code', null, 'scene.camera.shake(3, 0.2)')),
          h('li', null, h('code', null, "Engine.text(ctx, 'Hi', 10, 10)"))),
        h('h3', null, 'Example'),
        h('pre', { class: 'small' }, `// Low gravity everywhere
function onLevelStart(scene) {
  scene.rt.gravity = 500;
}

// A 60 second timer
let time = 60;
function onUpdate(scene, dt) {
  time -= dt;
  if (time <= 0) scene.hurtPlayer();
}
function onDraw(scene, ctx) {
  Engine.text(ctx, 'TIME ' + Math.ceil(time), 6, 16);
}`)));
  }

  // ---------- Settings view ----------
  function renderSettingsView() {
    const root = clear($('view-settings')), s = P().settings;
    const set = (k, parts) => v => edit('set-' + k, () => { s[k] = v; }, ...(parts || []));
    const res = `${s.width}x${s.height}`;
    const resOptions = ['256x144', '320x180', '384x216', '480x270', '640x360', '256x224', '320x240'].map(r => ({ value: r, label: r.replace('x', ' × ') }));
    if (!resOptions.some(o => o.value === res)) resOptions.push({ value: res, label: res.replace('x', ' × ') });
    root.appendChild(h('div', { class: 'settings-page' },
      h('h2', null, 'Game settings'),
      section('General',
        UI.field('Title', UI.textInput(s.title, set('title')), 'Shown on the title screen.'),
        UI.field('Game type', UI.select([{ value: 'platformer', label: 'Platformer (side view, gravity, jumping)' }, { value: 'topdown', label: 'Top-down (move in all directions, no gravity)' }], s.mode, set('mode', ['views', 'palette', 'inspector']))),
        UI.checkbox('Show a title screen', s.showTitle, set('showTitle')),
        UI.field('Lives', UI.numberInput(s.lives, set('lives'), { min: 0, max: 99 }), '0 means unlimited.')),
      section('Screen',
        UI.field('Resolution', UI.select(resOptions, res, v => edit(null, () => { const [w, hh] = v.split('x').map(Number); s.width = w; s.height = hh; })), 'The game is drawn at this size and scaled up with crisp pixels.'),
        UI.field('Default background color', UI.colorInput(s.background, set('background')))),
      section('World',
        UI.field('Tile size', UI.select(['8', '12', '16', '24', '32'], String(s.tileSize), v => changeTileSize(+v)), 'Changing this rescales object positions to match.'),
        s.mode === 'platformer' && UI.field('Gravity', UI.numberInput(s.gravity, set('gravity'), { min: 0, max: 5000, step: 50 }), 'Default 900. Lower is floatier.')),
      Storage.desktop && section('Files',
        h('p', { class: 'muted small' }, 'Saved as ', h('code', null, S.file), ' in ', Storage.info.projectsDir),
        h('div', { class: 'row wrap' },
          h('button', { onclick: () => Storage.reveal('projects') }, 'Open projects folder'),
          h('button', { onclick: () => Storage.reveal('exports') }, 'Open exports folder')))));
  }

  function changeTileSize(size) {
    const old = ts();
    if (size === old) return;
    edit(null, () => {
      const k = size / old;
      P().settings.tileSize = size;
      for (const l of P().levels) for (const o of l.objects) { o.x = Math.round(o.x * k); o.y = Math.round(o.y * k); }
    });
    fitView();
  }

  // ---------- Playtest ----------
  async function play(mode) {
    if (!S.project || S.playing) return;
    const opts = { editor: true, onError: showPlayError };
    if (mode === 'game') {
      opts.showTitle = P().settings.showTitle;
    } else {
      Object.assign(opts, { singleLevel: true, startLevel: S.levelIndex, showTitle: false });
      const hv = S.hover, player = P().objects.find(o => o.behavior === 'player');
      if (mode === 'here' && hv && player) opts.spawn = { x: Math.round(hv.wx - player.w / 2), y: Math.round(hv.wy - player.h / 2) };
    }
    const overlay = $('playOverlay'), stage = clear($('playStage'));
    const canvas = h('canvas', { class: 'play-canvas', tabindex: 0 });
    const s = P().settings;
    canvas.style.aspectRatio = `${s.width} / ${s.height}`;
    canvas.style.width = `min(100%, calc((100vh - 90px) * ${s.width} / ${s.height}))`;
    stage.appendChild(canvas);
    $('playError').hidden = true;
    overlay.hidden = false;
    $('playTitle').textContent = mode === 'game' ? 'Playing the whole game' : `Playing "${level().name}"`;
    const session = (S.playing = { game: null });
    try {
      const game = await PF.play(clone(P()), canvas, opts);
      if (S.playing !== session) { game.destroy(); return; } // stopped while loading
      session.game = game;
      canvas.focus();
    } catch (err) {
      showPlayError(err);
    }
  }

  function showPlayError(err) {
    const el = $('playError');
    el.hidden = false;
    const fromScript = /anonymous|<anonymous>|Function/.test(String(err.stack || ''));
    el.textContent = 'The game stopped with an error:\n' + (err.message || err) + (fromScript ? '\n\nThis probably comes from the Script tab.' : '');
    console.error(err);
  }

  function stopPlay() {
    if (!S.playing) return;
    if (S.playing.game) S.playing.game.destroy();
    S.playing = null;
    $('playOverlay').hidden = true;
    clear($('playStage'));
    cv.focus();
  }

  // ---------- Help ----------
  function showHelp() {
    const row = (keys, what) => h('tr', null, h('td', null, h('kbd', null, keys)), h('td', null, what));
    UI.modal({
      title: 'PixelForge help', width: '720px',
      body: h('div', { class: 'help' },
        h('p', null, 'Pick a tile or object on the left, paint on the level, then press ', h('kbd', null, 'F5'), ' to play it. Everything autosaves for recovery, but press ', h('kbd', null, 'Ctrl+S'), ' to save for real.'),
        h('div', { class: 'help-cols' },
          h('table', null,
            row('B', 'Brush: paint tiles, place objects'), row('R', 'Rectangle fill'), row('F', 'Flood fill'), row('E', 'Eraser'),
            row('I / Alt+click', 'Pick tile or object under cursor'), row('V', 'Select and move objects'), row('Right-click', 'Erase with any tool'),
            row('Double-click', 'Select an object'), row('Delete', 'Delete selected object'), row('Ctrl+D', 'Duplicate selected object'),
            row('Arrows', 'Move selection (Shift: by a tile) or pan')),
          h('table', null,
            row('Wheel', 'Zoom at cursor'), row('Space+drag / middle drag', 'Pan the view'), row('Shift+wheel', 'Scroll sideways'),
            row('0', 'Fit level to window'), row('G', 'Toggle grid'), row('PageUp / PageDown', 'Previous / next level'),
            row('Ctrl+Z / Ctrl+Y', 'Undo / redo'), row('Ctrl+S', 'Save'), row('Ctrl+Shift+S', 'Save as'),
            row('F5', 'Play this level'), row('Shift+F5', 'Play from mouse position'), row('Ctrl+F5', 'Play whole game'), row('Esc', 'Stop playing'))),
        h('h3', null, 'How games work'),
        h('ul', null,
          h('li', null, h('strong', null, 'Tiles'), ' make the level\'s shape. Mark them solid, one-way or hazard.'),
          h('li', null, h('strong', null, 'Objects'), ' are things placed in the level. Each has a behavior (player, enemy, collectible, goal, …) with settings in the right panel.'),
          h('li', null, h('strong', null, 'Levels'), ' play in order. Reaching a goal moves on to the next one; finishing the last one wins the game.'),
          h('li', null, h('strong', null, 'Export'), ' (File menu) makes a single HTML file anyone can play in a browser.'))),
    });
  }

  // ---------- Menus & commands ----------
  function fileMenu(anchor) {
    UI.menu(anchor, [
      { label: 'New project…', onClick: newProjectDialog },
      { label: 'Open…', onClick: async () => { if (await confirmDiscard()) { S.dirty = false; showStart(); } } },
      { label: 'Import project file…', onClick: importProjectFile },
      '-',
      { label: 'Save', shortcut: 'Ctrl+S', onClick: saveProject },
      { label: 'Save as…', shortcut: 'Ctrl+Shift+S', onClick: saveAs },
      { label: 'Download project file', onClick: downloadProject },
      '-',
      { label: 'Export playable game (HTML)', onClick: exportGame },
      ...(Storage.desktop ? [{ label: 'Show projects folder', onClick: () => Storage.reveal('projects') }, { label: 'Show exports folder', onClick: () => Storage.reveal('exports') }] : []),
      '-',
      { label: 'Close project', onClick: async () => { if (await confirmDiscard()) { S.dirty = false; showStart(); } } },
    ]);
  }

  function playMenu(anchor) {
    UI.menu(anchor, [
      { label: 'Play this level', shortcut: 'F5', onClick: () => play('level') },
      { label: 'Play from last mouse position', shortcut: 'Shift+F5', onClick: () => play('here'), disabled: !S.hover },
      { label: 'Play whole game', shortcut: 'Ctrl+F5', onClick: () => play('game') },
    ]);
  }

  // Buttons with data-cmd="name" run COMMANDS[name](button).
  const COMMANDS = {
    file: btn => fileMenu(btn),
    save: () => saveProject(),
    undo: () => History.undo(),
    redo: () => History.redo(),
    play: () => play('level'),
    playMenu: btn => playMenu(btn),
    help: () => showHelp(),
    rename: () => renameProject(),
    addTile: () => addTile(),
    addObject: btn => addObjectMenu(btn),
    addLevel: () => addLevel(),
    stopPlay: () => stopPlay(),
  };
  document.addEventListener('click', e => {
    const btn = e.target.closest('[data-cmd]');
    if (btn && COMMANDS[btn.dataset.cmd]) { e.preventDefault(); COMMANDS[btn.dataset.cmd](btn); }
    const view = e.target.closest('[data-view]');
    if (view && S.project) setView(view.dataset.view);
  });

  // ---------- Keyboard shortcuts ----------
  document.addEventListener('keydown', e => {
    if (!S.project) return;
    if (S.playing) {
      if (e.key === 'Escape') { e.preventDefault(); stopPlay(); }
      if (e.key === 'F5') e.preventDefault();
      return;
    }
    if (UI.modalOpen()) return;
    const k = e.key.toLowerCase(), ctrl = e.ctrlKey || e.metaKey;
    const typing = e.target.closest && e.target.closest('input, textarea, select');
    if (ctrl && k === 's') { e.preventDefault(); e.shiftKey ? saveAs() : saveProject(); return; }
    if (e.key === 'F5') { e.preventDefault(); play(ctrl ? 'game' : e.shiftKey ? 'here' : 'level'); return; }
    if (typing) return;
    if (ctrl && k === 'z') { e.preventDefault(); e.shiftKey ? History.redo() : History.undo(); return; }
    if (ctrl && k === 'y') { e.preventDefault(); History.redo(); return; }
    if (e.key === 'F1' || e.key === '?') { e.preventDefault(); showHelp(); return; }
    if (S.view !== 'level') return;
    if (ctrl && k === 'd') { e.preventDefault(); duplicateSelection(); return; }
    if (ctrl) return;
    if (e.code === 'Space') { e.preventDefault(); if (!spaceDown) { spaceDown = true; cv.style.cursor = 'grab'; } return; }
    const tool = { b: 'brush', r: 'rect', f: 'fill', e: 'erase', i: 'pick', v: 'select' }[k];
    if (tool) { setTool(tool); return; }
    if (k === 'g') { S.grid = !S.grid; savePrefs(); refresh('toolbar'); return; }
    if (k === '0') { fitView(); return; }
    if (k === '+' || k === '=') { zoomStep(1); return; }
    if (k === '-') { zoomStep(-1); return; }
    if (e.key === 'PageUp') { e.preventDefault(); if (S.levelIndex > 0) openLevel(S.levelIndex - 1); return; }
    if (e.key === 'PageDown') { e.preventDefault(); if (S.levelIndex < P().levels.length - 1) openLevel(S.levelIndex + 1); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && S.selection) { e.preventDefault(); deleteSelection(); return; }
    if (e.key === 'Escape' && S.selection) { selectInstance(null); return; }
    const arrow = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (arrow) {
      e.preventDefault();
      const inst = S.selection && instAt(S.selection);
      if (inst) {
        const d = e.shiftKey ? ts() : 1;
        edit('nudge', () => { inst.x += arrow[0] * d; inst.y += arrow[1] * d; }, 'inspector');
      } else {
        S.panX -= arrow[0] * 48; S.panY -= arrow[1] * 48;
        requestRender();
      }
    }
  });
  document.addEventListener('keyup', e => {
    if (e.code === 'Space') { spaceDown = false; if (!drag) cv.style.cursor = ''; }
  });

  // ---------- Drag & drop files ----------
  let dragDepth = 0;
  addEventListener('dragenter', e => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { dragDepth++; $('dropHint').hidden = false; } });
  addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('dropHint').hidden = true; } });
  addEventListener('dragover', e => e.preventDefault());
  addEventListener('drop', async e => {
    e.preventDefault();
    dragDepth = 0;
    $('dropHint').hidden = true;
    const files = [...(e.dataTransfer ? e.dataTransfer.files : [])];
    if (!files.length) return;
    const projectFile = files.find(f => /\.(pixelforge|json)$/i.test(f.name));
    if (projectFile) return importProjectFromFile(projectFile);
    if (!S.project) return UI.toast('Open or create a project first, then drop images or sounds onto it.');
    const imgs = files.filter(f => f.type.startsWith('image/')), auds = files.filter(f => f.type.startsWith('audio/') || /\.(wav|mp3|ogg)$/i.test(f.name));
    if (imgs.length) await addSpriteFiles(imgs);
    if (auds.length) await addSoundFiles(auds);
    if (!imgs.length && !auds.length) UI.toast("Those files aren't images, sounds or projects.", { kind: 'warn' });
  });

  // ---------- Autosave & leaving ----------
  setInterval(() => {
    if (S.project && S.dirty && !S.playing)
      Storage.autosave.save({ file: S.file, project: S.project, time: new Date().toISOString() }).catch(() => {});
  }, 20000);

  addEventListener('beforeunload', e => {
    if (S.project && S.dirty) { e.preventDefault(); e.returnValue = ''; }
  });

  addEventListener('error', e => { if (!S.playing) UI.toast('Something went wrong: ' + e.message, { kind: 'error', time: 6000 }); });
  addEventListener('unhandledrejection', e => { if (!S.playing) UI.toast('Something went wrong: ' + ((e.reason && e.reason.message) || e.reason), { kind: 'error', time: 6000 }); });

  // ---------- Boot ----------
  (async function boot() {
    // Window icon: a pixel-art logo drawn at startup.
    const icon = document.createElement('link');
    icon.rel = 'icon';
    icon.href = logo(20).toDataURL();
    document.head.appendChild(icon);
    await Storage.init();
    showStart();
  })();

  // Exposed for debugging from the dev tools console.
  window.PixelForgeEditor = { S, History, refresh, play, stopPlay, openProject, saveProject };
})();
