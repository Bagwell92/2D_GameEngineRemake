// Pixel editor: draw or touch up sprite images, including multi-frame sprite strips.
(function (global) {
  'use strict';
  const { h } = UI;

  const PALETTE = [
    '#1a1c2c', '#5d275d', '#b13e53', '#ef7d57', '#ffcd75', '#a7f070', '#38b764', '#257179',
    '#29366f', '#3b5dc9', '#41a6f6', '#73eff7', '#f4f4f4', '#94b0c2', '#566c86', '#333c57',
    '#000000', '#ffffff', '#8b5a2b', '#e43b44',
  ];

  // Opens the editor for a sprite definition. Resolves to { src, frameW, frameH } on save, or null.
  function open(def) {
    return new Promise(resolve => {
      const img = new Image();
      img.onload = () => resolve(run(def, img));
      img.onerror = () => resolve(null);
      img.src = def.src;
    });
  }

  function run(def, img) {
    const work = document.createElement('canvas');
    work.width = img.width; work.height = img.height;
    const wctx = work.getContext('2d', { willReadFrequently: true });
    wctx.drawImage(img, 0, 0);
    let fw = Math.min(def.frameW || img.width, img.width), fh = Math.min(def.frameH || img.height, img.height);
    let color = '#1a1c2c', tool = 'pencil';
    let zoom = Math.max(1, Math.min(32, Math.floor(Math.min(620 / work.width, 400 / work.height))));
    const undo = [], redo = [];

    const view = h('canvas', { class: 'px-canvas' });
    const vctx = view.getContext('2d');
    const preview = h('canvas', { class: 'px-preview', width: 64, height: 64 });
    const info = h('span', { class: 'muted' });
    const colorInput = h('input', { type: 'color', value: color });
    colorInput.addEventListener('input', () => { color = colorInput.value; renderSwatches(); });
    const swatches = h('div', { class: 'px-swatches' });

    const snapshot = () => ({ data: wctx.getImageData(0, 0, work.width, work.height), fw, fh });
    const restore = s => {
      work.width = s.data.width; work.height = s.data.height;
      wctx.putImageData(s.data, 0, 0);
      fw = s.fw; fh = s.fh;
      layout();
    };
    const record = () => { undo.push(snapshot()); if (undo.length > 60) undo.shift(); redo.length = 0; };
    const doUndo = () => { if (undo.length) { redo.push(snapshot()); restore(undo.pop()); } };
    const doRedo = () => { if (redo.length) { undo.push(snapshot()); restore(redo.pop()); } };

    // ---------- Drawing ----------
    function layout() {
      view.width = work.width * zoom;
      view.height = work.height * zoom;
      info.textContent = `${work.width}×${work.height}px · frame ${fw}×${fh} · ${frameCount()} frame(s) · zoom ${zoom}×`;
      render();
    }
    function frameCount() { return Math.max(1, Math.floor(work.width / fw) * Math.floor(work.height / fh)); }
    function render() {
      const W = view.width, H = view.height, cell = Math.max(4, zoom);
      for (let y = 0; y < H; y += cell)
        for (let x = 0; x < W; x += cell) {
          vctx.fillStyle = ((x + y) / cell) % 2 ? '#2b2d3c' : '#373a4d';
          vctx.fillRect(x, y, cell, cell);
        }
      vctx.imageSmoothingEnabled = false;
      vctx.drawImage(work, 0, 0, W, H);
      if (zoom >= 8) {
        vctx.fillStyle = 'rgba(255,255,255,0.08)';
        for (let x = 0; x <= work.width; x++) vctx.fillRect(x * zoom, 0, 1, H);
        for (let y = 0; y <= work.height; y++) vctx.fillRect(0, y * zoom, W, 1);
      }
      vctx.fillStyle = 'rgba(91,140,255,0.8)';
      for (let x = fw; x < work.width; x += fw) vctx.fillRect(x * zoom - 1, 0, 2, H);
      for (let y = fh; y < work.height; y += fh) vctx.fillRect(0, y * zoom - 1, W, 2);
    }
    function renderSwatches() {
      UI.clear(swatches);
      for (const c of PALETTE)
        swatches.appendChild(h('button', {
          class: 'px-swatch' + (c === color ? ' active' : ''), style: { background: c }, title: c,
          onclick: () => { color = c; colorInput.value = c; renderSwatches(); if (tool === 'eraser' || tool === 'picker') setTool('pencil'); },
        }));
    }

    const hexToRgba = hex => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16), 255];
    function plot(x, y, erase) {
      if (x < 0 || y < 0 || x >= work.width || y >= work.height) return;
      if (erase) wctx.clearRect(x, y, 1, 1);
      else { wctx.fillStyle = color; wctx.fillRect(x, y, 1, 1); }
    }
    function line(x0, y0, x1, y1, erase) {
      const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
      let err = dx + dy;
      for (;;) {
        plot(x0, y0, erase);
        if (x0 === x1 && y0 === y1) break;
        const e2 = 2 * err;
        if (e2 >= dy) { err += dy; x0 += sx; }
        if (e2 <= dx) { err += dx; y0 += sy; }
      }
    }
    function flood(x, y, erase) {
      const W = work.width, H = work.height, img = wctx.getImageData(0, 0, W, H), d = img.data;
      const at = (x, y) => (y * W + x) * 4;
      const target = d.slice(at(x, y), at(x, y) + 4);
      const fill = erase ? [0, 0, 0, 0] : hexToRgba(color);
      if (target.every((v, i) => v === fill[i])) return;
      const same = i => d[i] === target[0] && d[i + 1] === target[1] && d[i + 2] === target[2] && d[i + 3] === target[3];
      const stack = [[x, y]];
      while (stack.length) {
        const [cx, cy] = stack.pop();
        if (cx < 0 || cy < 0 || cx >= W || cy >= H) continue;
        const i = at(cx, cy);
        if (!same(i)) continue;
        d[i] = fill[0]; d[i + 1] = fill[1]; d[i + 2] = fill[2]; d[i + 3] = fill[3];
        stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
      }
      wctx.putImageData(img, 0, 0);
    }

    let stroke = null;
    const pixelAt = e => {
      const r = view.getBoundingClientRect();
      return [Math.floor(((e.clientX - r.left) / r.width) * work.width), Math.floor(((e.clientY - r.top) / r.height) * work.height)];
    };
    view.addEventListener('contextmenu', e => e.preventDefault());
    view.addEventListener('pointerdown', e => {
      const [x, y] = pixelAt(e), erase = e.button === 2 || tool === 'eraser';
      if (tool === 'picker' && e.button === 0) {
        const d = wctx.getImageData(x, y, 1, 1).data;
        if (d[3] > 0) { color = '#' + [d[0], d[1], d[2]].map(v => v.toString(16).padStart(2, '0')).join(''); colorInput.value = color; renderSwatches(); setTool('pencil'); }
        return;
      }
      record();
      if (tool === 'fill') { flood(x, y, erase); render(); return; }
      view.setPointerCapture(e.pointerId);
      stroke = { x, y, erase };
      plot(x, y, erase);
      render();
    });
    view.addEventListener('pointermove', e => {
      if (!stroke) return;
      const [x, y] = pixelAt(e);
      line(stroke.x, stroke.y, x, y, stroke.erase);
      stroke.x = x; stroke.y = y;
      render();
    });
    const endStroke = () => { stroke = null; };
    view.addEventListener('pointerup', endStroke);
    view.addEventListener('pointercancel', endStroke);
    view.addEventListener('wheel', e => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setZoom(zoom + (e.deltaY < 0 ? 1 : -1));
    }, { passive: false });

    // ---------- Frames & canvas size ----------
    function resizeTo(nw, nh, copyLastFrame) {
      const old = wctx.getImageData(0, 0, work.width, work.height), ow = work.width;
      work.width = nw; work.height = nh;
      wctx.putImageData(old, 0, 0);
      if (copyLastFrame) wctx.drawImage(work, ow - fw, 0, fw, fh, ow, 0, fw, fh);
    }
    function addFrame() {
      if (work.height !== fh) return UI.toast('Adding frames works on single-row sprite strips.', { kind: 'warn' });
      record();
      resizeTo(work.width + fw, work.height, true);
      layout();
    }
    function removeFrame() {
      if (work.height !== fh || work.width <= fw) return;
      record();
      resizeTo(work.width - fw, work.height, false);
      layout();
    }
    async function resizeCanvas() {
      const v = await UI.prompt('Resize canvas', 'New size (width x height, in pixels)', `${work.width}x${work.height}`, 'Resize');
      const m = v && v.match(/^\s*(\d+)\s*[x×*, ]\s*(\d+)\s*$/i);
      if (!m) return;
      const nw = Math.min(1024, Math.max(1, +m[1])), nh = Math.min(1024, Math.max(1, +m[2]));
      record();
      // Keep frames intact when the strip is resized: frame size follows a single-frame image.
      const single = frameCount() === 1;
      resizeTo(nw, nh, false);
      if (single) { fw = nw; fh = nh; } else { fw = Math.min(fw, nw); fh = Math.min(fh, nh); }
      layout();
    }
    function flipFrame() {
      record();
      const n = Math.floor(work.width / fw), m = Math.floor(work.height / fh);
      const copy = document.createElement('canvas');
      copy.width = work.width; copy.height = work.height;
      copy.getContext('2d').drawImage(work, 0, 0);
      wctx.clearRect(0, 0, work.width, work.height);
      for (let j = 0; j < m; j++)
        for (let i = 0; i < n; i++) {
          wctx.save();
          wctx.translate(i * fw + fw, j * fh);
          wctx.scale(-1, 1);
          wctx.drawImage(copy, i * fw, j * fh, fw, fh, 0, 0, fw, fh);
          wctx.restore();
        }
      render();
    }

    // ---------- Tools ----------
    const toolButtons = {};
    const TOOLS = [['pencil', 'Pencil', 'B'], ['eraser', 'Eraser', 'E'], ['fill', 'Fill', 'F'], ['picker', 'Color picker', 'I']];
    function setTool(t) {
      tool = t;
      for (const [k, b] of Object.entries(toolButtons)) b.classList.toggle('active', k === t);
    }
    function setZoom(z) { zoom = Math.max(1, Math.min(48, z)); layout(); }

    const bar = h('div', { class: 'px-toolbar' },
      TOOLS.map(([k, label, key]) => (toolButtons[k] = h('button', { title: `${label} (${key})`, onclick: () => setTool(k) }, label))),
      h('span', { class: 'sep' }),
      h('button', { title: 'Undo (Ctrl+Z)', onclick: doUndo }, 'Undo'),
      h('button', { title: 'Redo (Ctrl+Y)', onclick: doRedo }, 'Redo'),
      h('span', { class: 'sep' }),
      h('button', { onclick: () => setZoom(zoom - 1), title: 'Zoom out (Ctrl+wheel)' }, '−'),
      h('button', { onclick: () => setZoom(zoom + 1), title: 'Zoom in (Ctrl+wheel)' }, '+'),
      h('span', { class: 'sep' }),
      h('button', { onclick: addFrame, title: 'Append a copy of the last frame' }, '+ Frame'),
      h('button', { onclick: removeFrame, title: 'Remove the last frame' }, '− Frame'),
      h('button', { onclick: flipFrame, title: 'Mirror every frame horizontally' }, 'Flip'),
      h('button', { onclick: resizeCanvas }, 'Resize…'));

    const body = h('div', { class: 'px-editor' },
      bar,
      h('div', { class: 'px-main' },
        h('div', { class: 'px-stage' }, view),
        h('div', { class: 'px-side' },
          h('div', { class: 'field-label' }, 'Color'), colorInput, swatches,
          h('div', { class: 'field-label', style: { marginTop: '12px' } }, 'Animation preview'), preview,
          h('p', { class: 'muted small' }, 'Left click draws, right click erases. Blue lines mark frame edges.'))),
      info);

    const onKey = e => {
      if (e.target.closest('input, textarea')) return;
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); }
      else if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); doRedo(); }
      else if (!e.ctrlKey && !e.metaKey) {
        const t = { b: 'pencil', p: 'pencil', e: 'eraser', f: 'fill', g: 'fill', i: 'picker' }[k];
        if (t) setTool(t);
      }
    };
    document.addEventListener('keydown', onKey);

    // Animated preview of the frames.
    let start = performance.now();
    const pctx = preview.getContext('2d');
    (function tick(now) {
      if (!document.body.contains(preview) && now - start > 1000) return;
      const n = frameCount(), perRow = Math.max(1, Math.floor(work.width / fw));
      const i = Math.floor(((now - start) / 1000) * (def.fps || 8)) % n;
      const s = Math.max(1, Math.floor(64 / Math.max(fw, fh)));
      pctx.clearRect(0, 0, 64, 64);
      pctx.imageSmoothingEnabled = false;
      pctx.drawImage(work, (i % perRow) * fw, Math.floor(i / perRow) * fh, fw, fh, (64 - fw * s) / 2, (64 - fh * s) / 2, fw * s, fh * s);
      requestAnimationFrame(tick);
    })(start);

    setTool('pencil');
    renderSwatches();
    layout();

    const result = UI.modal({
      title: 'Pixel editor: ' + def.name, className: 'px-modal', dismissable: false, body,
      buttons: [{ label: 'Cancel', value: null }, { label: 'Save sprite', primary: true, value: () => ({ src: work.toDataURL('image/png'), frameW: fw, frameH: fh }) }],
    });
    result.then(() => document.removeEventListener('keydown', onKey));
    return result;
  }

  // Creates a transparent image of the given size as a data URL.
  function blank(w, hgt) {
    const c = document.createElement('canvas');
    c.width = w; c.height = hgt;
    return c.toDataURL('image/png');
  }

  global.PixelEditor = { open, blank, PALETTE };
})(window);
