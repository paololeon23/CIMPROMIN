import { APP_VERSION, TZ, nowParts } from "./config.js";
import { store } from "./store.js";

const PING_TIMEOUT_MS = 10000;
const PROBE_MS = 4000;
const POST_TIMEOUT_MS = 45000;
const RETRY_MIN_MS = 4000;
const RETRY_MAX_MS = 25000;
const SLOW_TYPES = new Set(["slow-2g", "2g", "3g"]);

let flushWait = null;
let flushAgain = false;
let retryTimer = 0;
let retryDelay = RETRY_MIN_MS;
let autoBound = false;
let onFlushDone = null;
let linkWasOnline = true;
let linkWasSlow = false;
let preferPost = false;
const inflight = new Map();
const inflightRev = new Map();
const activeFetches = new Set();

function recordRev(record) {
  const n = Number(record?.rev);
  return Number.isFinite(n) ? n : 0;
}

export function isClientInflight(clientId) {
  return inflight.has(String(clientId || ""));
}

function netInfo() {
  return navigator.connection || navigator.mozConnection || navigator.webkitConnection || null;
}

export function isSlowLink() {
  const conn = netInfo();
  if (!conn) return false;
  const effective = String(conn.effectiveType || "").toLowerCase();
  if (SLOW_TYPES.has(effective)) return true;
  if (conn.saveData === true) return true;
  const down = Number(conn.downlink);
  if (Number.isFinite(down) && down > 0 && down <= 0.5) return true;
  const rtt = Number(conn.rtt);
  if (!Number.isFinite(rtt)) return false;
  if (effective !== "4g" && rtt >= 400) return true;
  // H+ suele anunciarse como 4g. Con ese RTT un ping previo se come la ventana.
  if (effective === "4g" && rtt >= 200) return true;
  if (effective === "4g" && Number.isFinite(down) && down > 0 && down < 1.5) return true;
  return false;
}

function markListaTurno(record, raw) {
  if (!record || record.type !== "lista" || record.payload?.extra) return;
  if (raw && raw.duplicate && (raw.already || raw.error === "ya_enviado") && Number(raw.trabajadores || 0) === 0) {
    return;
  }
  const sid = String(record.payload?.supervisor_id || "").replace(/\D/g, "").slice(0, 8);
  store.setTurnoDia({
    dni: sid,
    fecha: record.payload?.fecha_local,
    comida: record.payload?.comida || "Almuerzo",
    enviado: true,
  });
}

function stampPayload(payload = {}) {
  const t = nowParts(TZ);
  return {
    ...payload,
    fecha_local: payload.fecha_local || t.fecha,
    hora_local: payload.hora_local || t.hora,
    timezone: payload.timezone || TZ,
  };
}

function pendingRecords() {
  return store.getCola().filter((r) => r.type === "lista" || r.type === "extra" || r.type === "cierre");
}

function stillQueued(clientId) {
  return pendingRecords().some((r) => r.clientId === clientId);
}

function clearRetry() {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = 0;
  }
}

function scheduleRetry(soon = false) {
  if (!pendingRecords().length) {
    clearRetry();
    retryDelay = RETRY_MIN_MS;
    return;
  }
  if (soon) {
    retryDelay = RETRY_MIN_MS;
    clearRetry();
  }
  if (retryTimer) return;
  const wait = retryDelay;
  retryTimer = setTimeout(() => {
    retryTimer = 0;
    flushQueue().catch(() => {});
  }, wait);
  retryDelay = Math.min(RETRY_MAX_MS, Math.round(retryDelay * 1.5));
}

function pingUrl(base) {
  const u = String(base || "").trim();
  if (!u) return "";
  const sep = u.includes("?") ? "&" : "?";
  return `${u}${sep}path=fundos`;
}

function isBrowserOffline() {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

function isTransient(err) {
  const name = String(err?.name || "");
  const msg = String(err?.message || err || "");
  if (name === "AbortError" || msg === "sin_red") return true;
  if (msg === "Failed to fetch" || msg === "NetworkError" || msg === "Load failed") return true;
  if (msg === "lock_timeout" || msg === "http_408" || msg === "http_429") return true;
  return /^http_5\d\d$/.test(msg);
}

function abortActiveFetches() {
  for (const ctrl of activeFetches) {
    try { ctrl.abort(); } catch { /* ya cerrado */ }
  }
}

async function fetchText(url, options, timeoutMs) {
  const ctrl = new AbortController();
  activeFetches.add(ctrl);
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
    activeFetches.delete(ctrl);
  }
}

export async function canReachServer(url, timeoutMs = PING_TIMEOUT_MS) {
  const probe = await probeServer(url, timeoutMs);
  return probe === "ok";
}

async function probeServer(url, timeoutMs = PROBE_MS) {
  const u = pingUrl(url || store.getScriptUrl());
  if (!u || isBrowserOffline()) return "down";
  try {
    const res = await fetchText(u, {
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    }, timeoutMs);
    if (!res.ok) return "down";
    const json = JSON.parse(await res.text());
    return json && (json.ok === true || json.ping === true || Array.isArray(json.fundos)) ? "ok" : "down";
  } catch (err) {
    return err?.name === "AbortError" ? "slow" : "down";
  }
}

export async function checkTurno({ supervisorId, fecha, comida, url, timeoutMs } = {}) {
  const u = (url || store.getScriptUrl()).trim();
  if (!u) return { ok: false, error: "sin_url" };
  const t = nowParts(TZ);
  const sid = String(supervisorId || "").replace(/\D/g, "").slice(0, 8);
  if (!/^\d{8}$/.test(sid)) return { ok: false, error: "sesion_invalida" };
  const qs = new URLSearchParams({
    path: "turno",
    supervisor: sid,
    fecha: fecha || t.fecha,
    comida: comida || "Almuerzo",
  });
  try {
    const res = await fetchText(`${u}?${qs}`, {
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    }, timeoutMs || 8000);
    return JSON.parse(await res.text());
  } catch (err) {
    return { ok: false, error: "sin_red", detail: String(err.message || err) };
  }
}

export async function pingServer(url) {
  const u = (url || store.getScriptUrl()).trim();
  if (!u) return { ok: false, error: "sin_url" };
  try {
    const res = await fetchText(u, {
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    }, PING_TIMEOUT_MS);
    const text = await res.text();
    return JSON.parse(text);
  } catch (err) {
    return { ok: false, error: "sin_red", detail: String(err.message || err) };
  }
}

async function deliverRecord(record, url) {
  const u = (url || store.getScriptUrl()).trim();
  const rev = recordRev(record);
  const current = store.getCola().find((r) => r.clientId === record.clientId);
  if (current && recordRev(current) > rev) return { skipped: true, record: current };
  const stamped = { ...record, rev, payload: stampPayload(record.payload || {}) };
  const again = store.getCola().find((r) => r.clientId === stamped.clientId);
  if (!again || recordRev(again) <= rev) store.upsertCola(stamped);
  if (!u) throw new Error("sin_url");
  if (isBrowserOffline()) throw new Error("sin_red");
  const body = JSON.stringify({
    type: stamped.type,
    clientId: stamped.clientId,
    rev: stamped.rev || Date.now(),
    payload: stamped.payload,
    clientVersion: APP_VERSION,
  });
  const res = await fetchText(u, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body,
    cache: "no-store",
    credentials: "omit",
    referrerPolicy: "no-referrer",
  }, POST_TIMEOUT_MS);
  if (!res.ok) throw new Error(`http_${res.status}`);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("respuesta_invalida");
  }
  if (!json.ok) throw new Error(json.error || "servidor");
  const isExtra = stamped.type === "extra" || stamped.payload?.extra;
  if (isExtra && (json.error === "sin_almuerzo" || (json.extra === false && Number(json.trabajadores || 0) === 0))) {
    throw new Error("sin_almuerzo");
  }
  const confirmed = json.saved === true || json.duplicate === true
    || typeof json.total === "number" || typeof json.trabajadores === "number";
  if (!confirmed) throw new Error("sin_confirmacion");
  const result = { duplicate: !!json.duplicate, record: stamped, raw: json };
  confirmSent(result);
  return result;
}

export function postRecord(record, url) {
  const id = String(record?.clientId || "");
  const rev = recordRev(record);
  if (id && inflight.has(id)) {
    const flying = inflight.get(id);
    if (!rev || rev <= (inflightRev.get(id) || 0)) return flying;
    return flying.catch(() => {}).then(() => {
      const latest = store.getCola().find((r) => r.clientId === id) || record;
      return postRecord(latest, url);
    });
  }
  const job = deliverRecord(record, url);
  if (id) {
    inflight.set(id, job);
    inflightRev.set(id, rev);
    job.finally(() => {
      if (inflight.get(id) === job) {
        inflight.delete(id);
        inflightRev.delete(id);
      }
    }).catch(() => {});
  }
  return job;
}

function isListaRecord(record) {
  return record?.type === "lista" && !record.payload?.extra;
}

function flushRank(record) {
  if (isListaRecord(record)) return 0;
  if (record?.type === "extra" || record?.payload?.extra) return 1;
  return 2;
}

function confirmSent(result) {
  if (!result?.record || result.skipped) return;
  const id = result.record.clientId;
  const rev = recordRev(result.record);
  const current = store.getCola().find((r) => r.clientId === id);
  store.pushHistorial({ ...result.record, duplicate: result.duplicate, confirmed: true });
  if (current && recordRev(current) > rev) {
    scheduleRetry(true);
    return;
  }
  store.removeCola(id);
  markListaTurno(result.record, result.raw);
}

export async function saveAndSync(record) {
  const queued = { ...record, payload: stampPayload(record.payload || {}) };
  store.upsertCola(queued);
  scheduleRetry();
  if (isBrowserOffline()) {
    armBackgroundSync();
    return { status: "pendiente", record: queued };
  }
  try {
    const result = await postRecord(queued);
    confirmSent(result);
    if (result.skipped || stillQueued(queued.clientId)) {
      scheduleRetry(true);
      armBackgroundSync();
      return { status: "pendiente", record: store.getCola().find((r) => r.clientId === queued.clientId) || queued };
    }
    if (!pendingRecords().length) {
      clearRetry();
      retryDelay = RETRY_MIN_MS;
    }
    return { status: "enviado", duplicate: result.duplicate, record: result.record, raw: result.raw };
  } catch {
    scheduleRetry();
    armBackgroundSync();
    return { status: "pendiente", record: queued };
  }
}

const BACKGROUND_SYNC_TAG = "cocina-pendientes";

export function armBackgroundSync() {
  if (!pendingRecords().length) return Promise.resolve();
  const swReady = typeof navigator !== "undefined" ? navigator.serviceWorker?.ready : null;
  if (!swReady) return Promise.resolve();
  try { store.checkpoint(); } catch { /* la cola ya está en local */ }
  const url = store.getScriptUrl();
  if (url) store.setScriptUrl(url);
  return store.whenSaved()
    .then(() => swReady)
    .then((reg) => {
      if (!reg?.sync || !pendingRecords().length) return;
      return reg.sync.register(BACKGROUND_SYNC_TAG);
    })
    .catch(() => {});
}

async function flushPass(onEach) {
  const summary = { sent: 0, duplicates: 0, errors: 0, skippedOffline: false };
  try { await store.applyBackgroundConfirms(); } catch { /* sigue con la cola local */ }
  if (!pendingRecords().length) return summary;
  try { store.noteFlush(); } catch { /* el envío de la página sigue */ }
  if (isBrowserOffline()) {
    summary.skippedOffline = true;
    return summary;
  }
  const direct = preferPost;
  preferPost = false;
  if (!direct && !isSlowLink()) {
    const probe = await probeServer();
    if (probe === "down") return summary;
  }
  const ordered = [...pendingRecords()].sort((a, b) => {
    const rank = flushRank(a) - flushRank(b);
    if (rank) return rank;
    return (a.createdAt || 0) - (b.createdAt || 0);
  });
  let fails = 0;
  let pass = 0;
  for (const record of ordered) {
    if (!stillQueued(record.clientId)) continue;
    if (pass) await new Promise((r) => setTimeout(r, 0));
    pass += 1;
    try {
      const result = await postRecord(record);
      if (result.skipped) continue;
      confirmSent(result);
      if (stillQueued(record.clientId)) continue;
      fails = 0;
      if (result.duplicate) summary.duplicates += 1;
      else summary.sent += 1;
      onEach?.({ ok: true, record: result.record, result: result.raw });
    } catch (err) {
      summary.errors += 1;
      fails += 1;
      onEach?.({ ok: false, record, error: err });
      if (isTransient(err) || fails >= 3) break;
    }
  }
  return summary;
}

async function flushBody(onEach) {
  let sent = 0;
  let duplicates = 0;
  let errors = 0;
  let guard = 0;
  while (guard++ < 4) {
    flushAgain = false;
    const pass = await flushPass(onEach);
    sent += pass.sent;
    duplicates += pass.duplicates;
    errors += pass.errors;
    const pending = pendingRecords().length;
    if (!pending) {
      clearRetry();
      retryDelay = RETRY_MIN_MS;
      return { sent, pending: 0, duplicates, errors };
    }
    const followNow = flushAgain && !isBrowserOffline();
    if (followNow) continue;
    if (pass.sent > 0 && pass.errors === 0) retryDelay = RETRY_MIN_MS;
    scheduleRetry(pass.sent > 0 && pass.errors === 0);
    return { sent, pending, duplicates, errors };
  }
  scheduleRetry();
  return { sent, pending: pendingRecords().length, duplicates, errors };
}

export function flushQueue(onEach, opts = {}) {
  const notify = opts.notify !== false;
  if (flushWait) {
    flushAgain = true;
    return flushWait;
  }
  const run = (async () => {
    try {
      return await flushBody(onEach);
    } finally {
      flushWait = null;
    }
  })();
  flushWait = run;
  return run.then((summary) => {
    if (notify) {
      try { onFlushDone?.(summary); } catch { /* UI opcional */ }
    }
    return summary;
  });
}

function kickSync() {
  const online = !isBrowserOffline();
  const slow = isSlowLink();
  const becameUsable = online && (!linkWasOnline || (slow && !linkWasSlow));
  linkWasOnline = online;
  linkWasSlow = slow;
  if (!pendingRecords().length || !online) return;
  if (becameUsable) {
    preferPost = true;
    scheduleRetry(true);
    flushQueue().catch(() => {});
    return;
  }
  if (!retryTimer) flushQueue().catch(() => {});
}

export function flushNow(opts = {}) {
  preferPost = true;
  scheduleRetry(true);
  armBackgroundSync();
  return flushQueue(null, opts);
}

export function startAutoSync(onDone) {
  if (typeof onDone === "function") onFlushDone = onDone;
  if (!autoBound) {
    autoBound = true;
    linkWasOnline = !isBrowserOffline();
    linkWasSlow = isSlowLink();
    window.addEventListener("online", kickSync);
    window.addEventListener("offline", () => {
      linkWasOnline = false;
      abortActiveFetches();
    });
    netInfo()?.addEventListener?.("change", kickSync);
  }
  scheduleRetry(true);
  armBackgroundSync();
  return flushQueue();
}
