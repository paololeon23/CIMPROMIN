const CACHE_NAME = "cocina-qb-v242";

const SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./css/app.css",
  "./js/app.js",
  "./js/config.js",
  "./js/device.js",
  "./js/store.js",
  "./js/voice.js",
  "./js/calc.js",
  "./js/sync.js",
  "./js/scanner.js",
  "./data/config.json",
  "./data/supervisors.json",
  "./assets/logo-qberries.png",
  "./icons/icon-192.png",
  "./icons/apple-touch-icon.png",
];

const LATER = [
  "./js/vendor/jsqr.js",
  "./data/trabajadores.json",
  "./icons/icon-512.png",
  "./assets/hombre.png",
  "./assets/mujer.png",
];

const PRECACHE = SHELL.concat(LATER);

function sameOrigin(url) {
  return url.origin === self.location.origin;
}

function wantsNetwork(req) {
  return req.cache === "reload" || req.cache === "no-store";
}

function netFetch(req, ms = 4000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(req, { signal: ctrl.signal }).finally(() => clearTimeout(t));
}

async function copyOldCaches(dest) {
  const keys = await caches.keys();
  for (const key of keys) {
    if (key === CACHE_NAME) continue;
    const src = await caches.open(key);
    const reqs = await src.keys();
    await Promise.all(reqs.map(async (r) => {
      const res = await src.match(r);
      if (res) await dest.put(r, res.clone());
    }));
  }
}

async function putFresh(cache, path) {
  try {
    const res = await fetch(path, { cache: "reload" });
    if (res.ok) await cache.put(path, res);
  } catch {
    /* sin red: se queda lo copiado */
  }
}

async function hasShell(cache) {
  const html = (await cache.match("./index.html")) || (await cache.match("./"));
  const js = await cache.match("./js/app.js");
  return !!(html && js);
}

async function refreshPrecache() {
  const cache = await caches.open(CACHE_NAME);
  await copyOldCaches(cache);
  await Promise.all(PRECACHE.map((path) => putFresh(cache, path)));
  return cache;
}

async function fromCache(req) {
  const hit = await caches.match(req, { ignoreSearch: true, ignoreVary: true });
  if (hit) return hit;
  if (req.mode === "navigate") {
    return (await caches.match("./index.html")) || (await caches.match("./"));
  }
  return undefined;
}

function putInCache(req, res) {
  if (!res || !res.ok) return;
  const copy = res.clone();
  caches.open(CACHE_NAME).then((c) => c.put(req, copy));
}

let restJob = null;
function fillRest() {
  if (restJob) return restJob;
  restJob = (async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(LATER.map((path) => putFresh(cache, path)));
    const ready = await Promise.all(LATER.map((path) => cache.match(path)));
    if (!ready.every(Boolean)) return;
    const clients = await self.clients.matchAll({ includeUncontrolled: true, type: "window" });
    for (const client of clients) client.postMessage("WARM_REST_OK");
  })().finally(() => {
    restJob = null;
  });
  return restJob;
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await copyOldCaches(cache);
    await Promise.all(SHELL.map((path) => putFresh(cache, path)));
    if (await hasShell(cache)) await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    if (await hasShell(cache)) {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)));
    }
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (!sameOrigin(url)) return;

  const offline = self.navigator && self.navigator.onLine === false;
  const missed = () => new Response("", { status: 504, statusText: "offline" });

  if (wantsNetwork(req)) {
    event.respondWith(
      offline
        ? fromCache(req).then((hit) => hit || missed())
        : fetch(req)
          .then((res) => {
            putInCache(req, res);
            return res;
          })
          .catch(() => fromCache(req).then((hit) => hit || missed()))
    );
    return;
  }

  event.respondWith((async () => {
    const hit = await fromCache(req);
    if (hit) return hit;
    if (offline) return missed();
    try {
      const res = await netFetch(req);
      putInCache(req, res);
      return res;
    } catch {
      return (await fromCache(req)) || missed();
    }
  })());
});

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
  if (event.data === "CLEAR_APP_CACHE") {
    event.waitUntil(
      caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
    );
  }
  if (event.data === "PULL_LATEST") {
    event.waitUntil(refreshPrecache());
  }
  if (event.data === "WARM_REST") {
    event.waitUntil(fillRest());
  }
});

const OUTBOX_TAG = "cocina-pendientes";
const OUTBOX_DB = "cocina-qb";
const OUTBOX_DB_VER = 2;

function outboxOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(OUTBOX_DB, OUTBOX_DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
      if (!db.objectStoreNames.contains("sesion")) db.createObjectStore("sesion");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function outboxGet(db, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("kv", "readonly");
    const req = tx.objectStore("kv").get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function outboxPut(db, key, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("kv", "readwrite");
    tx.objectStore("kv").put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function outboxRank(record) {
  if (record?.type === "lista" && !record.payload?.extra) return 0;
  if (record?.type === "extra" || record?.payload?.extra) return 1;
  return 2;
}

function outboxConfirmed(json, record) {
  if (!json || json.ok !== true) return false;
  const isExtra = record?.type === "extra" || record?.payload?.extra;
  if (isExtra && (json.error === "sin_almuerzo" || (json.extra === false && Number(json.trabajadores || 0) === 0))) {
    return false;
  }
  return json.saved === true || json.duplicate === true
    || typeof json.total === "number" || typeof json.trabajadores === "number";
}

async function flushClosedApp() {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  if (windows.some((client) => client.visibilityState === "visible")) return;
  const db = await outboxOpen();
  let uploaded = 0;
  try {
    const busy = await outboxGet(db, "page_flush_at");
    if (typeof busy === "number" && Date.now() - busy < 8000) {
      throw new Error("page_activa");
    }
    const colaWrap = await outboxGet(db, "cola_pendiente");
    const cola = Array.isArray(colaWrap?.list) ? colaWrap.list.slice() : [];
    const pending = cola
      .filter((record) => record && (record.type === "lista" || record.type === "extra" || record.type === "cierre"))
      .sort((a, b) => outboxRank(a) - outboxRank(b) || (a.createdAt || 0) - (b.createdAt || 0));
    if (!pending.length) return;
    let url = await outboxGet(db, "apps_script_url");
    if (typeof url !== "string" || !url.trim()) {
      const cached = await caches.match("./data/config.json");
      if (cached) url = String((await cached.json())?.appsScriptUrl || "");
    }
    url = String(url || "").trim();
    if (!url) throw new Error("sin_url");
    const doneWrap = await outboxGet(db, "cola_confirmados");
    let done = Array.isArray(doneWrap?.items) ? doneWrap.items.slice() : [];
    const doneIds = new Set(done.map((item) => item && item.clientId).filter(Boolean));
    for (const record of pending) {
      if (self.navigator && self.navigator.onLine === false) throw new Error("sin_red");
      if (!record.clientId || doneIds.has(record.clientId)) continue;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 45000);
      let json;
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "text/plain;charset=utf-8" },
          body: JSON.stringify({
            type: record.type,
            clientId: record.clientId,
            payload: record.payload || {},
            clientVersion: "1.3.82",
          }),
          cache: "no-store",
          signal: ctrl.signal,
        });
        if (!res.ok) throw new Error(`http_${res.status}`);
        json = await res.json();
      } finally {
        clearTimeout(timer);
      }
      if (!outboxConfirmed(json, record)) {
        if (json?.error === "sin_almuerzo") continue;
        throw new Error(json?.error || "sin_confirmacion");
      }
      done.push({ clientId: record.clientId, duplicate: !!json.duplicate, at: Date.now() });
      doneIds.add(record.clientId);
      uploaded += 1;
      await outboxPut(db, "cola_confirmados", { at: Date.now(), items: done.slice(-400) });
    }
  } finally {
    try { db.close(); } catch { /* ignore */ }
    if (uploaded > 0 && self.registration?.showNotification) {
      const body = uploaded === 1
        ? "Tu pendiente se subió correctamente."
        : "Tus pendientes se subieron correctamente.";
      try {
        await self.registration.showNotification("Solicitud de almuerzo", {
          body,
          icon: "./icons/icon-192.png",
          badge: "./icons/icon-192.png",
          tag: "cocina-subido",
          renotify: true,
          lang: "es",
        });
      } catch { /* sin permiso de aviso */ }
    }
  }
}

self.addEventListener("sync", (event) => {
  if (event.tag !== OUTBOX_TAG) return;
  event.waitUntil(flushClosedApp());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const open = windows.find((client) => client.url.includes(self.location.origin));
    if (open) return open.focus();
    return self.clients.openWindow("./");
  })());
});
