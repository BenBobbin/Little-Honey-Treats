/*
 * Gives the page the same small "database / downloads / assets" interface it was
 * first built against, but backed by this server instead of the Claude artifact runtime.
 * Records are cached in memory, written through to the server, and kept in sync across
 * devices with a live event stream.
 */
(function () {
  'use strict';
  const HDR = { 'X-Requested-With': 'books' };
  const caches = {};      // coll -> Map(id -> data)
  const loading = {};     // coll -> Promise
  const collListeners = {}; // coll -> Set(fn)
  const docListeners = {};  // coll/id -> Set(fn)

  function fail(res) {
    if (res.status === 401) { location.href = '/login'; }
    const e = new Error('HTTP ' + res.status);
    e.code = res.status === 413 ? 'quota_exceeded' : 'http_error';
    return e;
  }
  async function api(method, url, body, extra) {
    const res = await fetch(url, {
      method, credentials: 'same-origin', body,
      headers: Object.assign({}, HDR, extra || {}),
    });
    if (!res.ok) throw fail(res);
    return res.json();
  }
  const clone = (o) => JSON.parse(JSON.stringify(o));

  function collSnap(coll) {
    const m = caches[coll] || new Map();
    return { docs: Array.from(m, ([id, data]) => ({ id, exists: true, data: () => clone(data) })) };
  }
  function docSnap(coll, id) {
    const m = caches[coll], has = !!m && m.has(id);
    return { id, exists: has, data: () => (has ? clone(m.get(id)) : undefined) };
  }
  function notify(coll, id) {
    (collListeners[coll] || []).forEach((fn) => { try { fn(collSnap(coll)); } catch (e) { console.error(e); } });
    (docListeners[coll + '/' + id] || []).forEach((fn) => { try { fn(docSnap(coll, id)); } catch (e) { console.error(e); } });
  }
  function notifyAll(coll) {
    (collListeners[coll] || []).forEach((fn) => fn(collSnap(coll)));
    Object.keys(docListeners).filter((k) => k.startsWith(coll + '/')).forEach((k) => {
      const id = k.slice(coll.length + 1);
      docListeners[k].forEach((fn) => fn(docSnap(coll, id)));
    });
  }
  function load(coll, force) {
    if (!force && loading[coll]) return loading[coll];
    loading[coll] = api('GET', '/api/c/' + coll).then((rows) => {
      caches[coll] = new Map(rows.map((r) => [r.id, r.data]));
      notifyAll(coll);
    });
    loading[coll].catch(() => { delete loading[coll]; });
    return loading[coll];
  }

  /* live updates from other devices */
  let opened = false;
  function connect() {
    if (typeof EventSource === 'undefined') return;
    const es = new EventSource('/api/events');
    es.onopen = () => {
      if (opened) Object.keys(loading).forEach((c) => load(c, true).catch(() => {})); // catch up after a drop
      opened = true;
    };
    es.onmessage = (ev) => {
      let e; try { e = JSON.parse(ev.data); } catch { return; }
      const m = caches[e.coll]; if (!m) return;
      if (e.deleted) m.delete(e.id); else m.set(e.id, e.data);
      notify(e.coll, e.id);
    };
  }

  function newId() {
    const a = new Uint8Array(15); crypto.getRandomValues(a);
    return Array.from(a, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 20);
  }

  function docRef(coll, id) {
    id = id || newId();
    return {
      id,
      async set(obj) {
        await load(coll);
        const m = caches[coll], prev = m.get(id), body = clone(obj);
        m.set(id, body); notify(coll, id);
        try { await api('PUT', '/api/c/' + coll + '/' + id, JSON.stringify(body), { 'Content-Type': 'application/json' }); }
        catch (e) { if (prev === undefined) m.delete(id); else m.set(id, prev); notify(coll, id); throw e; }
      },
      async delete() {
        await load(coll);
        const m = caches[coll], prev = m.get(id);
        m.delete(id); notify(coll, id);
        try { await api('DELETE', '/api/c/' + coll + '/' + id); }
        catch (e) { if (prev !== undefined) m.set(id, prev); notify(coll, id); throw e; }
      },
      onSnapshot(cb, errCb) {
        const k = coll + '/' + id;
        (docListeners[k] = docListeners[k] || new Set()).add(cb);
        load(coll).then(() => cb(docSnap(coll, id)), (e) => errCb && errCb(e));
        return () => docListeners[k].delete(cb);
      },
    };
  }
  const database = {
    collection: (coll) => ({
      doc: (id) => docRef(coll, id),
      onSnapshot(cb, errCb) {
        (collListeners[coll] = collListeners[coll] || new Set()).add(cb);
        load(coll).then(() => cb(collSnap(coll)), (e) => errCb && errCb(e));
        return () => collListeners[coll].delete(cb);
      },
    }),
    doc(path) { const [c, i] = path.split('/'); return docRef(c, i); },
  };

  const TYPES = { csv: 'text/csv;charset=utf-8', json: 'application/json', html: 'text/html;charset=utf-8', txt: 'text/plain;charset=utf-8' };
  const downloads = {
    async save({ filename, data }) {
      const ext = String(filename).split('.').pop().toLowerCase();
      const blob = data instanceof Blob ? data : new Blob([data], { type: TYPES[ext] || 'application/octet-stream' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    },
  };

  const assets = {
    async upload(file) {
      const r = await api('PUT', '/api/blob', file, {
        'Content-Type': file.type || 'application/octet-stream',
        'X-Filename': encodeURIComponent(file.name || 'receipt'),
      });
      return { id: r.id, url: r.url };
    },
  };

  const features = { db: database, downloads, assets };
  window.claude = { use: async (name) => features[name] || null };
  connect();
})();
