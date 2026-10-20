import {
  STORAGE_KEYS,
  HISTORY_TTL_MS,
  todayKey,
  TZ,
  normalizeDni,
  isSesionDni,
} from "./config.js";

const mem = new Map();

function cloneData(value) {
  if (typeof structuredClone === "function") {
    try { return structuredClone(value); } catch { /* JSON */ }
  }
  return JSON.parse(JSON.stringify(value));
}

function read(key, fallback) {
  try {
    if (mem.has(key)) return cloneData(mem.get(key));
  } catch { /* localStorage */ }
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try { mem.set(key, cloneData(value)); } catch { mem.set(key, value); }
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function forget(key) {
  mem.delete(key);
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}

function wipeOldSessionCookie() {
  try {
    document.cookie = "qb_sup=; Path=/; Max-Age=0; SameSite=Lax";
    if (location.protocol === "https:") {
      document.cookie = "qb_sup=; Path=/; Max-Age=0; SameSite=Lax; Secure";
    }
  } catch {
    /* Safari / modo privado */
  }
}

wipeOldSessionCookie();

function slimSesion(s) {
  const dni = typeof s === "string" ? normalizeDni(s) : normalizeDni(s?.dni || s?.id);
  const row = { v: 1, dni, at: Date.now() };
  if (s && typeof s === "object" && s.emergencia) {
    row.emergencia = true;
    row.apellido = String(s.apellido || "").trim();
    row.nombre = String(s.nombre || "").trim();
  }
  return row;
}

const IDB_NAME = "cocina-qb";
const IDB_STORE = "sesion";
const IDB_KV = "kv";
const IDB_VER = 2;

function openIdb() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error("no_idb"));
      return;
    }
    const req = indexedDB.open(IDB_NAME, IDB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
      if (!db.objectStoreNames.contains(IDB_KV)) {
        db.createObjectStore(IDB_KV);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

let kvWriteChain = Promise.resolve();

function idbPutKv(key, value) {
  const run = async () => {
    let db;
    try {
      db = await openIdb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_KV, "readwrite");
        tx.objectStore(IDB_KV).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      /* localStorage sigue */
    } finally {
      try { db?.close(); } catch { /* ignore */ }
    }
  };
  kvWriteChain = kvWriteChain.then(run, run);
  return kvWriteChain;
}

async function idbGetKv(key) {
  let db;
  try {
    db = await openIdb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_KV, "readonly");
      const req = tx.objectStore(IDB_KV).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return undefined;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

function persistList(key, list) {
  const at = Date.now();
  const snapshot = cloneData(list);
  const ok = write(key, snapshot);
  if (ok) {
    try { localStorage.setItem(`${key}@at`, String(at)); } catch { /* la copia en IDB manda */ }
  }
  idbPutKv(key, { at, list: snapshot });
  return ok;
}

const PERSISTED_LISTS = [STORAGE_KEYS.cola, STORAGE_KEYS.mesa, STORAGE_KEYS.historial, STORAGE_KEYS.jornada];

function localStamp(key) {
  try { return Number(localStorage.getItem(`${key}@at`)) || 0; } catch { return 0; }
}

function lsKeyExists(key) {
  try {
    return localStorage.getItem(key) !== null;
  } catch {
    return true;
  }
}

async function hydrateKv() {
  try {
    const keys = [STORAGE_KEYS.cola, STORAGE_KEYS.mesa, STORAGE_KEYS.historial, STORAGE_KEYS.jornada];
    for (const key of keys) {
      const fromIdb = await idbGetKv(key);
      const idbList = Array.isArray(fromIdb) ? fromIdb : fromIdb?.list;
      const idbAt = Array.isArray(fromIdb) ? 0 : Number(fromIdb?.at) || 0;
      if (!Array.isArray(idbList)) {
        try {
          const raw = localStorage.getItem(key);
          const localList = raw ? JSON.parse(raw) : null;
          if (Array.isArray(localList) && localList.length) {
            idbPutKv(key, { at: Date.now(), list: localList });
          }
        } catch { /* localStorage sigue */ }
        continue;
      }
      if (!lsKeyExists(key)) {
        if (idbList.length) write(key, idbList);
        continue;
      }
      if (idbAt > localStamp(key)) write(key, idbList);
    }
  } catch {
    /* sigue con localStorage */
  }
}

async function idbPutDni(dni) {
  let db;
  try {
    db = await openIdb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).put(dni, "dni");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* el celular sigue con localStorage */
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

async function idbGetDni() {
  let db;
  try {
    db = await openIdb();
    const raw = await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readonly");
      const req = tx.objectStore(IDB_STORE).get("dni");
      req.onsuccess = () => resolve(req.result || "");
      req.onerror = () => reject(req.error);
    });
    const dni = normalizeDni(raw);
    return isSesionDni(dni) ? dni : "";
  } catch {
    return "";
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

async function idbDelDni() {
  let db;
  try {
    db = await openIdb();
    await new Promise((resolve) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).delete("dni");
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    /* ignore */
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

export const store = {
  getCola() {
    return read(STORAGE_KEYS.cola, []);
  },
  upsertCola(record) {
    const cola = this.getCola().filter((r) => r.clientId !== record.clientId);
    cola.unshift(record);
    persistList(STORAGE_KEYS.cola, cola);
    return cola;
  },
  removeCola(clientId) {
    persistList(STORAGE_KEYS.cola, this.getCola().filter((r) => r.clientId !== clientId));
  },
  getHistorial() {
    this.pruneHistorial();
    return read(STORAGE_KEYS.historial, []);
  },
  pushHistorial(record) {
    const list = this.getHistorial().filter((r) => r.clientId !== record.clientId);
    list.unshift({ ...record, savedAt: Date.now() });
    persistList(STORAGE_KEYS.historial, list);
  },
  pruneHistorial() {
    const list = read(STORAGE_KEYS.historial, []).filter((r) => Date.now() - (r.savedAt || 0) < HISTORY_TTL_MS);
    persistList(STORAGE_KEYS.historial, list);
  },
  getDrafts() {
    return read(STORAGE_KEYS.borradores, {});
  },
  setDraft(formId, data) {
    const all = this.getDrafts();
    all[formId] = { data, updatedAt: Date.now() };
    write(STORAGE_KEYS.borradores, all);
  },
  clearDraft(formId) {
    const all = this.getDrafts();
    delete all[formId];
    write(STORAGE_KEYS.borradores, all);
  },
  clearDraftsOnly() {
    write(STORAGE_KEYS.borradores, {});
  },
  getPrefs() {
    return read(STORAGE_KEYS.prefs, { voice: true, scriptUrl: "" });
  },
  setPrefs(patch) {
    write(STORAGE_KEYS.prefs, { ...this.getPrefs(), ...patch });
  },
  getSesion() {
    const local = read(STORAGE_KEYS.sesion, null);
    const dni = normalizeDni(local?.dni || local?.id);
    return isSesionDni(dni) ? local : null;
  },
  getSesionDni() {
    const local = read(STORAGE_KEYS.sesion, null);
    const fromStore = normalizeDni(local?.dni || local?.id);
    return isSesionDni(fromStore) ? fromStore : "";
  },
  setSesion(s) {
    const dni = normalizeDni(s?.dni || s?.id);
    if (!isSesionDni(dni)) return false;
    const ok = write(STORAGE_KEYS.sesion, slimSesion(s));
    idbPutDni(dni);
    return ok;
  },
  async applyBackgroundConfirms() {
    const box = await idbGetKv("cola_confirmados");
    const items = Array.isArray(box?.items) ? box.items : [];
    if (!items.length) return;
    const seen = new Set();
    for (const item of items) {
      const id = String(item?.clientId || "");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const row = this.getCola().find((r) => r.clientId === id);
      if (row) {
        this.pushHistorial({ ...row, duplicate: !!item.duplicate, confirmed: true });
        this.removeCola(id);
      }
    }
    const again = await idbGetKv("cola_confirmados");
    const left = (Array.isArray(again?.items) ? again.items : []).filter((item) => item && !seen.has(item.clientId));
    await idbPutKv("cola_confirmados", { at: Date.now(), items: left });
  },
  async restoreSesion() {
    await hydrateKv();
    try { await this.applyBackgroundConfirms(); } catch { /* la cola local sigue */ }
    const local = read(STORAGE_KEYS.sesion, null);
    let dni = normalizeDni(local?.dni || local?.id);
    if (!isSesionDni(dni)) dni = await idbGetDni();
    if (!isSesionDni(dni)) return "";
    if (local?.emergencia && normalizeDni(local.dni || local.id) === dni) {
      this.setSesion({
        dni,
        emergencia: true,
        apellido: local.apellido || "",
        nombre: local.nombre || "",
      });
      return dni;
    }
    this.setSesion({ dni });
    return dni;
  },
  clearSesion() {
    forget(STORAGE_KEYS.sesion);
    forget(STORAGE_KEYS.turnoDia);
    wipeOldSessionCookie();
    idbDelDni();
  },
  getTurnoDia() {
    const row = read(STORAGE_KEYS.turnoDia, null);
    const day = todayKey(TZ);
    const sid = normalizeDni(this.getSesionDni() || row?.dni);
    if (!row || row.fecha !== day) return null;
    if (sid && normalizeDni(row.dni) && normalizeDni(row.dni) !== sid) return null;
    return row;
  },
  setTurnoDia(patch = {}) {
    const day = todayKey(TZ);
    const sid = normalizeDni(patch.dni || this.getSesionDni());
    if (!isSesionDni(sid)) return false;
    return write(STORAGE_KEYS.turnoDia, {
      dni: sid,
      fecha: patch.fecha || day,
      comida: patch.comida || "Almuerzo",
      enviado: !!patch.enviado,
      at: Date.now(),
    });
  },
  clearTurnoDia() {
    forget(STORAGE_KEYS.turnoDia);
  },
  getLocalWorkers() {
    return read(STORAGE_KEYS.catalogoTrab, []);
  },
  upsertLocalWorker(w) {
    const list = this.getLocalWorkers().filter((x) => x.id !== w.id);
    list.unshift(w);
    write(STORAGE_KEYS.catalogoTrab, list);
    this.touchReciente(w);
    return list;
  },
  getLocalSupervisors() {
    return read(STORAGE_KEYS.catalogoSup, []);
  },
  upsertLocalSupervisor(s) {
    const list = this.getLocalSupervisors().filter((x) => x.id !== s.id);
    list.unshift(s);
    write(STORAGE_KEYS.catalogoSup, list);
    return list;
  },
  getRecientes() {
    return read(STORAGE_KEYS.recientes, []);
  },
  touchReciente(person) {
    const list = this.getRecientes().filter((x) => x.id !== person.id);
    list.unshift({ id: person.id, apellido: person.apellido, nombre: person.nombre, kind: person.kind || "wrk" });
    write(STORAGE_KEYS.recientes, list.slice(0, 30));
  },
  getDniGuardados() {
    return read(STORAGE_KEYS.dniGuardados, []);
  },
  upsertDniGuardado(person) {
    const id = normalizeDni(person.dni || person.id);
    if (!id) return this.getDniGuardados();
    const list = this.getDniGuardados().filter((x) => normalizeDni(x.id || x.dni) !== id);
    list.unshift({
      id,
      dni: id,
      apellido: person.apellido || "",
      nombre: person.nombre || "",
      cargo: person.cargo || person.area || "",
      temporal: !!person.temporal,
      ...(person.sexo === "M" || person.sexo === "F" ? { sexo: person.sexo } : {}),
      savedAt: Date.now(),
    });
    write(STORAGE_KEYS.dniGuardados, list.slice(0, 200));
    return list;
  },
  clearDniGuardados() {
    write(STORAGE_KEYS.dniGuardados, []);
  },
  clearRecientes() {
    write(STORAGE_KEYS.recientes, []);
  },
  getMesa() {
    const raw = read(STORAGE_KEYS.mesa, []);
    if (!Array.isArray(raw)) return [];
    const day = todayKey(TZ);
    const list = raw.filter((p) => p && p.id && String(p.fecha || "") === day);
    if (list.length !== raw.filter((p) => p && p.id).length) persistList(STORAGE_KEYS.mesa, list);
    return list;
  },
  setMesa(list) {
    const day = todayKey(TZ);
    persistList(STORAGE_KEYS.mesa, (list || []).map((p) => ({ ...p, fecha: p.fecha || day })));
  },
  clearMesa() {
    persistList(STORAGE_KEYS.mesa, []);
  },
  getJornada() {
    const raw = read(STORAGE_KEYS.jornada, []);
    if (!Array.isArray(raw)) return [];
    const keep = Date.now() - 21 * 24 * 60 * 60 * 1000;
    const list = raw.filter((m) => m && m.dni && m.fecha && m.at && m.at >= keep);
    if (list.length !== raw.length) persistList(STORAGE_KEYS.jornada, list);
    return list;
  },
  addMarcacion(row) {
    const list = this.getJornada();
    list.push(row);
    persistList(STORAGE_KEYS.jornada, list);
    return row;
  },
  setJornada(list) {
    persistList(STORAGE_KEYS.jornada, Array.isArray(list) ? list : []);
  },
  getScriptUrl() {
    return (this.getPrefs().scriptUrl || localStorage.getItem(STORAGE_KEYS.scriptUrl) || "").trim();
  },
  setScriptUrl(url) {
    const clean = String(url || "").trim();
    this.setPrefs({ scriptUrl: clean });
    try { localStorage.setItem(STORAGE_KEYS.scriptUrl, clean); } catch { /* modo privado */ }
    if (clean) idbPutKv(STORAGE_KEYS.scriptUrl, clean);
  },
  whenSaved() {
    return kvWriteChain.catch(() => {});
  },
  noteFlush() {
    idbPutKv("page_flush_at", Date.now());
  },
  checkpoint() {
    for (const key of PERSISTED_LISTS) {
      if (!mem.has(key)) continue;
      try { persistList(key, mem.get(key)); } catch { /* el cierre no puede fallar */ }
    }
  },
  releaseMemory() {
    mem.clear();
  },
};

export function recordsOfToday(timeZone = TZ) {
  const day = todayKey(timeZone);
  const cola = store.getCola().filter((r) => r.payload?.fecha_local === day);
  const hist = store.getHistorial().filter((r) => r.payload?.fecha_local === day);
  const byId = new Map();
  for (const r of hist) byId.set(r.clientId, { ...r, status: "enviado" });
  for (const r of cola) {
    if (!byId.has(r.clientId)) byId.set(r.clientId, { ...r, status: "pendiente" });
  }
  return [...byId.values()];
}
