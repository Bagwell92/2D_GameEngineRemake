// Small DOM helpers for the editor: element builder, modals, menus, toasts and form controls.
(function (global) {
  'use strict';

  function append(el, children) {
    for (const c of children.flat(Infinity)) {
      if (c == null || c === false) continue;
      el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  // h('div', { class: 'x', onclick: fn, style: {...} }, ...children)
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    let value;
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'value') value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    append(el, children);
    if (value !== undefined) el.value = value; // after children so <select> options exist
    return el;
  }

  const clear = el => { while (el.firstChild) el.removeChild(el.firstChild); return el; };

  // ---------- Modals ----------
  const stack = [];

  // body may be a node or a function (close) => node. Buttons: [{ label, value, primary, danger }];
  // a function value is called on click and its result becomes the modal's result.
  function modal({ title, body, buttons = [{ label: 'OK', value: true, primary: true }], width, dismissable = true, className }) {
    return new Promise(resolve => {
      const me = {};
      const close = value => {
        const i = stack.indexOf(me);
        if (i < 0) return;
        stack.splice(i, 1);
        root.remove();
        document.removeEventListener('keydown', onKey, true);
        resolve(value);
      };
      const run = b => close(typeof b.value === 'function' ? b.value() : b.value);
      const onKey = e => {
        if (stack[stack.length - 1] !== me) return;
        if (e.key === 'Escape' && dismissable) { e.preventDefault(); e.stopPropagation(); close(null); }
        else if (e.key === 'Enter' && !e.target.closest('textarea, button')) {
          const p = buttons.find(b => b.primary);
          if (p) { e.preventDefault(); run(p); }
        }
      };
      const content = typeof body === 'function' ? body(close) : body;
      const box = h('div', { class: 'modal ' + (className || ''), style: width ? { width } : null, role: 'dialog' },
        title && h('div', { class: 'modal-title' }, title),
        h('div', { class: 'modal-body' }, content),
        buttons.length > 0 && h('div', { class: 'modal-buttons' },
          buttons.map(b => h('button', { class: b.primary ? 'primary' : b.danger ? 'danger' : '', onclick: () => run(b) }, b.label))));
      const root = h('div', { class: 'modal-backdrop', onmousedown: e => { if (e.target === root && dismissable) close(null); } }, box);
      stack.push(me);
      document.addEventListener('keydown', onKey, true);
      document.body.appendChild(root);
      const focusable = box.querySelector('input, textarea, select') || box.querySelector('button.primary');
      if (focusable) setTimeout(() => { focusable.focus(); if (focusable.select) focusable.select(); }, 0);
    });
  }
  const modalOpen = () => stack.length > 0;

  function prompt(title, label, value = '', okLabel = 'OK') {
    const input = h('input', { type: 'text', value });
    return modal({
      title, body: field(label, input),
      buttons: [{ label: 'Cancel', value: null }, { label: okLabel, primary: true, value: () => input.value.trim() || null }],
    });
  }

  function confirm(title, message, okLabel = 'OK', danger = false) {
    return modal({
      title, body: h('p', null, message),
      buttons: [{ label: 'Cancel', value: false }, { label: okLabel, value: true, primary: !danger, danger }],
    }).then(v => !!v);
  }

  function alert(title, message) { return modal({ title, body: h('p', null, message) }); }

  // ---------- Menus ----------
  // items: [{ label, shortcut, onClick, disabled } | '-' for a separator]
  function menu(anchor, items) {
    const r = anchor.getBoundingClientRect();
    const el = h('div', { class: 'menu', style: { left: r.left + 'px', top: r.bottom + 4 + 'px' } },
      items.map(it => it === '-' ? h('div', { class: 'menu-sep' }) :
        h('button', { class: 'menu-item', disabled: it.disabled, onclick: () => { done(); it.onClick(); } },
          h('span', null, it.label), it.shortcut && h('span', { class: 'menu-shortcut' }, it.shortcut))));
    const done = () => { el.remove(); document.removeEventListener('mousedown', outside, true); document.removeEventListener('keydown', esc, true); };
    const outside = e => { if (!el.contains(e.target)) done(); };
    const esc = e => { if (e.key === 'Escape') { e.stopPropagation(); done(); } };
    document.body.appendChild(el);
    // Keep the menu on screen.
    const mr = el.getBoundingClientRect();
    if (mr.right > innerWidth - 8) el.style.left = Math.max(8, innerWidth - mr.width - 8) + 'px';
    setTimeout(() => { document.addEventListener('mousedown', outside, true); document.addEventListener('keydown', esc, true); }, 0);
  }

  // ---------- Toasts ----------
  function toast(message, { kind = 'info', action, time = 3500 } = {}) {
    let root = document.getElementById('toasts');
    if (!root) { root = h('div', { id: 'toasts' }); document.body.appendChild(root); }
    const el = h('div', { class: 'toast ' + kind }, h('span', null, message),
      action && h('button', { onclick: () => { action.onClick(); el.remove(); } }, action.label));
    root.appendChild(el);
    setTimeout(() => el.classList.add('hide'), time);
    setTimeout(() => el.remove(), time + 400);
  }

  // ---------- Form controls ----------
  function field(label, control, hint) {
    return h('div', { class: 'field' },
      h('label', { class: 'field-label' }, label),
      h('div', { class: 'field-control' }, control),
      hint && h('div', { class: 'field-hint' }, hint));
  }

  // live: fire onChange on every keystroke; otherwise only when the value is committed (blur/Enter).
  function numberInput(value, onChange, { min, max, step = 1, live = true } = {}) {
    const el = h('input', { type: 'number', value: String(value), min, max, step });
    const read = commit => {
      let v = parseFloat(el.value);
      if (isNaN(v)) return;
      if (commit) {
        if (min != null) v = Math.max(min, v);
        if (max != null) v = Math.min(max, v);
        el.value = String(v);
      }
      onChange(v);
    };
    if (live) el.addEventListener('input', () => read(false));
    el.addEventListener('change', () => read(true));
    return el;
  }

  function textInput(value, onChange, { placeholder, live = true } = {}) {
    const el = h('input', { type: 'text', value: value || '', placeholder });
    el.addEventListener(live ? 'input' : 'change', () => onChange(el.value));
    return el;
  }

  function textArea(value, onChange, { rows = 3 } = {}) {
    const el = h('textarea', { rows }, value || '');
    el.addEventListener('input', () => onChange(el.value));
    return el;
  }

  function colorInput(value, onChange) {
    const el = h('input', { type: 'color', value: value || '#000000' });
    el.addEventListener('input', () => onChange(el.value));
    return el;
  }

  function checkbox(label, checked, onChange) {
    const input = h('input', { type: 'checkbox', checked });
    input.addEventListener('change', () => onChange(input.checked));
    return h('label', { class: 'check' }, input, h('span', null, label));
  }

  // options: [{ value, label, group }] or plain strings.
  function select(options, value, onChange) {
    const el = h('select');
    const groups = new Map();
    for (const o of options) {
      const opt = typeof o === 'string' ? { value: o, label: o } : o;
      const node = h('option', { value: opt.value }, opt.label);
      if (opt.group) {
        if (!groups.has(opt.group)) { const g = h('optgroup', { label: opt.group }); groups.set(opt.group, g); el.appendChild(g); }
        groups.get(opt.group).appendChild(node);
      } else el.appendChild(node);
    }
    el.value = value == null ? '' : value;
    el.addEventListener('change', () => onChange(el.value));
    return el;
  }

  // Opens the OS file picker. Resolves to an array of File objects (empty if cancelled).
  function pickFiles(accept, multiple = true) {
    return new Promise(resolve => {
      const input = h('input', { type: 'file', accept, multiple, style: { display: 'none' } });
      input.addEventListener('change', () => { resolve([...input.files]); input.remove(); });
      document.body.appendChild(input);
      input.click();
    });
  }

  const readAsDataURL = file => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
  const readAsText = file => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsText(file); });

  function timeAgo(date) {
    const s = (Date.now() - new Date(date).getTime()) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    return new Date(date).toLocaleDateString();
  }

  global.UI = {
    h, append, clear, modal, modalOpen, prompt, confirm, alert, menu, toast,
    field, numberInput, textInput, textArea, colorInput, checkbox, select,
    pickFiles, readAsDataURL, readAsText, timeAgo,
  };
})(window);
