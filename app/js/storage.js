// Project storage. In the Windows app, projects are real files in Documents\PixelForge (through the
// launcher's local API). In a plain browser, they live in IndexedDB and can be downloaded/imported.
(function (global) {
  'use strict';

  const EXT = '.pixelforge';

  async function api(method, path, body) {
    const res = await fetch('/api/' + path, {
      method,
      headers: { 'X-PixelForge': '1', 'Content-Type': 'application/json; charset=utf-8' },
      body: body == null ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    if (!res.ok) throw new Error((await res.text()) || res.statusText);
    const type = res.headers.get('Content-Type') || '';
    return type.includes('json') ? res.json() : res.text();
  }

  // ---------- Tiny IndexedDB key-value store (browser mode) ----------
  let dbPromise = null;
  function db() {
    if (!dbPromise) dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('pixelforge', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }
  async function kv(mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const tx = d.transaction('kv', mode), store = tx.objectStore('kv');
      const req = fn(store);
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
    });
  }
  const kvGet = key => kv('readonly', s => s.get(key));
  const kvSet = (key, value) => kv('readwrite', s => s.put(value, key));
  const kvDel = key => kv('readwrite', s => s.delete(key));

  // Turns a project name into a safe file name.
  function fileNameFor(name) {
    const base = String(name || 'Untitled').replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Untitled';
    return base + EXT;
  }

  function download(name, content, mime = 'application/octet-stream') {
    const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  const Storage = {
    desktop: false,
    info: null,
    EXT,
    fileNameFor,
    download,

    async init() {
      try {
        this.info = await api('GET', 'info');
        this.desktop = !!this.info.desktop;
      } catch (e) {
        this.desktop = false;
      }
      if (this.desktop) {
        // Lets the launcher know the window is still open, so it can shut down when it closes.
        setInterval(() => api('GET', 'ping').catch(() => {}), 5000);
      }
    },

    // [{ file, name, modified }] newest first.
    async list() {
      if (this.desktop) return api('GET', 'projects');
      const index = (await kvGet('index')) || [];
      return index.sort((a, b) => b.modified.localeCompare(a.modified));
    },

    async exists(file) {
      return (await this.list()).some(p => p.file.toLowerCase() === file.toLowerCase());
    },

    // Picks a file name that isn't used yet: "Name.pixelforge", "Name 2.pixelforge", ...
    async uniqueFile(name) {
      const taken = new Set((await this.list()).map(p => p.file.toLowerCase()));
      let file = fileNameFor(name), n = 2;
      while (taken.has(file.toLowerCase())) file = fileNameFor(name + ' ' + n++);
      return file;
    },

    async load(file) {
      if (this.desktop) {
        const r = await api('GET', 'project?file=' + encodeURIComponent(file));
        return typeof r === 'string' ? JSON.parse(r) : r;
      }
      const data = await kvGet('project:' + file);
      if (!data) throw new Error('Project not found: ' + file);
      return data;
    },

    async save(file, project) {
      const json = JSON.stringify(project);
      if (this.desktop) return api('POST', 'project?file=' + encodeURIComponent(file), json);
      await kvSet('project:' + file, JSON.parse(json));
      const index = ((await kvGet('index')) || []).filter(p => p.file !== file);
      index.push({ file, name: project.name, modified: new Date().toISOString() });
      await kvSet('index', index);
    },

    // Desktop: moves the file to the Recycle Bin. Browser: deletes it from IndexedDB.
    async remove(file) {
      if (this.desktop) return api('DELETE', 'project?file=' + encodeURIComponent(file));
      await kvDel('project:' + file);
      await kvSet('index', ((await kvGet('index')) || []).filter(p => p.file !== file));
    },

    autosave: {
      async save(data) {
        if (Storage.desktop) return api('POST', 'autosave', JSON.stringify(data));
        return kvSet('autosave', data);
      },
      async load() {
        try {
          if (Storage.desktop) { const t = await api('GET', 'autosave'); return t ? (typeof t === 'string' ? JSON.parse(t) : t) : null; }
          return (await kvGet('autosave')) || null;
        } catch (e) { return null; }
      },
      async clear() {
        try { if (Storage.desktop) await api('DELETE', 'autosave'); else await kvDel('autosave'); } catch (e) { /* nothing to clear */ }
      },
    },

    // Saves a standalone game. Desktop: writes Documents\PixelForge\Exports\<name>. Resolves to the path.
    async exportGame(fileName, html) {
      if (this.desktop) return (await api('POST', 'export?file=' + encodeURIComponent(fileName), html)).path;
      download(fileName, html, 'text/html');
      return null;
    },

    // Opens a folder (or selects a file) in Explorer. what: 'projects' | 'exports' | a full path.
    reveal(what) { if (this.desktop) return api('POST', 'reveal?target=' + encodeURIComponent(what)); },
  };

  global.Storage = Storage;
})(window);
