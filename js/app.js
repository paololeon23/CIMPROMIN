import { APP_VERSION, APP_ASSETS, CACHE_NAME, FORM_TYPES, TZ, encodeQr, parseQr, normalizeDni, isSesionDni, todayKey, uuid, nowParts } from "./config.js";
import { bindAppHeight, bindFieldLock, isFieldDevice, preventBounce } from "./device.js";
import { recordsOfToday, store } from "./store.js";
import { onVoiceState, setVoiceEnabled, speak, speakPersonName, prepareSpeakName, unlockVoice, voiceEnabled, isSpeaking } from "./voice.js";
import { computeHeadcount } from "./calc.js";
import { armBackgroundSync, checkTurno, flushNow, flushQueue, pingServer, saveAndSync, startAutoSync } from "./sync.js";
import { FieldScanner } from "./scanner.js";

const scanner = new FieldScanner();
scanner.onEnded = () => {
  if (state.camOff) return;
  if (state.view !== "home" && state.view !== "supervisor") return;
  if (document.visibilityState === "hidden") return;
  const now = Date.now();
  if (now - (state.camRestartAt || 0) < 1500) return;
  state.camRestartAt = now;
  startCamHere();
};
let deferredInstall = null;

function markInstalled() {
  store.setPrefs({ installed: true });
}

function hideInstallSlot() {
  const host = document.getElementById("install-slot");
  if (host) host.hidden = true;
}

function isAppInstalled() {
  if (window.matchMedia("(display-mode: standalone)").matches || window.matchMedia("(display-mode: fullscreen)").matches) {
    markInstalled();
    return true;
  }
  if (window.navigator.standalone === true) {
    markInstalled();
    return true;
  }
  return store.getPrefs().installed === true;
}

function bindInstallPrompt() {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredInstall = e;
    if (isAppInstalled()) hideInstallSlot();
  });
  window.addEventListener("appinstalled", () => {
    deferredInstall = null;
    markInstalled();
    hideInstallSlot();
  });
}

function installSlot() {
  if (isAppInstalled()) return "";
  return `<div id="install-slot">
    <button class="install-cta" data-act="install-app" type="button">
      <img src="./icons/icon-192.png" alt="" />
      Instalar en inicio
    </button>
  </div>`;
}

async function installApp() {
  if (isAppInstalled()) {
    hideInstallSlot();
    return;
  }
  if (deferredInstall) {
    deferredInstall.prompt();
    const choice = await deferredInstall.userChoice;
    deferredInstall = null;
    if (choice?.outcome === "accepted") {
      markInstalled();
      hideInstallSlot();
    }
    return;
  }
  const ios = /iPhone|iPod/i.test(navigator.userAgent || "");
  if (ios) {
    openAlert(`<div class="modal-back" data-act="dismiss-alert">
      <div class="modal" role="dialog" aria-modal="true">
        <img class="install-ico" src="./icons/icon-192.png" alt="" />
        <h3>Solicitud de almuerzo</h3>
        <p>En Safari: toque Compartir y luego Agregar a pantalla de inicio. El nombre es Solicitud de almuerzo.</p>
        <button class="btn" data-act="dismiss-alert" type="button">Entendido</button>
      </div>
    </div>`);
    return;
  }
  showAlert("Instalar", "En el menú del navegador elija Instalar app o Agregar a pantalla de inicio. El nombre es Solicitud de almuerzo.");
}
const state = {
  view: "boot",
  tab: "home",
  cfg: null,
  menu: null,
  items: [],
  workers: [],
  oficial: new Map(),
  supByDni: new Map(),
  wrkByDni: new Map(),
  workersPromise: null,
  supervisors: [],
  scanMode: "sup",
  camOff: false,
  scanOpId: 0,
  lastDetectedQR: "",
  lastProcessedQR: "",
  lastProcessedAt: 0,
  lastRepeatQR: "",
  lastRepeatAt: 0,
  speechLockDni: "",
  speechLockUntil: 0,
  scanTimestamp: 0,
  scanWaitSpeakAt: 0,
  scanToastTimer: 0,
  draft: emptyDraft(),
  formType: "pedido",
  lastSpeak: "",
  online: navigator.onLine,
  busy: false,
  loggingIn: false,
  emergencyPending: false,
  extraOn: false,
  extraHold: false,
  admin: false,
  logoTaps: 0,
  mesaPage: 1,
  mesaQuery: "",
  dniPage: 1,
  dniQuery: "",
  dniSelected: {},
  histPage: 1,
  histOpen: "",
  histPeoplePage: 1,
  histPeopleQuery: "",
  swGuardUntil: 0,
  handlingScan: false,
  isProcessing: false,
};

function emptyDraft(worker = null) {
  return {
    worker,
    cantidades: {},
    comentario: "",
    tipo_dieta: "",
    alergias: "",
    clientId: uuid(),
  };
}

function freshFetch() {
  try {
    return sessionStorage.getItem("qb_updating") ? "reload" : "default";
  } catch {
    return "default";
  }
}

async function readCachedJson(path) {
  if (!("caches" in window)) return null;
  try {
    const hit = await caches.match(path, { ignoreSearch: true });
    if (!hit) return null;
    return await hit.json();
  } catch {
    return null;
  }
}

async function loadJson(path, fallback) {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    const cached = await readCachedJson(path);
    if (cached != null) return cached;
  }
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(path, { cache: freshFetch(), signal: ctrl.signal });
    if (res.ok) return await res.json();
  } catch {
    /* sigue con la copia guardada */
  } finally {
    window.clearTimeout(timer);
  }
  const cached = await readCachedJson(path);
  return cached != null ? cached : fallback;
}

function nameParts(person) {
  const full = String(person?.nombreCompleto || [person?.apellido, person?.nombre].filter(Boolean).join(" ") || person?.nombre || "")
    .replace(/\s+/g, " ")
    .trim();
  const parts = full.split(" ").filter(Boolean);
  const apellido = parts.length >= 2
    ? `${parts[0]} ${parts[1]}`.toUpperCase()
    : (parts[0] || person?.apellido || "").toUpperCase();
  const nombre = parts.slice(parts.length >= 2 ? 2 : 1).join(" ");
  return { apellido, nombre, nombreCompleto: full };
}

function twoApellidos(person) {
  return nameParts(person).apellido;
}

function displayName(person) {
  if (!person) return "";
  const full = String(
    person.nombreCompleto
    || [person.apellido, person.nombre].filter(Boolean).join(" ")
    || person.apellido
    || person.nombre
    || ""
  ).replace(/\s+/g, " ").trim();
  return full;
}

function supervisorNombreCompleto(s) {
  if (!s) return "";
  const full = nameParts(s).nombreCompleto || [s.apellido, s.nombre].filter(Boolean).join(" ");
  return String(full || s.apellido || "").replace(/\s+/g, " ").trim().toUpperCase();
}

function mapTrabajador(row) {
  const dni = normalizeDni(row.dni || row.id);
  const parsed = nameParts({ nombreCompleto: row.nombre, apellido: row.apellido, nombre: row.nombre });
  const sexo = String(row.sexo || "").toUpperCase();
  return {
    id: dni,
    dni,
    apellido: parsed.apellido,
    nombre: parsed.nombre,
    nombreCompleto: parsed.nombreCompleto || String(row.nombre || "").trim(),
    cargo: row.cargo || "",
    area: row.cargo || row.area || "",
    ...(sexo === "M" || sexo === "F" ? { sexo } : {}),
  };
}

function personSexo(person) {
  const direct = String(person?.sexo || "").toUpperCase();
  if (direct === "M" || direct === "F") return direct;
  const key = normalizeDni(person?.dni || person?.id);
  const official = key ? state.wrkByDni.get(key) : null;
  const fromFile = String(official?.sexo || "").toUpperCase();
  return fromFile === "M" || fromFile === "F" ? fromFile : "";
}

function mergePeople(fileList, localList) {
  const map = new Map();
  for (const p of fileList || []) {
    const row = p.dni && !p.apellido ? mapTrabajador(p) : p;
    const key = normalizeDni(row.dni || row.id);
    if (key) map.set(key, { ...row, id: key, dni: key });
  }
  for (const p of localList || []) {
    const key = normalizeDni(p.dni || p.id);
    if (key) map.set(key, { ...map.get(key), ...p, id: key, dni: key });
  }
  return [...map.values()];
}

function findWorkerByDni(dni) {
  const key = normalizeDni(dni);
  if (!key) return null;
  return state.wrkByDni.get(key) || state.supByDni.get(key) || null;
}

function findOfficial(dni) {
  return findWorkerByDni(dni);
}

async function loadTrabajadores() {
  const raw = await loadJson("./data/trabajadores.json", []);
  const list = Array.isArray(raw) ? raw : (raw.trabajadores || []);
  const map = new Map();
  for (const row of list) {
    const person = mapTrabajador(row);
    if (person.dni) map.set(person.dni, person);
  }
  state.wrkByDni = map;
  state.workers = [...map.values()];
  state.oficial = map;
  if (state.view === "home") refreshMesaUi();
}

function ensureWorkers() {
  if (state.wrkByDni.size) return Promise.resolve();
  if (!state.workersPromise) {
    state.workersPromise = loadTrabajadores().finally(() => {
      if (!state.wrkByDni.size) state.workersPromise = null;
    });
  }
  return state.workersPromise;
}

function personFromSaved(dni) {
  const official = findOfficial(dni);
  if (official) return official;
  const key = normalizeDni(dni);
  const p = store.getDniGuardados().find((x) => normalizeDni(x.id || x.dni) === key);
  if (!p) return null;
  return {
    dni: p.dni || p.id,
    id: p.dni || p.id,
    apellido: p.apellido,
    nombre: p.nombre,
    nombreCompleto: [p.apellido, p.nombre].filter(Boolean).join(" "),
    cargo: p.cargo || "Temporal",
    temporal: true,
    ...(personSexo(p) ? { sexo: personSexo(p) } : {}),
  };
}

function findPerson(parsed) {
  if (!parsed) return null;
  return findOfficial(parsed.dni || parsed.id);
}

function findWorker(parsed) {
  return findPerson(parsed);
}

function findSupervisor(parsed) {
  const dni = normalizeDni(parsed?.dni || parsed?.id);
  if (!dni) return null;
  return state.supByDni.get(dni) || null;
}

function supervisor() {
  const dni = store.getSesionDni();
  if (!dni) return null;
  const ses = store.getSesion();
  const hit = state.supByDni.get(dni);
  if (hit) return { ...hit, apellido: twoApellidos(hit), emergencia: !!(ses?.emergencia || hit.emergencia) };
  if (ses?.emergencia) {
    return {
      id: dni,
      dni,
      apellido: ses.apellido || "",
      nombre: ses.nombre || "",
      cargo: "Supervisor de emergencia",
      emergencia: true,
    };
  }
  if (!state.supByDni.size) {
    return { id: dni, dni, apellido: "", nombre: "", cargo: "" };
  }
  store.clearSesion();
  return null;
}

function expectedHeadcount() {
  return Number(store.getPrefs().headcount || state.cfg?.expectedHeadcount || 40);
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function statusPills() {
  const n = pendingCount();
  const online = !!(state.online && navigator.onLine);
  return `<div class="appbar-status">
    <span class="pill ${online ? "live" : "off"}"><i></i>${online ? "En línea" : "Sin señal"}</span>
    <button class="pill pend" type="button" data-act="flush-pend" aria-label="Enviar pendientes y avisar"><i class="up"></i>${n} pend.</button>
  </div>`;
}

function appBar({ title, sub = "", back = "", progress = null } = {}) {
  const lead = back
    ? `<button class="back" data-act="${esc(back)}" type="button" aria-label="Volver"><span>‹</span></button>`
    : `<button class="brand-mark" data-act="logo-tap" type="button" aria-label="Q Berries">
        <img src="./assets/logo-qberries.png" alt="" />
      </button>`;
  const bar = progress == null
    ? ""
    : `<div class="appbar-progress"><i style="width:${Math.max(0, Math.min(100, progress))}%"></i></div>`;
  return `<header class="appbar">
    <div class="appbar-row">
      <div class="appbar-lead">${lead}</div>
      <div class="appbar-titles">
        <span class="brand-kicker">Q BERRIES</span>
        <h1>${esc(title || "Solicitud de almuerzo")}</h1>
        ${sub ? `<p>${esc(sub)}</p>` : ""}
      </div>
      ${statusPills()}
    </div>
    ${bar}
  </header>`;
}

function speakBar() {
  return `<div class="speakbar ${state.lastSpeak ? "on" : ""}" id="speakbar">
    <div class="wave"><i></i><i></i><i></i></div>
    <span>${esc(state.lastSpeak || "…")}</span>
  </div>`;
}

function sectionHead(title, sub = "", noteId = "") {
  return `<header class="section-head">
    <i class="section-bar" aria-hidden="true"></i>
    <div>
      <h2>${esc(title)}</h2>
      ${sub ? `<p${noteId ? ` id="${esc(noteId)}"` : ""}>${esc(sub)}</p>` : ""}
    </div>
  </header>`;
}

function blockCard(kicker, sub = "", extra = "", noteId = "", variant = "") {
  return `<section class="section-card${variant ? ` ${variant}` : ""}">
    ${sectionHead(kicker, sub, noteId)}
    ${extra}
  </section>`;
}

function pendingCount() {
  return store.getCola().filter((r) => r.type === "lista" || r.type === "extra" || r.type === "cierre").length;
}

function dropScanCola() {
  for (const r of store.getCola()) {
    if (r.type === "pedido" || r.type === "especial") store.removeCola(r.clientId);
  }
}

const LOTES = ["Almuerzo"];
const PAGE_SIZE = 8;
const HIST_PAGE_SIZE = 5;
const HIST_PEOPLE_PAGE = 10;

function currentLote() {
  return "Almuerzo";
}

function sameMealSend(r, comida) {
  const day = todayKey(TZ);
  const sid = normalizeDni(supervisor()?.dni || supervisor()?.id || "");
  const p = r.payload || {};
  if (p.fecha_local !== day) return false;
  if (comida && p.comida !== comida) return false;
  const rowSid = normalizeDni(p.supervisor_id || "");
  // Solo cuenta el envío de ESTE supervisor. Sin sid no se bloquea a Extra.
  if (!sid || !rowSid || rowSid !== sid) return false;
  return true;
}

function dayAlreadySent(comida = currentLote()) {
  const t = store.getTurnoDia();
  const sid = normalizeDni(supervisor()?.dni || supervisor()?.id || "");
  if (
    t?.enviado
    && (!t.comida || t.comida === comida)
    && (!sid || !normalizeDni(t.dni) || normalizeDni(t.dni) === sid)
  ) {
    return true;
  }
  return store.getHistorial().some((r) => (
    r.type === "lista" && !r.payload?.extra && r.confirmed !== false && sameMealSend(r, comida)
  ));
}

function hasNormalSend(comida = currentLote()) {
  if (dayAlreadySent(comida)) return true;
  return store.getCola().some((r) => (r.type === "lista") && !r.payload?.extra && sameMealSend(r, comida));
}

function hasSavedSend(comida = currentLote()) {
  // Extra vale con el almuerzo ya en cola (sin señal) o ya confirmado en el servidor.
  return hasNormalSend(comida);
}

async function syncTurnoDelDia({ timeoutMs = 2800 } = {}) {
  const s = supervisor();
  const sid = normalizeDni(s?.dni || s?.id);
  if (!sid) return store.getTurnoDia();
  if (s?.emergencia) return store.getTurnoDia();
  const run = (async () => {
    if (!navigator.onLine) return store.getTurnoDia();
    const r = await checkTurno({
      supervisorId: sid,
      fecha: todayKey(TZ),
      comida: currentLote(),
      timeoutMs: timeoutMs || 2500,
    });
    if (!r?.ok) return store.getTurnoDia();
    store.setTurnoDia({
      dni: sid,
      fecha: r.fecha || todayKey(TZ),
      comida: r.comida || currentLote(),
      enviado: !!r.enviado,
    });
    refreshHomeLock();
    return store.getTurnoDia();
  })();
  if (!timeoutMs) return run;
  return Promise.race([
    run,
    new Promise((resolve) => window.setTimeout(() => resolve(store.getTurnoDia()), timeoutMs)),
  ]);
}

function refreshHomeLock() {
  if (state.view !== "home") return;
  if (alertIsOpen()) return;
  const shell = document.querySelector("#app .shell");
  const cam = document.getElementById("cam");
  if (!shell || !cam) {
    show("home", { replace: true, silent: true });
    return;
  }
  const locked = isSendLocked();
  shell.classList.toggle("is-locked", locked);
  const live = document.getElementById("scan-live");
  if (live) {
    if (locked) {
      live.textContent = "Ya envió. Pulse Extra si alguien se olvidó o llegó tarde.";
      live.classList.add("bad");
    } else if (state.extraOn) {
      live.textContent = "Extra: lista vacía. Acerca el QR de quien falta.";
      live.classList.remove("bad");
    }
  }
  const extraBtn = document.querySelector('.lote-pills [data-act="toggle-extra"]');
  const mealBtn = document.querySelector('.lote-pills [data-act="set-lote"]');
  const showExtra = !!state.extraOn || !!state.extraHold;
  if (extraBtn) extraBtn.classList.toggle("on", showExtra);
  if (mealBtn) mealBtn.classList.toggle("on", !showExtra);
  const send = document.querySelector('[data-act="go-summary"]');
  if (send) send.disabled = !getMesa().length || locked;
  refreshPendPill();
}

function isSendLocked() {
  return hasNormalSend() && !state.extraOn;
}

function warnLocked() {
  showAlert(
    "Ya envió",
    `El ${currentLote().toLowerCase()} de hoy ya se envió. Pulse Extra si alguien se olvidó o llegó tarde.`
  );
}

function toggleExtra() {
  if (state.extraOn) {
    state.extraOn = false;
    state.extraHold = false;
    store.clearMesa();
    speak("Extra apagado. Se limpió la lista.");
    show("home");
    return;
  }
  if (!hasSavedSend()) {
    showAlert("Todavía no", "Primero envíe el almuerzo del turno. Después puede mandar extras, también sin señal.");
    return;
  }
  // Extra siempre arranca vacío. No se carga el almuerzo del supervisor.
  state.extraOn = true;
  state.extraHold = false;
  store.clearMesa();
  speak(`Extra de ${currentLote().toLowerCase()}. Lista vacía. Escanee solo a quien falta.`);
  show("home");
  setScanLive("Extra: lista vacía. Acerca el QR de quien falta.", true);
}

function userIcon() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 21a8 8 0 0 0-16 0"/><circle cx="12" cy="7" r="4"/></svg>`;
}

function ellipsisIcon() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>`;
}

function fabBlock() {
  return `<div class="fab-wrap">
    <div class="fab-menu" id="fab-menu" hidden>
      <button type="button" data-act="go-historial">Ver historial</button>
      <button type="button" data-act="go-dni">DNI guardados</button>
      <button type="button" data-act="go-perfil">Perfil</button>
      <button type="button" data-act="go-ajustes">Ajustes</button>
    </div>
    <button class="fab-options" id="fab-options-btn" type="button" data-act="toggle-fab" aria-label="Opciones rápidas" aria-expanded="false">
      ${ellipsisIcon()}
    </button>
  </div>`;
}

function closeFab() {
  const menu = document.getElementById("fab-menu");
  const btn = document.getElementById("fab-options-btn");
  if (menu) menu.hidden = true;
  btn?.setAttribute("aria-expanded", "false");
}

function horaMinutos(raw) {
  const m = String(raw || "").match(/(\d{1,2}):(\d{2})/);
  if (!m) return "";
  return `${m[1].padStart(2, "0")}:${m[2]}`;
}

function historialConfirmados() {
  const sid = supervisor()?.dni || supervisor()?.id || "";
  return store.getHistorial().filter((r) => {
    if (r.type !== "lista" && r.type !== "extra") return false;
    if (r.confirmed === false) return false;
    if (sid && r.payload?.supervisor_id && r.payload.supervisor_id !== sid) return false;
    return true;
  });
}

function histRecordId(r) {
  return String(r.clientId || r.savedAt || "");
}

function histPersonas(r) {
  return (r.payload?.personas || []).filter((p) => p && (p.dni || p.id));
}

function histPeopleFiltered(r) {
  const q = String(state.histPeopleQuery || "").replace(/\D/g, "");
  return histPersonas(r).filter((p) => {
    if (!q) return true;
    return String(p.dni || p.id || "").includes(q);
  });
}

function histPeopleBlock(r) {
  const all = histPeopleFiltered(r);
  const pages = Math.max(1, Math.ceil(all.length / HIST_PEOPLE_PAGE));
  state.histPeoplePage = Math.min(Math.max(1, state.histPeoplePage || 1), pages);
  const start = (state.histPeoplePage - 1) * HIST_PEOPLE_PAGE;
  const slice = all.slice(start, start + HIST_PEOPLE_PAGE);
  const q = String(state.histPeopleQuery || "").replace(/\D/g, "");
  const rows = slice.map((p) => {
    const dni = p.dni || p.id || "—";
    const ape = twoApellidos(p) || p.apellido || "—";
    const nom = nameParts(p).nombre || p.nombre || "";
    return `<div class="hist-person">
      <div>
        <b>${esc(ape)}</b>
        <div class="meta">DNI ${esc(dni)}${nom ? ` · ${esc(nom)}` : ""}</div>
      </div>
      <span class="st ok">Enviado</span>
    </div>`;
  }).join("") || `<p class="sub">${q ? "Ningún DNI coincide." : "No hay personas de este envío en el celular."}</p>`;
  return `<div class="hist-people">
    <input id="hist-search" class="dni-search" type="search" inputmode="numeric" maxlength="8" enterkeyhint="search" autocomplete="off" placeholder="Buscar DNI" value="${esc(q)}">
    <div class="hist-people-list">${rows}</div>
    ${pagerHtml(state.histPeoplePage, pages, "hist-people-prev", "hist-people-next")}
  </div>`;
}

function showHistorialModal() {
  closeFab();
  const recs = historialConfirmados();
  const pages = Math.max(1, Math.ceil(recs.length / HIST_PAGE_SIZE));
  state.histPage = Math.min(Math.max(1, state.histPage || 1), pages);
  const start = (state.histPage - 1) * HIST_PAGE_SIZE;
  const slice = recs.slice(start, start + HIST_PAGE_SIZE);
  const openId = state.histOpen || "";
  if (openId && !slice.some((r) => histRecordId(r) === openId)) state.histOpen = "";
  const today = todayKey(TZ);
  const rows = slice.map((r) => {
    const p = r.payload || {};
    const n = p.trabajadores_unicos || histPersonas(r).length;
    const who = `${n || "—"} ${n === 1 ? "solicitud" : "solicitudes"}`;
    const hora = horaMinutos(p.hora_local);
    const fecha = p.fecha_local && p.fecha_local !== today
      ? String(p.fecha_local).slice(5).replace("-", "/")
      : "";
    const meta = [p.fundo || p.etapa || "—", p.comedor || "—", fecha, hora].filter(Boolean).join(" · ");
    const id = histRecordId(r);
    const open = openId === id;
    const badge = r.type === "extra" || p.extra ? "Extra" : (r.duplicate ? "Ya estaba" : "Confirmado");
    return `<div class="hist-item${open ? " open" : ""}">
      <button type="button" class="hist-row" data-act="toggle-hist" data-id="${esc(id)}" aria-expanded="${open ? "true" : "false"}">
        <div>
          <b>${esc(who)}</b>
          <div class="meta">${esc(meta)}</div>
        </div>
        <span class="st ok">${esc(badge)}</span>
        <span class="hist-chev" aria-hidden="true">${open ? "▾" : "▸"}</span>
      </button>
      ${open ? histPeopleBlock(r) : ""}
    </div>`;
  }).join("") || `<p class="sub">Aún no hay envíos confirmados en este celular.</p>`;
  openAlert(`<div class="modal-back" data-act="dismiss-alert">
    <div class="modal summary-modal" role="dialog" aria-modal="true" data-act="stay">
      ${sectionHead("Historial", "Solo este celular. Se borra a las 48 horas.")}
      <div class="hist-list">${rows}</div>
      ${pagerHtml(state.histPage, pages, "hist-page-prev", "hist-page-next")}
      <button class="btn ghost" data-act="dismiss-alert" type="button">Cerrar</button>
    </div>
  </div>`);
}

function focusHistSearch() {
  const input = document.getElementById("hist-search");
  if (!input) return;
  input.focus();
  const n = input.value.length;
  input.setSelectionRange(n, n);
}

function showPerfilModal() {
  closeFab();
  const s = supervisor();
  const names = nameParts(s || {});
  openAlert(`<div class="modal-back" data-act="dismiss-alert">
    <div class="modal summary-modal" role="dialog" aria-modal="true" data-act="stay">
      ${sectionHead("Perfil", s?.emergencia ? "Supervisor de emergencia. Eres responsable de pedir la comida." : "Supervisor del turno.")}
      <p class="hit-dni">DNI ${esc(s?.dni || s?.id || "—")}</p>
      <h3 class="hit-name">${esc(twoApellidos(s) || "—")}</h3>
      <p class="hit-cargo">${esc([names.nombre, s?.cargo].filter(Boolean).join(" · ") || "—")}</p>
      <div class="footer-actions" style="margin-top:18px">
        <button class="btn ghost" data-act="dismiss-alert" type="button">Cerrar</button>
        <button class="btn" data-act="ask-logout" type="button">Cerrar sesión</button>
      </div>
    </div>
  </div>`);
}

function showUpdatingVeil(phrase = "Actualizando app") {
  closeFab();
  const clearing = /cach[eé]/i.test(phrase);
  const heading = clearing ? "Borrando caché" : "Actualizando app";
  const subtitle = clearing ? "Un momento. Limpiamos este celular." : "Un momento. Traemos la versión nueva.";
  try {
    sessionStorage.setItem("qb_updating", "1");
    sessionStorage.setItem("qb_update_phrase", heading);
  } catch { /* ignore */ }
  document.documentElement.classList.add("is-updating");
  document.documentElement.classList.remove("update-done", "update-full");
  const title = document.getElementById("update-title");
  const sub = document.getElementById("update-sub");
  if (title) title.textContent = heading;
  if (sub) sub.textContent = subtitle;
  const bar = document.getElementById("update-bar");
  const pct = document.getElementById("update-pct");
  if (bar) bar.style.width = "0%";
  if (pct) pct.textContent = "0%";
}

function animateUpdateBar(from, to, ms) {
  return new Promise((resolve) => {
    const bar = document.getElementById("update-bar");
    const pct = document.getElementById("update-pct");
    const start = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - start) / ms);
      const p = Math.round(from + (to - from) * (1 - (1 - t) ** 3));
      if (bar) bar.style.width = `${p}%`;
      if (pct) pct.textContent = `${p}%`;
      if (t < 1) requestAnimationFrame(tick);
      else resolve();
    };
    requestAnimationFrame(tick);
  });
}

function hideUpdatingVeil() {
  const bar = document.getElementById("update-bar");
  const pct = document.getElementById("update-pct");
  if (bar) bar.style.width = "100%";
  if (pct) pct.textContent = "100%";
  try {
    sessionStorage.removeItem("qb_updating");
    sessionStorage.removeItem("qb_update_phrase");
  } catch { /* ignore */ }
  window.setTimeout(() => {
    document.documentElement.classList.add("update-done");
    window.setTimeout(() => {
      document.documentElement.classList.remove("is-updating", "update-done", "update-full");
      const host = document.getElementById("alert-host");
      if (host) host.innerHTML = "";
      document.body.classList.remove("modal-open");
    }, 360);
  }, 450);
}

async function pullLatestFiles() {
  try { localStorage.removeItem("qb_rest_" + CACHE_NAME); } catch { /* sigue */ }
  try {
    navigator.serviceWorker?.controller?.postMessage("CLEAR_APP_CACHE");
  } catch { /* sigue */ }
  try {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
  } catch { /* sigue */ }
  await Promise.all(APP_ASSETS.map((path) =>
    fetch(path, { cache: "reload", credentials: "same-origin" }).catch(() => null)
  ));
  try {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((reg) => {
      try {
        reg.waiting?.postMessage("SKIP_WAITING");
        reg.installing?.postMessage("SKIP_WAITING");
      } catch { /* sigue */ }
      return reg.unregister();
    }));
  } catch { /* sigue */ }
}

async function runAppUpdate(phrase = "Actualizando app") {
  showUpdatingVeil(phrase);
  speak(phrase, { flush: true });
  state.swGuardUntil = Date.now() + 20000;
  const bar = animateUpdateBar(0, 85, 2000);
  await Promise.all([
    flushQueue().catch(() => {}),
    pullLatestFiles(),
  ]);
  await bar;
  await animateUpdateBar(85, 100, 350);
  try { sessionStorage.setItem("qb_updating", "100"); } catch { /* ignore */ }
  document.documentElement.classList.add("update-full");
  const next = new URL(location.href);
  next.searchParams.set("_up", String(Date.now()));
  window.setTimeout(() => location.replace(next.href), 400);
}

function stripUpdateQuery() {
  try {
    const url = new URL(location.href);
    if (!url.searchParams.has("_up")) return;
    url.searchParams.delete("_up");
    const qs = url.searchParams.toString();
    history.replaceState(null, "", `${url.pathname}${qs ? `?${qs}` : ""}${url.hash}`);
  } catch { /* ignore */ }
}

function watchAppUpdates() {
  if (!("serviceWorker" in navigator)) return;
  const ping = () => {
    if (document.visibilityState !== "visible") return;
    navigator.serviceWorker.getRegistration()
      .then((reg) => reg?.update())
      .catch(() => {});
  };
  window.setInterval(ping, 60 * 1000);
  document.addEventListener("visibilitychange", ping);
  window.addEventListener("online", ping);
  window.addEventListener("focus", ping);
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (Date.now() < state.swGuardUntil) return;
    try {
      if (sessionStorage.getItem("qb_updating")) return;
    } catch { /* ignore */ }
    waitThenReload();
  });
}

function waitThenReload() {
  if (state.loggingIn || state.handlingScan || state.busy) {
    window.setTimeout(waitThenReload, 1600);
    return;
  }
  state.swGuardUntil = Date.now() + 20000;
  showUpdatingVeil();
  try { sessionStorage.setItem("qb_updating", "100"); } catch { /* ignore */ }
  location.reload();
}

function versionNewer(local, remote) {
  const a = String(local || "").split(".").map((n) => Number(n) || 0);
  const b = String(remote || "").split(".").map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if ((b[i] || 0) > (a[i] || 0)) return true;
    if ((b[i] || 0) < (a[i] || 0)) return false;
  }
  return false;
}

async function detectAppUpdate() {
  let remote = {};
  try {
    const res = await fetch("./data/config.json", { cache: "reload" });
    remote = await res.json();
  } catch { /* sin red */ }
  let waiting = false;
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) {
      await Promise.race([reg.update(), new Promise((r) => setTimeout(r, 800))]);
      waiting = !!(reg.waiting || reg.installing);
    }
  } catch { /* sin sw */ }
  const latest = String(remote.version || "").trim();
  return {
    latest,
    newer: versionNewer(APP_VERSION, latest) || waiting,
  };
}

function showAjustesModal() {
  closeFab();
  const n = pendingCount();
  openAlert(`<div class="modal-back" data-act="dismiss-alert">
    <div class="modal summary-modal" role="dialog" aria-modal="true" data-act="stay">
      ${sectionHead("Ajustes", "Transferencia, caché y actualización.")}
      <p class="app-ver" id="update-ver">Versión ${esc(APP_VERSION)}</p>
      <p class="update-status" id="transfer-status">${n ? `${n} pendiente${n === 1 ? "" : "s"} en este celular.` : "No hay pendientes."}</p>
      <div class="update-actions">
        <button class="btn leaf" data-act="run-transfer" type="button">Modo transferencia</button>
        <button class="btn leaf" data-act="clear-cache" type="button">Borrar caché</button>
        <button class="btn leaf" data-act="reload-app" type="button">Actualizar</button>
      </div>
    </div>
  </div>`);
  detectAppUpdate().then((info) => {
    const status = document.getElementById("transfer-status");
    const ver = document.getElementById("update-ver");
    if (!status || status.dataset.busy === "1") return;
    if (info.newer) {
      status.textContent = info.latest
        ? `Hay una nueva: ${info.latest}. Pulse Actualizar.`
        : "Hay una actualización. Pulse Actualizar.";
      status.classList.add("new");
      if (ver && info.latest) ver.textContent = `Esta app ${APP_VERSION} · Nueva ${info.latest}`;
    }
  }).catch(() => {});
}

async function runTransferMode() {
  const status = document.getElementById("transfer-status");
  const n = pendingCount();
  if (!n) {
    if (status) status.textContent = "No hay pendientes.";
    speak("Nada por enviar", { flush: true });
    return;
  }
  if (status) {
    status.dataset.busy = "1";
    status.textContent = "Enviando pendientes…";
  }
  try {
    const sum = await flushNow({ notify: false });
    refreshPendPill();
    const left = pendingCount();
    if (sum?.sent && !left) {
      if (status) status.textContent = "Pendientes enviados.";
      speak("Todo enviado", { flush: true });
      return;
    }
    if (left) {
      if (status) status.textContent = "Siguen guardados. Se envían al tener señal, también con la app cerrada en Android.";
      speak("Quedó guardado. Se envía al tener señal.", { flush: true });
      return;
    }
    if (status) status.textContent = "Listo.";
  } catch {
    if (status) status.textContent = "No se pudo ahora. Quedó guardado en este celular.";
    armBackgroundSync();
  }
}

function showUpdateModal() {
  closeFab();
  openAlert(`<div class="modal-back" data-act="dismiss-alert">
    <div class="modal summary-modal" role="dialog" aria-modal="true" data-act="stay">
      ${sectionHead("Actualizar", "Baja la última versión y recarga la app.")}
      <p class="app-ver" id="update-ver">Versión ${esc(APP_VERSION)}</p>
      <p class="update-status" id="update-status">Buscando en el servidor…</p>
      <div class="update-actions">
        <button class="btn leaf" data-act="clear-cache" type="button">Borrar caché</button>
        <button class="btn leaf" data-act="reload-app" type="button">Actualizar app</button>
      </div>
    </div>
  </div>`);
  detectAppUpdate().then((info) => {
    const status = document.getElementById("update-status");
    const ver = document.getElementById("update-ver");
    if (!status) return;
    if (info.newer) {
      status.textContent = info.latest
        ? `Hay una nueva: ${info.latest}. Pulse Actualizar app.`
        : "Hay una actualización. Pulse Actualizar app.";
      status.classList.add("new");
      if (ver && info.latest) ver.textContent = `Esta app ${APP_VERSION} · Nueva ${info.latest}`;
    } else {
      status.textContent = "Al día. Igual puede pulsar Actualizar app para bajar lo último.";
      status.classList.add("ok");
    }
  }).catch(() => {
    const status = document.getElementById("update-status");
    if (status) status.textContent = "Sin red. Pulse Actualizar app cuando tenga señal.";
  });
}

function rememberDni(person) {
  const id = normalizeDni(person?.dni || person?.id);
  if (!id) return;
  store.upsertDniGuardado({
    id,
    dni: id,
    apellido: person.apellido || twoApellidos(person),
    nombre: person.nombre || nameParts(person).nombre,
    cargo: person.cargo || person.area || "",
    temporal: !!person.temporal,
    ...(personSexo(person) ? { sexo: personSexo(person) } : {}),
  });
}

function hydrateDniGuardados() {
  for (const p of getMesa()) rememberDni(p);
  for (const r of recordsOfToday(TZ)) {
    if (r.type !== "lista") continue;
    for (const p of r.payload?.personas || []) rememberDni(p);
  }
}

function filteredDniGuardados() {
  const q = pickNorm(state.dniQuery || "");
  const compact = q.replace(/\s/g, "");
  return store.getDniGuardados().filter((p) => {
    if (!q) return true;
    const hay = pickNorm(`${p.dni || p.id || ""} ${p.apellido || ""} ${p.nombre || ""} ${p.cargo || ""}`);
    return hay.includes(q) || hay.replace(/\s/g, "").includes(compact);
  });
}

function dniSelectedIds() {
  return Object.keys(state.dniSelected || {}).filter((id) => state.dniSelected[id]);
}

function focusDniSearch() {
  const input = document.getElementById("dni-search");
  if (!input) return;
  input.focus();
  const n = input.value.length;
  input.setSelectionRange(n, n);
}

function showDniModal() {
  closeFab();
  hydrateDniGuardados();
  if (!state.dniSelected) state.dniSelected = {};
  const all = filteredDniGuardados();
  const pages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
  state.dniPage = Math.min(Math.max(1, state.dniPage || 1), pages);
  const start = (state.dniPage - 1) * PAGE_SIZE;
  const rows = all.slice(start, start + PAGE_SIZE);
  const nSel = dniSelectedIds().length;
  const allOn = all.length > 0 && all.every((p) => state.dniSelected[p.id]);
  const list = rows.map((p) => {
    const onMesa = getMesa().some((m) => m.id === p.id);
    const sel = !!state.dniSelected[p.id];
    return `<button type="button" class="dni-row${sel ? " sel" : ""}" data-act="toggle-dni" data-id="${esc(p.id)}">
      <span class="dni-check${sel ? " on" : ""}" aria-hidden="true"></span>
      ${avatarHtml(p, "sm")}
      <div>
        <b>${esc(p.apellido || "—")}</b>
        <div class="meta">DNI ${esc(p.dni || p.id)} · ${esc(p.nombre || "")}</div>
      </div>
      <span class="st ${onMesa ? "ok" : "now"}">${onMesa ? "En lista" : (sel ? "Listo" : "Elegir")}</span>
    </button>`;
  }).join("") || `<p class="sub">Aún no hay DNI. Cuando el supervisor guarda a alguien bien, queda aquí.</p>`;
  const q = state.dniQuery || "";
  openAlert(`<div class="modal-back" data-act="dismiss-alert">
    <div class="modal summary-modal" role="dialog" aria-modal="true" data-act="stay">
      ${sectionHead("DNI guardados", "Marque quién entra a la lista. Puede elegir todos o solo algunos.")}
      <input id="dni-search" class="dni-search" type="search" enterkeyhint="search" autocomplete="off" placeholder="Buscar DNI o apellido" value="${esc(q)}">
      ${all.length ? `<div class="dni-toolbar">
        <button type="button" class="dni-all" data-act="toggle-dni-all">
          <span class="dni-check${allOn ? " on" : ""}" aria-hidden="true"></span>
          Seleccionar todo
        </button>
        <span class="dni-count">${nSel} de ${all.length}</span>
      </div>` : ""}
      <div class="dni-list">${list}</div>
      ${pagerHtml(state.dniPage, pages, "dni-page-prev", "dni-page-next")}
      <div class="footer-actions">
        <button class="btn ghost" data-act="dismiss-alert" type="button">Cerrar</button>
        <button class="btn leaf" data-act="use-saved-dnis" type="button"${nSel ? "" : " disabled"}>Usar${nSel ? ` (${nSel})` : ""}</button>
      </div>
    </div>
  </div>`);
}

function applyTempSexo(sexo) {
  document.querySelectorAll("#fTempSexo .sexo-opt").forEach((el) => {
    const on = !!sexo && el.dataset.sexo === sexo;
    el.classList.toggle("on", on);
    el.setAttribute("aria-pressed", on ? "true" : "false");
  });
}

function fillTempFromDni() {
  const input = document.getElementById("tempDni");
  const name = document.getElementById("tempNombre");
  if (!input || !name) return;
  const clean = String(input.value || "").replace(/\D/g, "").slice(0, 8);
  if (input.value !== clean) input.value = clean;
  const official = clean.length === 8 ? findOfficial(clean) : null;
  if (official) {
    name.value = displayName(official);
    name.dataset.auto = "1";
    applyTempSexo(personSexo(official));
    document.getElementById("fTempDni")?.classList.remove("bad");
    document.getElementById("fTempNom")?.classList.remove("bad");
    if (personSexo(official)) document.getElementById("fTempSexo")?.classList.remove("bad");
    return;
  }
  if (name.dataset.auto === "1") {
    name.value = "";
    delete name.dataset.auto;
    applyTempSexo("");
  }
  if (clean.length === 8) document.getElementById("fTempDni")?.classList.remove("bad");
}

function showTempPersonModal() {
  ensureWorkers().then(() => {
    const input = document.getElementById("tempDni");
    if (input && String(input.value || "").replace(/\D/g, "").length === 8) fillTempFromDni();
  });
  openAlert(`<div class="modal-back" data-act="dismiss-alert">
    <div class="modal summary-modal" role="dialog" aria-modal="true" data-act="stay">
      ${sectionHead("Persona temporal", "Escriba el DNI. Si está en la base, el nombre y el avatar se llenan solos. Si no está, el nombre es obligatorio.")}
      <div class="field" id="fTempDni">
        <label>DNI</label>
        <input id="tempDni" inputmode="numeric" maxlength="8" autocomplete="off" placeholder="8 dígitos">
      </div>
      <div class="field" id="fTempNom">
        <label>Nombre</label>
        <input id="tempNombre" autocomplete="off" placeholder="Apellidos y nombres" autocapitalize="characters">
      </div>
      <div class="field" id="fTempSexo">
        <label>Avatar</label>
        <div class="sexo-pick">
          <button type="button" class="sexo-opt" data-act="pick-sexo" data-sexo="M">
            <img src="./assets/hombre.png" alt="" width="72" height="72" decoding="async">
            <span>Hombre</span>
          </button>
          <button type="button" class="sexo-opt" data-act="pick-sexo" data-sexo="F">
            <img src="./assets/mujer.png" alt="" width="72" height="72" decoding="async">
            <span>Mujer</span>
          </button>
        </div>
        <span class="hint">Elija hombre o mujer.</span>
      </div>
      <div class="footer-actions" style="margin-top:8px">
        <button class="btn ghost" data-act="dismiss-alert" type="button">Cerrar</button>
        <button class="btn leaf" data-act="save-temp-person" type="button">Guardar</button>
      </div>
    </div>
  </div>`);
  window.setTimeout(() => document.getElementById("tempDni")?.focus(), 50);
}

function showLogoutWarn() {
  closeFab();
  openAlert(`<div class="modal-back" data-act="dismiss-alert">
    <div class="modal" role="dialog" aria-modal="true" data-act="stay">
      <h3>¿Cerrar sesión?</h3>
      <p>Se borran los DNI guardados en este celular y la lista de hoy.</p>
      <div class="footer-actions">
        <button class="btn ghost" data-act="dismiss-alert" type="button">No</button>
        <button class="btn" data-act="logout" type="button">Cerrar sesión</button>
      </div>
    </div>
  </div>`);
}

function pairFooter(cancelAct, cancelLabel, okAct, okLabel, okDisabled = false) {
  return `<footer class="footer">
    <div class="form-actions">
      <button type="button" class="btn btn-ghost" data-act="${esc(cancelAct)}">${esc(cancelLabel)}</button>
      <button type="button" class="btn btn-primary" data-act="${esc(okAct)}"${okDisabled ? " disabled" : ""}>${esc(okLabel)}</button>
    </div>
  </footer>`;
}

function soloFooter(okAct, okLabel, okDisabled = false) {
  return `<footer class="footer">
    <div class="form-actions solo">
      <button type="button" class="btn btn-primary" data-act="${esc(okAct)}"${okDisabled ? " disabled" : ""}>${esc(okLabel)}</button>
    </div>
  </footer>`;
}

function footer(active, extra = "") {
  return extra ? `<footer class="footer">${extra}</footer>` : "";
}

function lotePills() {
  const extra = !!state.extraOn || !!state.extraHold;
  return `<div class="lote-pills" role="group" aria-label="Comida">
    <button type="button" class="${extra ? "" : "on"}" data-act="set-lote" data-id="Almuerzo">Almuerzo</button>
    <button type="button" class="extra${extra ? " on" : ""}" data-act="toggle-extra">Extra</button>
  </div>`;
}

function loteCard() {
  const locked = isSendLocked();
  const extra = !!state.extraOn;
  return `<section class="section-card">
    ${extra ? `<p class="extra-note">Modo extra activo. Se olvidó o llegó tarde. Va a Comidas extras.</p>` : ""}
    ${locked ? `<p class="extra-note">Ya envió el almuerzo. Pulse Extra si falta alguien.</p>` : ""}
    ${!locked && !extra && !navigator.onLine ? `<p class="extra-note">Sin señal. Puede escanear y enviar.</p>` : ""}
    ${sectionHead("Turno", extra ? "Escanee solo a quien falta. Entra como extra." : "Almuerzo o Extra. Después presente el QR de cada persona.")}
    ${lotePills()}
  </section>`;
}

const COMEDORES_POR_FUNDO = {
  "LICAPA I": [
    "Comedor 1",
    "Comedor 2",
    "Comedor 3",
    "Comedor 4",
    "Comedor 5",
    "Galpon",
    "Oficina Tecnica",
    "Comedor Administrativo",
  ],
  "LICAPA II": [
    "Comedor 6",
    "Comedor 7",
    "Comedor 8",
    "Comedor 9",
    "Comedor 10",
    "Comedor Principal - II",
  ],
  "LICAPA III": ["Comedor 11"],
};

function comedores(fundo = currentFundo()) {
  return COMEDORES_POR_FUNDO[fundo] || COMEDORES_POR_FUNDO["LICAPA I"];
}

function fundos() {
  return ["LICAPA I", "LICAPA II", "LICAPA III"];
}

function currentFundo() {
  const list = fundos();
  const saved = store.getPrefs().fundo || store.getPrefs().etapa;
  return list.includes(saved) ? saved : list[0];
}

function currentEtapa() {
  return currentFundo();
}

function currentComedor() {
  const list = comedores();
  const saved = store.getPrefs().comedor;
  return list.includes(saved) ? saved : list[0];
}

function pickNorm(s) {
  return String(s || "").toLowerCase().replace(/[·•.,\-_/]/g, " ").replace(/\s+/g, " ").trim();
}

function pickSelect(id, value, options, searchable = false) {
  const current = options.find(([val]) => val === value) || options[0] || ["", "—"];
  const rows = options.map(([val, lab]) => {
    const on = val === current[0];
    return `<button type="button" class="pick-opt${on ? " on" : ""}" data-act="pick-opt" data-pick="${esc(id)}" data-id="${esc(val)}" data-label="${esc(lab)}" data-search="${esc(`${val} ${lab}`)}">${esc(lab)}</button>`;
  }).join("");
  const search = searchable
    ? `<input class="pick-search" type="search" inputmode="search" placeholder="Buscar lote, módulo o turno" autocomplete="off" />`
    : "";
  const empty = searchable ? `<p class="pick-empty" hidden>Ningún lote coincide.</p>` : "";
  return `<div class="pick" data-pick="${esc(id)}" data-value="${esc(current[0])}">
    <button type="button" class="pick-btn" data-act="pick-open" data-pick="${esc(id)}">
      <span class="pick-value">${esc(current[1])}</span>
    </button>
    <div class="pick-panel" hidden>
      ${search}
      <div class="pick-list">${rows}</div>
      ${empty}
    </div>
  </div>`;
}

function closePicks() {
  document.querySelectorAll(".pick.open").forEach((el) => {
    el.classList.remove("open");
    const panel = el.querySelector(".pick-panel");
    const input = el.querySelector(".pick-search");
    if (panel) panel.hidden = true;
    if (input) {
      input.value = "";
      filterPick(el, "");
    }
  });
}

function filterPick(wrap, query) {
  const q = pickNorm(query);
  const compact = q.replace(/\s/g, "");
  let n = 0;
  wrap.querySelectorAll(".pick-opt").forEach((opt) => {
    const hay = pickNorm(opt.dataset.search || opt.textContent || "");
    const hayC = hay.replace(/\s/g, "");
    const ok = !q || hay.includes(q) || hayC.includes(compact);
    opt.hidden = !ok;
    if (ok) n += 1;
  });
  const empty = wrap.querySelector(".pick-empty");
  if (empty) empty.hidden = n > 0;
}

function onPickInput(e) {
  if (e.target.id === "tempDni") {
    fillTempFromDni();
    return;
  }
  if (e.target.id === "tempNombre") {
    delete e.target.dataset.auto;
    if (String(e.target.value || "").trim()) document.getElementById("fTempNom")?.classList.remove("bad");
    return;
  }
  if (e.target.id === "dni-login") {
    const clean = String(e.target.value || "").replace(/\D/g, "").slice(0, 8);
    if (e.target.value !== clean) e.target.value = clean;
    if (clean.length === 8) document.getElementById("fDniLogin")?.classList.remove("bad");
    return;
  }
  if (e.target.id === "dni-search") {
    state.dniQuery = e.target.value;
    state.dniPage = 1;
    showDniModal();
    const input = document.getElementById("dni-search");
    if (input) {
      input.focus();
      const n = input.value.length;
      input.setSelectionRange(n, n);
    }
    return;
  }
  if (e.target.id === "hist-search") {
    state.histPeopleQuery = e.target.value.replace(/\D/g, "").slice(0, 8);
    state.histPeoplePage = 1;
    showHistorialModal();
    focusHistSearch();
    return;
  }
  if (!e.target.classList.contains("pick-search")) return;
  const wrap = e.target.closest(".pick");
  if (wrap) filterPick(wrap, e.target.value);
}

function onPickKey(e) {
  if (e.key === "Escape") closePicks();
  if (e.key === "Enter" && e.target.id === "dni-login") {
    e.preventDefault();
    e.target.closest(".modal")?.querySelector('[data-act="submit-dni-login"]')?.click();
    return;
  }
  if (e.key === "Enter" && e.target.classList.contains("pick-search")) {
    e.target.closest(".pick")?.querySelector(".pick-opt:not([hidden])")?.click();
  }
}

function authLabel() {
  const s = supervisor();
  if (!s) return "—";
  return twoApellidos(s) || s.apellido || s.nombreCompleto || "—";
}

function mealWord(lote, n) {
  const map = {
    Desayuno: ["desayuno", "desayunos"],
    Almuerzo: ["almuerzo", "almuerzos"],
    Cena: ["cena", "cenas"],
  };
  const pair = map[lote] || ["pedido", "pedidos"];
  return n === 1 ? pair[0] : pair[1];
}

function comedorPills() {
  const cur = currentComedor();
  return `<div class="lote-pills comedor-pills" role="group" aria-label="Comedor">
    ${comedores().map((name) => `<button type="button" class="${cur === name ? "on" : ""}" data-act="set-comedor" data-id="${esc(name)}">${esc(name)}</button>`).join("")}
  </div>`;
}

function ensureAlertHost() {
  let host = document.getElementById("alert-host");
  if (!host) {
    host = document.createElement("div");
    host.id = "alert-host";
    document.body.appendChild(host);
  }
  if (!host.dataset.bound) {
    host.dataset.bound = "1";
    host.addEventListener("click", onClick);
    host.addEventListener("input", onPickInput);
    host.addEventListener("keydown", onPickKey);
  }
  return host;
}

function openAlert(html) {
  ensureAlertHost().innerHTML = html;
  document.body.classList.add("modal-open");
}

function showSummaryModal() {
  const mesa = getMesa();
  const meal = currentLote();
  const n = mesaMealCount(mesa);
  const fundoOpts = fundos().map((name) => [name, name]);
  const comedorOpts = comedores().map((name) => [name, name]);
  openAlert(`<div class="modal-back" data-act="dismiss-alert">
    <div class="modal summary-modal" role="dialog" aria-modal="true" data-act="stay">
      <div class="summary-top">
        ${sectionHead("Solicitud de almuerzo", state.extraOn ? "Entra como extra (se olvidó o llegó tarde). Va a Comidas extras." : "Almuerzo normal. Confirme fundo y comedor antes de enviar.")}
      </div>
      <div class="summary-stat">
        <b>${n}</b>
        <span>${n} ${n === 1 ? "solicitud" : "solicitudes"} de ${mealWord(meal, n)}</span>
      </div>
      <p class="summary-auth"><span>Autoriza</span><strong>${esc(authLabel())}</strong></p>
      <div class="summary-fields">
        <div class="pick-field">
          <p class="pick-label">Fundo</p>
          ${pickSelect("sel-fundo", currentFundo(), fundoOpts)}
        </div>
        <div class="pick-field">
          <p class="pick-label">Comedor</p>
          ${pickSelect("sel-comedor", currentComedor(), comedorOpts)}
        </div>
      </div>
      <div class="footer-actions">
        <button class="btn ghost" data-act="dismiss-alert" type="button">Cerrar</button>
        <button class="btn leaf" data-act="send-lista" type="button"${n ? "" : " disabled"}>${state.extraOn ? "Enviar extra" : "Enviar normal"}</button>
      </div>
    </div>
  </div>`);
}

function pageSlice(list, page = state.mesaPage) {
  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  const safe = Math.min(Math.max(1, page), pages);
  state.mesaPage = safe;
  const start = (safe - 1) * PAGE_SIZE;
  return { rows: list.slice(start, start + PAGE_SIZE), page: safe, pages, total: list.length };
}

function pagerHtml(page, pages, prevAct = "page-prev", nextAct = "page-next") {
  if (pages <= 1) return "";
  return `<div class="pager">
    <button type="button" data-act="${esc(prevAct)}" ${page <= 1 ? "disabled" : ""}>‹</button>
    <span>${page} / ${pages}</span>
    <button type="button" data-act="${esc(nextAct)}" ${page >= pages ? "disabled" : ""}>›</button>
  </div>`;
}

function render(html) {
  document.getElementById("app").innerHTML = html;
  const scroll = document.querySelector(".scroll");
  if (scroll) preventBounce(scroll);
}

function showAlert(title, text) {
  speak(text);
  openAlert(`<div class="modal-back" data-act="dismiss-alert">
    <div class="modal" role="dialog" aria-modal="true" data-act="stay">
      <button class="modal-close" data-act="dismiss-alert" type="button" aria-label="Cerrar"><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M6.2 5.1 5.1 6.2 10.9 12l-5.8 5.8 1.1 1.1L12 13.1l5.8 5.8 1.1-1.1L13.1 12l5.8-5.8-1.1-1.1L12 10.9 6.2 5.1z"/></svg></button>
      <h3>${esc(title)}</h3>
      <p>${esc(text)}</p>
      <button class="btn" data-act="dismiss-alert" type="button">Entendido</button>
    </div>
  </div>`);
}

function dismissAlert() {
  document.getElementById("alert-host")?.replaceChildren();
  document.body.classList.remove("modal-open");
}

function alertIsOpen() {
  return !!document.getElementById("alert-host")?.childElementCount;
}

function resumeCam() {
  if (state.loggingIn) return;
  if (state.view !== "supervisor" && state.view !== "home") return;
  const video = document.getElementById("cam");
  if (video?.srcObject && scanner.active) {
    scanner.resume();
    scanner.setBusy(!!state.isProcessing);
    video.play().catch(() => {});
    return;
  }
  startCamHere();
}

function unlockWorkerScan(dni) {
  const key = normalizeDni(dni) || scanner.emitKey(dni);
  if (key && (normalizeDni(state.lastProcessedQR) === key || state.lastProcessedQR === key)) {
    state.lastProcessedQR = "";
    state.lastProcessedAt = 0;
  }
  if (key && state.lastRepeatQR === key) {
    state.lastRepeatQR = "";
    state.lastRepeatAt = 0;
  }
  if (key && state.lastDetectedQR === key) state.lastDetectedQR = "";
  scanner.forget(key || dni);
  state.handlingScan = false;
  state.isProcessing = false;
  scanner.setBusy(false);
  resumeCam();
}

function welcomeView() {
  render(`<section class="welcome">
    <div class="welcome-hero">
      <figure class="welcome-frame">
        <img src="./assets/entrada.png" alt="" width="270" height="320" decoding="async" fetchpriority="high" />
      </figure>
    </div>
    <div class="welcome-sheet">
      <h1>Pide tu <span>comida</span></h1>
      <p>Rica, rápida y lista para el turno.</p>
      <div class="dots" aria-hidden="true"><i class="on"></i><i></i><i></i></div>
      <button class="cta" data-act="enter" type="button">Empezar</button>
      ${installSlot()}
    </div>
  </section>`);
}

function lockView() {
  render(`<section class="lock">
    <div class="welcome-hero">
      <figure class="welcome-frame">
        <img src="./assets/entrada.png" alt="" />
      </figure>
    </div>
    <h1>Ábrela en el celular</h1>
    <p>Esta app es solo para el teléfono. En computadora no se usa.</p>
  </section>`);
}

function qrIcon() {
  return `<svg class="qr-ic" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M3 3h8v8H3zm2 2v4h4V5zm8-2h8v8h-8zm2 2v4h4V5zM3 13h8v8H3zm2 2v4h4v-4zm10-2h3v3h-3zm5 0h3v3h-3zm-5 5h3v5h-3zm5 5h3v3h-3zm-2-3h2v2h-2z"/></svg>`;
}

function camActions() {
  return `<div class="cam-actions">
    <button class="btn cam" data-act="start-cam" type="button">${qrIcon()} Activar cámara QR</button>
    <button class="btn stop" data-act="stop-cam" type="button">Detener cámara</button>
  </div>`;
}

function scanBox() {
  return `<div class="scan-wrap">
    <div class="scan-row">
      <div class="scan-box">
        <video id="cam" autoplay playsinline muted></video>
        <div class="finder-sq"></div>
      </div>
    </div>
    ${camActions()}
  </div>`;
}

function dniHeadBtn() {
  const emerg = !!state.emergencyPending;
  return `<button class="scan-dni-btn${emerg ? " on" : ""}" data-act="open-dni-login" type="button" aria-label="${emerg ? "Entrar con DNI de cualquiera" : "Entrar con DNI de supervisor"}">${userIcon()}</button>`;
}

function framesReady(video, ms) {
  if (!video) return Promise.resolve(false);
  if (video.videoWidth > 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    const t0 = performance.now();
    const tick = () => {
      if (!video.isConnected) { resolve(false); return; }
      if (video.videoWidth > 0) { resolve(true); return; }
      if (performance.now() - t0 >= ms) { resolve(false); return; }
      window.requestAnimationFrame(tick);
    };
    tick();
  });
}

function startCamHere(fromTap = false) {
  const video = document.getElementById("cam");
  if (!video) return;
  if (fromTap) state.camOff = false;
  if (state.camOff) return;
  if (!fromTap && scanner.isLiveOn(video) && video.videoWidth > 0) {
    scanner.bindHandlers(onScan, onScanBusy);
    scanner.setBusy(!!state.isProcessing);
    scanner.resume();
    setScanLive(state.isProcessing ? "Procesando…" : "Cámara lista. Acerca el QR al recuadro.");
    return;
  }
  setScanLive("Abriendo cámara…");
  scanner.start(video, onScan, onScanBusy, { gesture: fromTap }).then(async (ok) => {
    if (ok === false) return;
    const cam = document.getElementById("cam");
    const ready = await framesReady(cam, 1600);
    if (!ready) {
      setScanLive("Toca Activar cámara QR y permite el acceso.", false);
      if (fromTap) speak("Toca Activar cámara QR y permite el acceso.", { flush: true });
      return;
    }
    scanner.setBusy(!!state.isProcessing);
    scanner.resume();
    setScanLive(state.isProcessing ? "Procesando…" : "Cámara lista. Acerca el QR al recuadro.");
  }).catch(() => {
    setScanLive("Toca Activar cámara QR y permite el acceso.", false);
    if (fromTap) speak("Toca Activar cámara QR y permite el acceso.", { flush: true });
  });
}

function showScanToast(text, ms = 1600) {
  let el = document.getElementById("scan-toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "scan-toast";
    el.className = "scan-toast";
    el.setAttribute("role", "status");
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.classList.add("on");
  window.clearTimeout(state.scanToastTimer);
  state.scanToastTimer = window.setTimeout(() => {
    el.classList.remove("on");
  }, ms);
}

function hideScanToast() {
  window.clearTimeout(state.scanToastTimer);
  document.getElementById("scan-toast")?.classList.remove("on");
}

function personOnMesa(dni) {
  const key = normalizeDni(dni);
  if (!key) return null;
  const row = getMesa().find((p) => normalizeDni(p.id) === key);
  if (!row) return null;
  return findWorkerByDni(key) || personFromSaved(key) || {
    dni: key,
    id: key,
    apellido: row.apellido || "",
    nombre: row.nombre || "",
    cargo: row.cargo || "",
    temporal: !!row.temporal,
  };
}

function nameSpeechBusy(key) {
  return !!(key && state.speechLockDni === key && Date.now() < state.speechLockUntil);
}

function holdNameSpeech(worker) {
  const dni = normalizeDni(worker?.dni || worker?.id);
  if (!dni) return;
  const pauseMs = 900;
  state.speechLockDni = dni;
  state.speechLockUntil = Date.now() + 15000;
  const release = () => {
    if (state.speechLockDni !== dni) return;
    state.speechLockUntil = Date.now() + pauseMs;
    window.setTimeout(() => {
      if (state.speechLockDni === dni) state.speechLockDni = "";
    }, pauseMs);
  };
  const name = prepareSpeakName(worker);
  if (!name || !voiceEnabled()) {
    release();
    return;
  }
  speak(name, { onDone: release });
}

function warnRepeatedPerson(dni, worker = null) {
  const key = normalizeDni(dni) || String(dni || "");
  const now = Date.now();
  if (nameSpeechBusy(key)) return;
  if (key && key === state.lastProcessedQR && now - (state.lastProcessedAt || 0) < 1100) {
    return;
  }
  if (key && key === state.lastRepeatQR && now - (state.lastRepeatAt || 0) < 2500) return;
  state.lastRepeatQR = key;
  state.lastRepeatAt = now;
  const who = worker || personOnMesa(key);
  const nombre = who
    ? (prepareSpeakName(who) || twoApellidos(who) || "Persona")
    : "Persona";
  try {
    showScanHit({
      dni: key || "—",
      nombre,
      cargo: who ? [nameParts(who).nombre, who.cargo].filter(Boolean).join(" · ") : "Ya está en la lista",
      ok: false,
      stateLabel: "Repetida",
      note: "Persona repetida.",
    });
    showScanToast("Persona repetida.");
    speak("Persona repetida.", { flush: true });
  } catch { /* voz/UI no bloquean el siguiente QR */ }
}

function notifyScanWait() {
  showScanToast("Un momento, intenta con otro.");
  setScanLive("Un momento.", false);
  const now = Date.now();
  if (now - (state.scanWaitSpeakAt || 0) > 2800 && !isSpeaking()) {
    state.scanWaitSpeakAt = now;
    try { speak("Un momento."); } catch { /* voz no bloquea */ }
  }
}

function onScanBusy(_raw, key) {
  const dni = normalizeDni(key);
  if (state.scanMode === "wrk" && dni && personOnMesa(dni)) {
    warnRepeatedPerson(dni);
    return;
  }
  if (!state.isProcessing && !state.handlingScan) return;
  if (key && key === state.lastDetectedQR) return;
  notifyScanWait();
}

function goScan(mode) {
  state.scanMode = mode;
  if (mode === "wrk") state.formType = "pedido";
  if (mode === "sup") show("supervisor");
  else show("home");
}

function forkIcon() {
  return `<span class="fork" aria-hidden="true"><svg viewBox="0 0 32 32" width="20" height="20"><path fill="currentColor" d="M8 3h2.1v8.4c0 .6.5 1.1 1.1 1.1s1.1-.5 1.1-1.1V3H14.4v8.4c0 .6.5 1.1 1.1 1.1s1.1-.5 1.1-1.1V3H18.8v8.6a4.7 4.7 0 0 1-3.7 4.6V29h-2.3V16.2A4.7 4.7 0 0 1 8 11.6V3z"/></svg></span>`;
}

function avatarHtml(person, size = "") {
  const sex = personSexo(person);
  const cls = `avatar${size ? ` ${size}` : ""}`;
  if (sex !== "M" && sex !== "F") return `<span class="${cls} ph" aria-hidden="true"></span>`;
  const src = sex === "F" ? "./assets/mujer.png" : "./assets/hombre.png";
  return `<img class="${cls}" src="${src}" alt="" decoding="async" draggable="false">`;
}

function getMesa() {
  return store.getMesa();
}

function setMesa(list) {
  store.setMesa(list);
}

function upsertMesa(person) {
  const id = normalizeDni(person.id || person.dni);
  if (!id) return;
  const prev = getMesa().find((p) => normalizeDni(p.id) === id);
  const row = { ...person, id, dni: person.dni || id, menus: menuQty(prev) };
  setMesa([row, ...getMesa().filter((p) => normalizeDni(p.id) !== id)]);
}

function removeMesaPerson(id) {
  const key = normalizeDni(id);
  if (!key) return;
  const day = todayKey(TZ);
  setMesa(getMesa().filter((p) => normalizeDni(p.id) !== key));
  store.removeCola(`scan:${day}:${key}`);
  for (const r of store.getCola()) {
    if ((r.type === "pedido" || r.type === "especial") && normalizeDni(r.payload?.trabajador_id) === key) {
      store.removeCola(r.clientId);
    }
  }
}

function askDropMesa(id, name) {
  const dni = normalizeDni(id);
  if (!dni) return;
  const who = getMesa().find((p) => normalizeDni(p.id) === dni);
  const label = String(displayName(who) || name || dni).trim();
  openAlert(`<div class="modal-back" data-act="dismiss-alert">
    <div class="modal" role="dialog" aria-modal="true" data-act="stay">
      <h3>¿Quitar de la lista?</h3>
      <p>${esc(label)} · DNI ${esc(dni)}</p>
      <div class="footer-actions">
        <button class="btn ghost" data-act="dismiss-alert" type="button">No</button>
        <button class="btn" data-act="drop-mesa" data-id="${esc(dni)}" type="button">Quitar</button>
      </div>
    </div>
  </div>`);
}

function refreshPendPill() {
  const wrap = document.querySelector(".appbar-status");
  if (!wrap) return;
  const n = pendingCount();
  const online = !!(state.online && navigator.onLine);
  let net = wrap.querySelector(".pill.live, .pill.off");
  if (!net) {
    net = document.createElement("span");
    wrap.insertBefore(net, wrap.firstChild);
  }
  net.className = `pill ${online ? "live" : "off"}`;
  net.innerHTML = `<i></i>${online ? "En línea" : "Sin señal"}`;
  let pill = wrap.querySelector(".pill.pend");
  if (!pill) {
    pill = document.createElement("button");
    pill.type = "button";
    pill.className = "pill pend";
    pill.dataset.act = "flush-pend";
    pill.setAttribute("aria-label", "Enviar pendientes y avisar");
    wrap.appendChild(pill);
  }
  pill.className = "pill pend";
  pill.innerHTML = `<i class="up"></i>${n} pend.`;
}

function supervisorAsMealPerson(person) {
  const dni = normalizeDni(person?.dni || person?.id);
  if (!dni) return null;
  const parsed = nameParts(person);
  const apellido = parsed.apellido || twoApellidos(person) || "";
  const nombre = parsed.nombre || "";
  return {
    dni,
    id: dni,
    apellido,
    nombre,
    nombreCompleto: parsed.nombreCompleto || [apellido, nombre].filter(Boolean).join(" "),
    cargo: person.cargo || (person.emergencia ? "Supervisor de emergencia" : "Supervisor"),
    temporal: !!person.emergencia,
    ...(personSexo(person) ? { sexo: personSexo(person) } : {}),
  };
}

function offerSupervisorOwnLunch(person) {
  // Solo en almuerzo normal al iniciar. Nunca en Extra ni si ya envió hoy.
  if (state.extraOn || hasSavedSend() || isSendLocked()) return;
  const worker = supervisorAsMealPerson(person);
  if (!worker) return;
  registerPerson(worker, { silent: true });
  if (state.extraOn || hasSavedSend() || isSendLocked()) {
    store.clearMesa();
    return;
  }
  refreshMesaUi();
  showSupervisorLunchModal(worker);
}

function showSupervisorLunchModal(worker) {
  const label = displayName(worker) || worker.dni;
  scanner.pause();
  openAlert(`<div class="modal-back" data-act="stay">
    <div class="modal summary-modal" role="dialog" aria-modal="true" data-act="stay">
      ${sectionHead("Almuerzo del supervisor", "Ya tenemos un almuerzo cargado por el supervisor. Así no escanea dos veces. Si desea, puede eliminarlo.")}
      <p class="extra-note">DNI ${esc(worker.dni)} · ${esc(label)}</p>
      <div class="footer-actions" style="margin-top:8px">
        <button class="btn ghost" data-act="drop-sup-lunch" data-id="${esc(worker.dni)}" type="button">Eliminar</button>
        <button class="btn leaf" data-act="keep-sup-lunch" type="button">Dejarlo</button>
      </div>
    </div>
  </div>`);
  speak("Almuerzo del supervisor cargado. Puede dejarlo o eliminarlo.", { flush: true });
}

function scanHelp() {
  return `<aside class="scan-help">
    <p class="scan-help-title">Qué hacer</p>
    <ol>
      <li>Verde: solo supervisores. Escanee su QR o escriba el DNI.</li>
      <li>Rojo: cualquier persona, por emergencia. También puede escribir el DNI.</li>
      <li>Si entra en rojo, usted pide la comida. Tenga cuidado.</li>
    </ol>
  </aside>`;
}

function showEmergencyWarn() {
  openAlert(`<div class="modal-back" data-act="dismiss-alert">
    <div class="modal summary-modal" role="dialog" aria-modal="true" data-act="stay">
      ${sectionHead("Cualquier persona", "El botón rojo deja entrar a cualquiera. Serás responsable de solicitar la comida. Escanea tu QR o escribe el DNI. Después podrás elegir fundo y comedor.")}
      <p class="extra-note">Ten cuidado, por favor. Esto es solo por emergencia.</p>
      <div class="footer-actions solo" style="margin-top:8px">
        <button class="btn leaf" data-act="confirm-emergency" type="button">Entendido</button>
      </div>
    </div>
  </div>`);
}

function setEmergencyUi(on) {
  document.querySelector(".emerg-fab")?.classList.toggle("on", on);
  document.querySelector(".scan-panel")?.classList.toggle("is-emerg", on);
  document.querySelector(".scan-dni-btn")?.classList.toggle("on", on);
  document.querySelector(".scan-dni-btn")?.setAttribute("aria-label", on ? "Entrar con DNI de cualquiera" : "Entrar con DNI de supervisor");
  const tag = document.getElementById("access-tag");
  if (tag) {
    tag.className = `access-tag ${on ? "red" : "green"}`;
    tag.textContent = on ? "Cualquier persona" : "Solo supervisores";
  }
  const sub = document.querySelector(".scan-panel .scan-head .section-head p");
  if (sub) {
    sub.textContent = "Escanea tu QR o escribe el DNI.";
  }
  const bar = document.querySelector(".appbar-titles p");
  if (bar) bar.textContent = on ? "Rojo · cualquier persona" : "Verde · solo supervisores";
  setScanLive(on ? "Escanea tu QR o escribe el DNI. Cualquier persona puede entrar." : "Listo para escanear el QR o escribir el DNI.", true);
}

function toggleEmergencySup() {
  if (state.loggingIn) return;
  if (state.emergencyPending) {
    state.emergencyPending = false;
    dismissAlert();
    speak("Verde. Solo supervisores.", { flush: true });
    setEmergencyUi(false);
    resumeCam();
    return;
  }
  state.emergencyPending = true;
  speak("Rojo. Cualquier persona puede entrar. Ten cuidado, por favor.", { flush: true });
  setEmergencyUi(true);
  showEmergencyWarn();
}

function enterEmergencySupervisor(person) {
  const dni = normalizeDni(person?.dni || person?.id);
  if (!isSesionDni(dni)) {
    speak("Código no válido. Solo el DNI.");
    showScanHit({
      dni: dni || "—",
      nombre: "No se leyó un DNI",
      cargo: "—",
      ok: false,
      note: "Acerca de nuevo el código.",
    });
    return;
  }
  const official = findSupervisor({ dni });
  if (official) {
    showLoginGate({ ...official, emergencia: true });
    return;
  }
  // No está en supervisores: siempre pedir nombre antes de entrar
  // (así sale bien en app/servidor y el primer envío va como almuerzo normal).
  const parsed = nameParts(person);
  const prefill = [parsed.apellido, parsed.nombre].filter(Boolean).join(" ")
    || parsed.nombreCompleto
    || "";
  showEmergencyNameModal(dni, prefill);
}

function showEmergencyNameModal(dni, prefill = "") {
  scanner.pause();
  openAlert(`<div class="modal-back" data-act="dismiss-alert">
    <div class="modal summary-modal" role="dialog" aria-modal="true" data-act="stay">
      ${sectionHead("Cualquiera", "No está en supervisores. Escriba su nombre completo. Este pedido sale como almuerzo normal.")}
      <p class="extra-note">DNI ${esc(dni)}</p>
      <div class="field" id="fEmergNom">
        <label>Apellidos y nombres</label>
        <input id="emergNombre" autocomplete="off" placeholder="Apellidos y nombres" autocapitalize="characters" value="${esc(prefill)}">
      </div>
      <div class="footer-actions" style="margin-top:8px">
        <button class="btn ghost" data-act="dismiss-alert" type="button">Cancelar</button>
        <button class="btn leaf" data-act="save-emergency-name" data-id="${esc(dni)}" type="button">Entrar</button>
      </div>
    </div>
  </div>`);
  window.setTimeout(() => {
    const el = document.getElementById("emergNombre");
    el?.focus();
    el?.select?.();
  }, 50);
  speak("Escriba su nombre para entrar.", { flush: true });
}

function showDniLoginModal(cualquiera) {
  if (state.loggingIn) return;
  scanner.pause();
  const title = cualquiera ? "DNI de cualquiera" : "DNI de supervisor";
  const sub = cualquiera
    ? "Escriba los 8 dígitos. Si no está en supervisores, pediremos el nombre. Este pedido sale como almuerzo normal."
    : "Escriba los 8 dígitos. Solo entra quien está en la lista de supervisores.";
  openAlert(`<div class="modal-back" data-act="dismiss-alert">
    <div class="modal summary-modal" role="dialog" aria-modal="true" data-act="stay">
      ${sectionHead(title, sub)}
      ${cualquiera ? `<p class="extra-note">Cualquier persona. Tenga cuidado: usted pide la comida.</p>` : ""}
      <div class="field" id="fDniLogin">
        <label>DNI</label>
        <input id="dni-login" inputmode="numeric" autocomplete="off" maxlength="8" placeholder="8 dígitos" enterkeyhint="go">
        <span class="hint" id="dni-login-hint">El DNI tiene 8 números.</span>
      </div>
      <div class="footer-actions" style="margin-top:8px">
        <button class="btn ghost" data-act="dismiss-alert" type="button">Cancelar</button>
        <button class="btn leaf" data-act="submit-dni-login" data-cualquiera="${cualquiera ? "1" : "0"}" type="button">Entrar</button>
      </div>
    </div>
  </div>`);
  window.setTimeout(() => document.getElementById("dni-login")?.focus(), 50);
  speak(cualquiera ? "Escriba el DNI de la persona." : "Escriba su DNI.", { flush: true });
}

function rejectTypedDni(message) {
  const field = document.getElementById("fDniLogin");
  const hint = document.getElementById("dni-login-hint");
  field?.classList.add("bad");
  if (hint) hint.textContent = message;
  speak(message, { flush: true });
  document.getElementById("dni-login")?.focus();
}

function continueTypedEmergency(dni) {
  const go = () => {
    if (state.loggingIn) return;
    const hit = findSupervisor({ dni });
    if (hit) {
      showLoginGate({ ...hit, emergencia: true });
      return;
    }
    enterEmergencySupervisor(findWorkerByDni(dni) || { dni, id: dni });
  };
  dismissAlert();
  if (findWorkerByDni(dni) || state.wrkByDni.size) {
    go();
    return;
  }
  Promise.race([
    ensureWorkers(),
    new Promise((resolve) => window.setTimeout(resolve, 1500)),
  ]).then(go).catch(go);
}

function submitTypedDni(cualquiera) {
  if (state.loggingIn) return;
  const dni = String(document.getElementById("dni-login")?.value || "").replace(/\D/g, "");
  if (!/^\d{8}$/.test(dni)) {
    rejectTypedDni("El DNI tiene 8 números.");
    return;
  }
  if (!cualquiera) {
    const hit = findSupervisor({ dni });
    if (!hit) {
      rejectTypedDni("No autorizado. Ese DNI no está en supervisores.");
      return;
    }
    dismissAlert();
    showLoginGate(hit);
    return;
  }
  state.emergencyPending = true;
  setEmergencyUi(true);
  continueTypedEmergency(dni);
}

function finishEmergencyLogin(dni, nombreCompleto) {
  const parsed = nameParts({ nombreCompleto: String(nombreCompleto || "").replace(/\s+/g, " ").trim() });
  if (!parsed.apellido && !parsed.nombre && !parsed.nombreCompleto) return false;
  state.emergencyPending = false;
  state.extraOn = false;
  state.extraHold = false;
  store.clearTurnoDia();
  store.clearMesa();
  showLoginGate({
    id: dni,
    dni,
    apellido: parsed.apellido,
    nombre: parsed.nombre,
    nombreCompleto: parsed.nombreCompleto || String(nombreCompleto || "").trim(),
    cargo: "Supervisor de emergencia",
    emergencia: true,
  });
  return true;
}

function supervisorView() {
  state.scanMode = "sup";
  const emerg = !!state.emergencyPending;
  render(`<div class="shell">
    ${appBar({ title: "Pedir almuerzo", sub: emerg ? "Rojo · cualquier persona" : "Verde · solo supervisores", back: "back-welcome" })}
    <div class="scan-fit">
      <section class="section-card scan-panel${emerg ? " is-emerg" : ""}">
        <div class="scan-head">
          ${sectionHead("Permiso", "Escanea tu QR o escribe el DNI.")}
          ${dniHeadBtn()}
        </div>
        ${!navigator.onLine ? `<p class="extra-note">Sin señal. Puede escanear y enviar.</p>` : ""}
        <p class="access-tag ${emerg ? "red" : "green"}" id="access-tag">${emerg ? "Cualquier persona" : "Solo supervisores"}</p>
        ${scanBox()}
        <p class="scan-live" id="scan-live">${emerg ? "Escanea tu QR o escribe el DNI. Cualquier persona puede entrar." : "Toca Activar cámara QR o escriba su DNI."}</p>
        ${scanHitBox()}
        ${scanHelp()}
      </section>
    </div>
    <div class="emerg-dock">
      <button class="emerg-fab${emerg ? " on" : ""}" data-act="add-emergency-sup" type="button" aria-label="Entrar como usuario">${userIcon()}<b>Usuario</b></button>
    </div>
  </div>`);
  startCamHere();
}

function mesaFindDigits() {
  return String(state.mesaQuery || "").replace(/\D/g, "").slice(0, 8);
}

function mesaForList(mesa) {
  const q = mesaFindDigits();
  if (!q) return mesa;
  return mesa.filter((p) => String(p.id || "").replace(/\D/g, "").includes(q));
}

function mesaFindBox() {
  const q = mesaFindDigits();
  return `<label class="mesa-find">
    <input id="mesa-q" class="dni-search" type="search" inputmode="numeric" maxlength="8" enterkeyhint="search" autocomplete="off" placeholder="Buscar DNI" value="${esc(q)}" aria-label="Buscar por DNI">
  </label>`;
}

function menuQty(person) {
  return Number(person?.menus) === 2 ? 2 : 1;
}

function mesaMealCount(mesa) {
  return mesa.reduce((sum, person) => sum + menuQty(person), 0);
}

function personLines(person) {
  const ape = String(person?.apellido || "").trim();
  const nom = String(person?.nombre || "").trim();
  if (ape && nom) return { top: ape, bot: nom };
  return { top: displayName(person) || person?.id || "", bot: "" };
}

function menuStepper(person) {
  const qty = menuQty(person);
  return `<div class="menu-box">
    <div class="menu-line">
      <span class="menu-ico" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M4 10.5V19a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8.5M3 11h18M8 11V7.5A2.5 2.5 0 0 1 10.5 5h3A2.5 2.5 0 0 1 16 7.5V11"/></svg></span>
      <span>Menús</span>
      <div class="menu-step">
        <button type="button" data-act="menu-minus" data-id="${esc(person.id)}" aria-label="Un menú" ${qty <= 1 ? "disabled" : ""}>−</button>
        <b>${qty}</b>
        <button type="button" class="plus" data-act="menu-plus" data-id="${esc(person.id)}" aria-label="Dos menús" ${qty >= 2 ? "disabled" : ""}>+</button>
      </div>
    </div>
  </div>`;
}

function mesaRows(mesa) {
  const q = mesaFindDigits();
  const shown = mesaForList(mesa);
  if (!mesa.length) {
    return `<div class="empty-mesa">${forkIcon()}<p>Aún nadie. Escanea al primero.</p></div>`;
  }
  if (!shown.length) {
    return `<div class="empty-mesa"><p>Ningún DNI coincide.</p></div>`;
  }
  const { rows } = pageSlice(shown);
  return rows.map((p) => {
    const st = p.status === "enviado" ? "Listo" : p.status === "pendiente" ? "Guardado" : "En lista";
    const kind = p.status === "enviado" ? "ok" : p.status === "pendiente" ? "wait" : "now";
    const lines = personLines(p);
    return `<div class="person-row">
      <div class="person-top">
        ${avatarHtml(p)}
        <div>
          <b>${esc(lines.top)}</b>
          ${lines.bot ? `<b class="person-name">${esc(lines.bot)}</b>` : ""}
          <div class="meta">DNI ${esc(p.id)}${p.temporal ? " · Temporal" : ""}</div>
        </div>
        <span class="st ${kind}">${st}</span>
        <button class="row-del" data-act="ask-drop-mesa" data-id="${esc(p.id)}" data-name="${esc(displayName(p))}" type="button" aria-label="Quitar ${esc(displayName(p) || p.id)}"><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M6.2 5.1 5.1 6.2 10.9 12l-5.8 5.8 1.1 1.1L12 13.1l5.8 5.8 1.1-1.1L13.1 12l5.8-5.8-1.1-1.1L12 10.9 6.2 5.1z"/></svg></button>
      </div>
      ${menuStepper(p)}
    </div>`;
  }).join("");
}

function mesaCountCopy(n) {
  const meal = currentLote().toLowerCase();
  if (!n) return { note: `Aún nadie para ${meal}`, unit: "personas" };
  return { note: `Van a ${meal}`, unit: n === 1 ? "persona" : "personas" };
}

function mesaCountCard(n) {
  const copy = mesaCountCopy(n);
  return `<section class="section-card count-card">
    ${sectionHead("Personas", copy.note, "mesa-note")}
    <div class="count-live" aria-live="polite">
      <b id="mesa-num">${n}</b>
      <span id="mesa-unit">${esc(copy.unit)}</span>
    </div>
  </section>`;
}

function refreshMesaUi() {
  const mesa = getMesa();
  const slice = pageSlice(mesaForList(mesa));
  const list = document.getElementById("mesa-list");
  const count = document.getElementById("mesa-note");
  const num = document.getElementById("mesa-num");
  const unit = document.getElementById("mesa-unit");
  const pager = document.getElementById("mesa-pager");
  const copy = mesaCountCopy(mesa.length);
  if (list) list.innerHTML = mesaRows(mesa);
  if (count) count.textContent = copy.note;
  if (num) num.textContent = String(mesa.length);
  if (unit) unit.textContent = copy.unit;
  if (pager) pager.innerHTML = pagerHtml(slice.page, slice.pages);
  const send = document.querySelector('.form-actions [data-act="go-summary"], .footer-actions [data-act="go-summary"], .form-actions [data-act="send-lista"], .footer-actions [data-act="send-lista"]');
  if (send) send.disabled = !mesa.length;
  refreshPendPill();
}

function setScanLive(text, ok = true) {
  const el = document.getElementById("scan-live");
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("bad", !ok);
}

function scanHitBox() {
  return `<article class="hit-card" id="scan-hit" hidden></article>`;
}

function abortLogin(title, text) {
  state.loggingIn = false;
  store.clearSesion();
  store.clearTurnoDia();
  dismissAlert();
  speak(title, { flush: true });
  showAlert(title, text);
  if (state.view !== "supervisor") show("supervisor", { replace: true });
  else startCamHere();
}

function localAlreadySent(dni, comida = currentLote()) {
  const sid = normalizeDni(dni);
  const day = todayKey(TZ);
  if (!sid) return false;
  const turno = store.getTurnoDia();
  if (
    turno?.enviado
    && turno.fecha === day
    && (!turno.comida || turno.comida === comida)
    && normalizeDni(turno.dni) === sid
  ) return true;
  const same = (r) => {
    const p = r?.payload || {};
    return r?.type === "lista"
      && !p.extra
      && p.fecha_local === day
      && (!comida || p.comida === comida)
      && normalizeDni(p.supervisor_id) === sid;
  };
  return store.getHistorial().some((r) => r.confirmed !== false && same(r))
    || store.getCola().some(same);
}

function enterSession(person, { enviado = false, fecha, comida } = {}) {
  const dni = normalizeDni(person?.dni || person?.id);
  if (!store.setSesion(person)) {
    abortLogin("No se pudo entrar", "Intente de nuevo el QR.");
    return;
  }
  state.extraOn = false;
  state.extraHold = false;
  state.mesaQuery = "";
  state.mesaPage = 1;
  store.setTurnoDia({
    dni,
    fecha: fecha || todayKey(TZ),
    comida: comida || currentLote(),
    enviado: !!enviado,
  });
  ensureWorkers();
  state.loggingIn = false;
  state.extraOn = false;
  state.extraHold = false;
  state.lastSpeak = "";
  dismissAlert();
  store.clearMesa();
  show("home");
  if (enviado && !person.emergencia) {
    state.extraOn = false;
    state.extraHold = false;
    store.clearMesa();
    speak("Hoy ya envió. Solo extra. La lista empieza vacía.", { flush: true });
    setScanLive("Ya envió. Pulse Extra. La lista inicia vacía.", false);
    return;
  }
  if (person.emergencia) {
    speak("Almuerzo normal. Escanee a cada persona.", { flush: true });
    setScanLive("Almuerzo normal. Acerca el QR.", true);
    return;
  }
  offerSupervisorOwnLunch(person);
}

function showLoginGate(person) {
  const dni = normalizeDni(person?.dni || person?.id);
  if (!isSesionDni(dni)) {
    speak("Código no válido. Solo el DNI.");
    return;
  }
  const ap = twoApellidos(person);
  const speakName = prepareSpeakName(person) || prepareSpeakName(ap);
  state.loggingIn = true;
  state.emergencyPending = false;
  scanner.setBusy(false);
  scanner.pause();
  const askTurno = navigator.onLine && !person.emergencia;
  let turnoResult = null;
  const turnoReady = askTurno
    ? checkTurno({
      supervisorId: dni,
      fecha: todayKey(TZ),
      comida: currentLote(),
      timeoutMs: 4000,
    }).then((r) => {
      turnoResult = r;
      return r;
    }).catch(() => null)
    : Promise.resolve(null);
  const greet = speakName ? `Bienvenido ${speakName}` : "Bienvenido";
  let barDone = false;
  let voiceDone = false;
  let entered = false;
  const tryEnter = () => {
    if (entered || !barDone || !voiceDone) return;
    entered = true;
    finishLogin();
  };
  speak(greet, {
    flush: true,
    onDone: () => {
      voiceDone = true;
      tryEnter();
    },
  });
  const voiceCap = Math.min(14000, Math.max(4800, 700 + greet.length * 180));
  window.setTimeout(() => {
    voiceDone = true;
    tryEnter();
  }, voiceCap);
  openAlert(`<div class="modal-back login-gate" data-act="stay">
    <div class="modal login-load" role="dialog" aria-modal="true" data-act="stay">
      <p class="login-kicker">Q BERRIES</p>
      <h3>Iniciando sesión</h3>
      <p>Bienvenido${speakName ? `, ${esc(speakName)}` : ""}</p>
      <div class="login-bar" aria-hidden="true"><i id="login-bar"></i></div>
      <p class="login-pct" id="login-pct">0%</p>
    </div>
  </div>`);
  const bar = document.getElementById("login-bar");
  const pct = document.getElementById("login-pct");
  const start = performance.now();
  const dur = voiceEnabled() ? Math.min(5600, Math.max(1800, greet.length * 95)) : 650;
  function finishLogin() {
    const r = turnoResult?.ok ? turnoResult : null;
    const enviado = person.emergencia ? false : (r ? !!r.enviado : localAlreadySent(dni));
    enterSession(person, {
      enviado,
      fecha: r?.fecha || todayKey(TZ),
      comida: r?.comida || currentLote(),
    });
    if (!askTurno || r) return;
    turnoReady.then((late) => {
      if (!late?.ok || !late.enviado || person.emergencia) return;
      if (normalizeDni(supervisor()?.dni) !== dni) return;
      store.setTurnoDia({
        dni,
        fecha: late.fecha || todayKey(TZ),
        comida: late.comida || currentLote(),
        enviado: true,
      });
      if (alertIsOpen()) {
        dismissAlert();
        store.clearMesa();
      }
      refreshHomeLock();
    }).catch(() => {});
  };
  const tick = (now) => {
    const t = Math.min(1, (now - start) / dur);
    const p = Math.round(t * 100);
    if (bar) bar.style.width = `${p}%`;
    if (pct) pct.textContent = `${p}%`;
    if (t < 1) {
      requestAnimationFrame(tick);
      return;
    }
    if (bar) bar.style.width = "100%";
    if (pct) pct.textContent = "100%";
    barDone = true;
    tryEnter();
  };
  requestAnimationFrame(tick);
}

function showScanHit({ dni = "—", nombre = "—", cargo = "—", ok = true, note = "", stateLabel = "", sexo = "" }) {
  const host = document.getElementById("scan-hit");
  if (host) {
    host.hidden = false;
    host.className = `hit-card ${ok ? "ok" : "bad"}`;
    const face = avatarHtml({ dni, sexo }, "lg");
    host.innerHTML = `
      <div class="hit-top">
        <span class="hit-label">Identificación</span>
        <span class="hit-state">${esc(stateLabel || (ok ? "Confirmado" : "No autorizado"))}</span>
      </div>
      <div class="hit-person">
        ${face}
        <div>
          <p class="hit-dni">DNI ${esc(dni)}</p>
          <h3 class="hit-name">${esc(nombre || "—")}</h3>
          <p class="hit-cargo">${esc(cargo || "—")}</p>
        </div>
      </div>
      ${note ? `<p class="hit-note">${esc(note)}</p>` : ""}`;
  }
  setScanLive(note || `DNI ${dni}`, ok);
}

function homeView() {
  if (!supervisor()) {
    show("supervisor");
    return;
  }
  state.scanMode = "wrk";
  state.formType = "pedido";
  const s = supervisor();
  const mesa = getMesa();
  const slice = pageSlice(mesaForList(mesa));
  render(`<div class="shell${isSendLocked() ? " is-locked" : ""}">
    ${appBar({ title: "Solicitud de almuerzo", sub: `Turno · ${twoApellidos(s) || "supervisor"}${s?.emergencia ? " · Emergencia" : ""}` })}
    <div class="scroll">
      ${loteCard()}
      <section class="section-card">
        <div class="scan-head">
          ${sectionHead("Escaneo", isSendLocked() ? "Bloqueado. Pulse Extra para olvidados o tardanzas." : (state.extraOn ? "Solo quien falta. Entra como extra." : "Presente el QR de cada persona."))}
          <button class="user-add" data-act="add-temp-person" type="button" aria-label="Agregar persona que no está en la base">${userIcon()}</button>
        </div>
        ${scanBox()}
        <p class="scan-live" id="scan-live">${isSendLocked() ? "Ya envió. Pulse Extra si alguien se olvidó o llegó tarde." : "Listo para el siguiente QR."}</p>
        ${scanHitBox()}
      </section>
      ${mesaCountCard(mesa.length)}
      ${mesaFindBox()}
      <div class="mesa" id="mesa-list">${mesaRows(mesa)}</div>
      <div id="mesa-pager">${pagerHtml(slice.page, slice.pages)}</div>
    </div>
    ${soloFooter("go-summary", "Ver resumen", !mesa.length || isSendLocked())}
    ${fabBlock()}
  </div>`);
  startCamHere();
  ensureWorkers();
}

function scanView() {
  show(state.scanMode === "sup" ? "supervisor" : "home");
}

function registerView(parsed) {
  render(`<div class="shell">
    ${appBar({ title: "Persona nueva", sub: "Ingresa el primer apellido", back: "home", progress: 25 })}
    <div class="scroll">
      ${speakBar()}
      ${blockCard("Datos de la persona", "Complete los campos obligatorios.")}
      <div class="field" id="fId"><label>Código</label><input id="regId" value="${esc(parsed.id || "")}" /><span class="hint">Campo obligatorio</span></div>
      <div class="field" id="fAp"><label>Primer apellido</label><input id="regAp" value="${esc(parsed.apellido || "")}" autocapitalize="characters" /><span class="hint">Campo obligatorio</span></div>
      <div class="field"><label>Nombre</label><input id="regNo" value="${esc(parsed.nombre || "")}" /></div>
      <div class="field"><label>Área</label><input id="regAr" value="${esc(parsed.area || "")}" /></div>
    </div>
    <footer class="footer">
      <button class="btn" data-act="save-reg" type="button">Guardar</button>
      <div style="height:8px"></div>
      <button class="btn ghost" data-act="home" type="button">Cancelar</button>
    </footer>
  </div>`);
}

function orderView() {
  show("home");
}

function summaryView() {
  show("home");
  showSummaryModal();
}

function dayView() {
  show("home");
  showSummaryModal();
}

function listaView() {
  const recs = recordsOfToday(TZ).filter((r) => r.type === "pedido" || r.type === "especial");
  const byW = new Map();
  for (const r of recs) {
    const id = r.payload?.trabajador_id;
    if (!id) continue;
    if (!byW.has(id)) byW.set(id, r);
  }
  const rows = [...byW.values()];
  const list = rows.map((r) => `<div class="list-item">
    <div>
      <b>${esc(r.payload.trabajador_apellido)}</b>
      <div class="meta">DNI ${esc(r.payload.trabajador_id || "")} · ${esc(r.payload.trabajador_nombre || "")}</div>
    </div>
    <span class="chip">OK</span>
  </div>`).join("") || `<p class="sub">Escanea supervisores para armar el resumen.</p>`;
  render(`<div class="shell">
    ${appBar({ title: "Quién pidió", sub: `${rows.length} personas hoy`, back: "home", progress: 70 })}
    <div class="scroll">
      ${list}
    </div>
    <footer class="footer">
      <button class="btn" data-act="send-lista" type="button" ${rows.length ? "" : "disabled"}>Enviar lista</button>
      <div style="height:8px"></div>
      <button class="btn ghost" data-act="home" type="button">Volver</button>
    </footer>
  </div>`);
}

function cierreView() {
  const calc = computeHeadcount(recordsOfToday(TZ));
  render(`<div class="shell">
    ${appBar({ title: "Cierre de cocina", sub: "Resumen del turno", back: "home", progress: 90 })}
    <div class="scroll">
      ${blockCard("Cierre", "Total de supervisores escaneados hoy.", `<div class="count-hero">
          <b>${calc.trabajadores_unicos}</b>
          <span>${calc.trabajadores_unicos === 1 ? "escaneado" : "escaneados"}</span>
        </div>`, "", "block-hero")}
      <div class="stats">
        <div class="stat"><em>Enviados</em><b>${calc.pedidos_enviados}</b></div>
        <div class="stat"><em>Aquí</em><b>${calc.pedidos_pendientes}</b></div>
      </div>
      ${calc.hasData ? "" : `<div class="note">Aún no hay registros.</div>`}
      <div class="field"><label>Comentario de cierre</label><textarea id="cierreCom"></textarea></div>
    </div>
    <footer class="footer">
      <button class="btn leaf" data-act="save-cierre" type="button">Guardar cierre</button>
      <div style="height:8px"></div>
      <button class="btn ghost" data-act="home" type="button">Volver</button>
    </footer>
  </div>`);
}

function syncView() {
  const n = pendingCount();
  render(`<div class="shell">
    ${appBar({ title: n ? "Por enviar" : "Todo enviado", sub: "Sync seguro" })}
    <div class="scroll">
      <p class="hello">${n ? "Por enviar" : "Todo enviado"}</p>
      <p class="sub">${state.online
        ? (n ? "Hay señal. Toca enviar." : "Todo enviado.")
        : "Sin señal. Los pedidos están guardados en este celular."}</p>
      ${speakBar()}
      <div class="stat"><em>Pendientes</em><b>${n}</b></div>
    </div>
    <footer class="footer">
      <button class="btn leaf" data-act="do-sync" type="button" ${n ? "" : "disabled"}>Enviar ahora</button>
      <div style="height:8px"></div>
      <button class="btn ghost" data-act="home" type="button">Volver</button>
    </footer>
  </div>`);
}

function moreView() {
  const prefs = store.getPrefs();
  const admin = state.admin ? `<div class="admin">
      <div class="field"><label>Conexión</label>
        <input id="scriptUrl" value="${esc(store.getScriptUrl())}" placeholder="Pegar enlace" />
      </div>
      <div class="field"><label>Personas del turno</label>
        <input id="headcount" type="number" inputmode="numeric" value="${expectedHeadcount()}" />
      </div>
      <div class="grid-actions">
        <button class="card" data-act="save-settings" type="button"><h3>Guardar conexión</h3><p>Solo para quien arma la app.</p></button>
        <a class="card" href="./setup.html"><h3>Imprimir códigos</h3><p>Credenciales.</p></a>
        <button class="card" data-act="clear-cache" type="button"><h3>Limpiar app</h3><p>No borra pedidos guardados.</p></button>
      </div>
    </div>` : "";
  render(`<div class="shell">
    ${appBar({ title: "Menú", sub: "Ajustes del turno" })}
    <div class="scroll">
      ${speakBar()}
      <div class="grid-actions">
        <button class="card" data-act="toggle-voice" type="button">
          <h3>La app habla: ${prefs.voice === false ? "apagada" : "encendida"}</h3>
          <p>Un toque para prender o apagar.</p>
        </button>
        <button class="card" data-act="ask-logout" type="button">
          <h3>Cerrar turno</h3>
          <p>Se borran los DNI guardados en este celular.</p>
        </button>
      </div>
      ${admin}
    </div>
    <footer class="footer">
      <button class="btn ghost" data-act="home" type="button">Volver</button>
    </footer>
  </div>`);
}

function workerRows(query) {
  const q = (query || "").trim().toUpperCase();
  const rec = store.getRecientes();
  const all = [...rec, ...state.workers].filter((p, i, a) => a.findIndex((x) => x.id === p.id) === i);
  const filtered = q
    ? all.filter((w) => `${w.apellido} ${w.nombre} ${w.nombreCompleto || ""} ${w.dni || w.id}`.toUpperCase().includes(q)).slice(0, 40)
    : rec.slice(0, 20);
  return filtered.map((w) => `<button class="list-item" data-act="pick-w" data-id="${esc(w.id)}" type="button">
    <div><b>${esc(twoApellidos(w))}</b><div class="meta">DNI ${esc(w.dni || w.id)} · ${esc(nameParts(w).nombre || "")}</div></div>
  </button>`).join("") || `<p class="sub">${q ? "Nadie coincide." : "Escanea el DNI o busca el apellido."}</p>`;
}

function supervisorRows(query) {
  const q = (query || "").trim().toUpperCase();
  const all = state.supervisors.filter((s, i, a) => a.findIndex((x) => x.id === s.id) === i);
  const rows = (q ? all.filter((s) => `${s.apellido} ${s.nombre} ${s.id}`.toUpperCase().includes(q)) : all);
  return rows.map((s) => `<button class="list-item" data-act="pick-s" data-id="${esc(s.id)}" type="button">
      <div><b>${esc(s.apellido)}</b><div class="meta">${esc(s.nombre || "")}</div></div>
    </button>`).join("") || `<p class="sub">Nadie coincide.</p>`;
}

function pickSupervisorView() {
  const rows = supervisorRows(state.pickQuery);
  render(`<div class="shell">
    ${appBar({ title: "Supervisor", sub: "Entrar al turno", back: "back-welcome" })}
    <div class="scroll">
      <div class="field"><label>Buscar</label>
        <input id="pickQ" value="${esc(state.pickQuery || "")}" placeholder="Apellido" />
      </div>
      <div id="pickList">${rows}</div>
    </div>
    <footer class="footer">
      <button class="btn ghost" data-act="cancel-scan" type="button">Volver</button>
    </footer>
  </div>`);
}

function pickWorkerView(next) {
  state.pickNext = next;
  render(`<div class="shell">
    ${appBar({ title: "¿Quién es?", sub: "Toca el apellido", back: "home", progress: 40 })}
    <div class="scroll">
      <div class="field"><label>Buscar</label>
        <input id="pickQ" value="${esc(state.pickQuery || "")}" placeholder="Apellido o código" />
      </div>
      <div id="pickList">${workerRows(state.pickQuery)}</div>
    </div>
    ${footer("home", `<button class="btn ghost" data-act="home" type="button">Volver</button><div style="height:8px"></div>`)}
  </div>`);
}

const ROUTES = [
  "welcome", "lock", "supervisor", "home", "register", "order",
  "summary", "dia", "lista", "cierre", "sync", "mas", "pick",
];

function viewFromHash() {
  const name = (location.hash || "").replace(/^#\/?/, "").split(/[/?#]/)[0];
  return ROUTES.includes(name) ? name : "";
}

function guardView(view) {
  if (!isFieldDevice()) return "lock";
  if (view === "lock") return "welcome";
  if (view === "scan" || view === "picksup" || view === "order" || view === "dia") return supervisor() ? "home" : "supervisor";
  if (!supervisor() && view !== "welcome" && view !== "supervisor") return "supervisor";
  return ROUTES.includes(view) ? view : "welcome";
}

function show(view, opts = {}) {
  const safe = guardView(view);
  const hash = `#/${safe}`;
  if (!opts.silent && location.hash !== hash) {
    if (opts.replace || state.view === "boot") history.replaceState({ view: safe }, "", hash);
    else history.pushState({ view: safe }, "", hash);
  }
  state.view = safe;
  if (safe !== "home" && safe !== "supervisor") scanner.stop();
  const map = {
    welcome: welcomeView,
    lock: lockView,
    supervisor: supervisorView,
    home: homeView,
    register: () => registerView(state.pendingParse || {}),
    order: orderView,
    summary: summaryView,
    dia: dayView,
    lista: listaView,
    cierre: cierreView,
    sync: syncView,
    mas: moreView,
    pick: () => pickWorkerView(state.pickNext),
  };
  (map[safe] || welcomeView)();
}

function syncFromUrl() {
  const view = viewFromHash() || "welcome";
  if (view === state.view) return;
  show(view, { silent: true });
}

function persistDraft() {
  grabFields();
  if (state.draft.worker) {
    store.setDraft(`${state.formType}:${state.draft.worker.id}`, state.draft);
  }
}

function grabFields() {
  const c = document.getElementById("comentario");
  const d = document.getElementById("dieta");
  const a = document.getElementById("alergias");
  if (c) state.draft.comentario = c.value;
  if (d) state.draft.tipo_dieta = d.value;
  if (a) state.draft.alergias = a.value;
}

function scanPayload(worker) {
  const s = supervisor();
  const t = nowParts(TZ);
  return {
    fecha_local: t.fecha,
    hora_local: t.hora,
    timezone: TZ,
    supervisor_id: s?.dni || s?.id || "",
    supervisor_apellido: supervisorNombreCompleto(s) || s?.apellido || "",
    supervisor_apellido_nombre: supervisorNombreCompleto(s) || s?.apellido || "",
    trabajador_id: worker.dni || worker.id,
    trabajador_apellido: twoApellidos(worker),
    trabajador_nombre: nameParts(worker).nombre || worker.nombreCompleto || worker.nombre || "",
    area: worker.cargo || worker.area || "",
    tipo_formulario: "pedido",
    hizo_pedido: true,
    fundo: currentFundo(),
    comida: currentLote(),
    comedor: currentComedor(),
    platos_detalle: currentLote(),
  };
}

async function saveScanRecord(worker) {
  const id = worker.dni || worker.id;
  const day = todayKey(TZ);
  const existing = recordsOfToday(TZ).find((r) => (
    r.payload?.trabajador_id === id && r.type !== "cierre" && r.type !== "lista"
  ));
  if (existing) return { status: existing.status || "pendiente", record: existing, already: true };
  const result = await saveAndSync({
    clientId: `scan:${day}:${id}`,
    type: "pedido",
    payload: scanPayload(worker),
    createdAt: Date.now(),
  });
  return { ...result, already: false };
}

function registerPerson(worker, { silent = false } = {}) {
  try {
    const dni = normalizeDni(worker.dni || worker.id);
    const onMesa = getMesa().some((p) => normalizeDni(p.id) === dni);
    upsertMesa({
      id: dni,
      apellido: twoApellidos(worker),
      nombre: nameParts(worker).nombre || worker.nombreCompleto || worker.nombre,
      cargo: worker.cargo || worker.area || "",
      temporal: !!worker.temporal,
      ...(personSexo(worker) ? { sexo: personSexo(worker) } : {}),
      status: "lista",
      plato: "",
    });
    state.mesaPage = 1;
    if (!silent) {
      try { holdNameSpeech(worker); } catch { /* voz no bloquea el escaneo */ }
    }
    queueMicrotask(() => {
      try {
        store.touchReciente({ ...worker, kind: "wrk", id: dni });
        rememberDni(worker);
      } catch { /* local secundario */ }
    });
    return { result: { status: "lista" }, already: onMesa, ok: true };
  } catch {
    return { result: { status: "error" }, already: false, ok: false };
  }
}

function markProcessedQR(key) {
  if (!key) return;
  state.lastProcessedQR = key;
  state.lastProcessedAt = Date.now();
}

function releaseScan(opId) {
  if (opId != null && opId !== state.scanOpId) return;
  state.handlingScan = false;
  state.isProcessing = false;
  scanner.setBusy(false);
}

async function onScan(raw, keyFromScanner) {
  if (state.loggingIn) return;

  const key = keyFromScanner || scanner.emitKey(raw) || "";
  const now = Date.now();

  if (state.isProcessing || state.handlingScan) {
    const dniBusy = normalizeDni(key);
    if (state.scanMode === "wrk" && dniBusy && personOnMesa(dniBusy)) {
      warnRepeatedPerson(dniBusy);
      return;
    }
    if (key && key !== state.lastDetectedQR) notifyScanWait();
    return;
  }

  if (state.scanMode === "wrk" && key) {
    const dniKey = normalizeDni(key);
    const already = dniKey ? personOnMesa(dniKey) : null;
    if (already) {
      warnRepeatedPerson(dniKey, already);
      scanner.forget(dniKey);
      return;
    }
  }

  if (key && key === state.lastProcessedQR && now - state.lastProcessedAt < 900) {
    return;
  }

  const opId = ++state.scanOpId;
  state.isProcessing = true;
  state.handlingScan = true;
  state.lastDetectedQR = key || String(raw || "").trim();
  state.scanTimestamp = now;
  scanner.setBusy(true);
  const watchdog = window.setTimeout(() => {
    releaseScan(opId);
  }, 2500);

  let processedOk = false;
  try {
    const result = handleOneScan(raw, opId);
    processedOk = result && typeof result.then === "function" ? await result : !!result;
  } catch {
    processedOk = false;
  } finally {
    window.clearTimeout(watchdog);
    releaseScan(opId);
    if (opId === state.scanOpId) {
      if (processedOk && state.lastDetectedQR) {
        markProcessedQR(state.lastDetectedQR);
        scanner.forget(state.lastDetectedQR);
      }
      const keepRepeat = Date.now() - (state.lastRepeatAt || 0) < 800;
      if (!keepRepeat) {
        hideScanToast();
        if (state.view === "home" || state.view === "supervisor") {
          if (!(state.scanMode === "wrk" && isSendLocked())) {
            setScanLive("Listo. Siguiente.");
          }
        }
      }
      if (state.view === "home" && processedOk && state.scanMode === "wrk") {
        window.requestAnimationFrame(() => {
          if (state.view === "home") refreshMesaUi();
        });
      } else {
        refreshPendPill();
      }
    }
  }
}

function completeWorkerScan(worker, dni, opId) {
  if (opId !== state.scanOpId) return false;
  if (!worker) {
    try {
      showScanHit({
        dni,
        nombre: "No está en la lista",
        cargo: "No figura en trabajadores",
        ok: false,
        note: "Ese DNI no está en trabajadores. Use el ícono si es temporal.",
      });
      speak("No está en la lista.", { flush: true });
    } catch { /* UI/voz no tumba el escáner */ }
    return true;
  }

  if (personOnMesa(worker.dni)) {
    warnRepeatedPerson(worker.dni, worker);
    return true;
  }

  const saved = registerPerson(worker);
  if (opId !== state.scanOpId) return false;
  if (!saved?.ok) return false;
  try {
    showScanHit({
      dni: worker.dni,
      sexo: personSexo(worker),
      nombre: prepareSpeakName(worker) || twoApellidos(worker),
      cargo: [nameParts(worker).nombre, worker.cargo].filter(Boolean).join(" · "),
      ok: true,
      note: "Registrado. Siguiente.",
    });
  } catch { /* tarjeta de UI opcional */ }
  return true;
}

function handleOneScan(raw, opId) {
  try {
  if (state.loggingIn) return false;
  if (opId !== state.scanOpId) return false;
  if (alertIsOpen()) return false;

  const parsed = parseQr(raw);
  const dni = parsed?.dni || parsed?.id || "";
  if (!parsed || !dni) {
    try {
      speak("Código no válido. Solo el DNI.", { flush: true });
      showScanHit({ dni: "—", nombre: "No se leyó un DNI", cargo: "—", ok: false, note: "Acerca el código de nuevo." });
    } catch { /* */ }
    return false;
  }
  if (opId !== state.scanOpId) return false;

  if (state.scanMode === "sup") {
    const hit = findSupervisor(parsed);
    if (hit) {
      if (state.emergencyPending) {
        showLoginGate({ ...hit, emergencia: true });
        return true;
      }
      showLoginGate(hit);
      return true;
    }
    if (state.emergencyPending) {
      const known = findWorkerByDni(dni);
      if (known || state.wrkByDni.size) {
        enterEmergencySupervisor(known || { dni, id: dni });
        return true;
      }
      return Promise.race([
        ensureWorkers(),
        new Promise((resolve) => window.setTimeout(resolve, 1500)),
      ]).then(() => {
        if (opId !== state.scanOpId) return false;
        enterEmergencySupervisor(findWorkerByDni(dni) || { dni, id: dni });
        return true;
      }).catch(() => {
        if (opId !== state.scanOpId) return false;
        enterEmergencySupervisor({ dni, id: dni });
        return true;
      });
    }
    try {
      speak("No autorizado.", { flush: true });
      showScanHit({
        dni,
        nombre: "No autorizado",
        cargo: "No está en supervisores de cosecha",
        ok: false,
        note: "Ese DNI no está en la lista autorizada. Si es emergencia, use el botón rojo.",
      });
    } catch { /* */ }
    return true;
  }

  if (isSendLocked()) {
    warnLocked();
    return true;
  }

  const worker = findWorkerByDni(dni) || personFromSaved(dni);
  if (!worker && !state.wrkByDni.size) {
    return Promise.race([
      ensureWorkers(),
      new Promise((resolve) => window.setTimeout(resolve, 1500)),
    ]).then(() => {
      if (opId !== state.scanOpId) return false;
      return completeWorkerScan(findWorkerByDni(dni) || personFromSaved(dni), dni, opId);
    }).catch(() => {
      if (opId !== state.scanOpId) return false;
      return completeWorkerScan(findWorkerByDni(dni) || personFromSaved(dni), dni, opId);
    });
  }

  return completeWorkerScan(worker, dni, opId);
  } catch {
    return false;
  }
}

function askUploadPermission() {
  try {
    if (typeof Notification === "undefined" || Notification.permission !== "default") return;
    Notification.requestPermission().catch(() => {});
  } catch { /* el celular puede negar el aviso */ }
}

function notifyUploaded(count) {
  const n = Number(count) || 0;
  if (n < 1 || typeof Notification === "undefined" || Notification.permission !== "granted") return;
  const body = n === 1
    ? "Tu pendiente se subió correctamente."
    : "Tus pendientes se subieron correctamente.";
  const opts = {
    body,
    icon: "./icons/icon-192.png",
    badge: "./icons/icon-192.png",
    tag: "cocina-subido",
    renotify: true,
    lang: "es",
  };
  const fallback = () => {
    try { new Notification("Solicitud de almuerzo", opts); } catch { /* sin permiso */ }
  };
  const ready = navigator.serviceWorker?.ready;
  if (!ready) { fallback(); return; }
  ready.then((reg) => {
    if (reg?.showNotification) reg.showNotification("Solicitud de almuerzo", opts).catch(fallback);
    else fallback();
  }).catch(fallback);
}

function uniqueMesaPeople(list) {
  const map = new Map();
  for (const person of list || []) {
    const id = normalizeDni(person?.id || person?.dni);
    if (!id) continue;
    const prev = map.get(id);
    map.set(id, { ...(prev || {}), ...person, id, dni: id, menus: Math.max(menuQty(prev), menuQty(person)) });
  }
  return [...map.values()];
}

function sentExtraDnis() {
  const day = todayKey(TZ);
  const sid = normalizeDni(supervisor()?.dni || supervisor()?.id || "");
  const out = new Set();
  for (const row of store.getCola().concat(store.getHistorial())) {
    const payload = row?.payload || {};
    const isExtra = row?.type === "extra" || payload.extra === true;
    if (!isExtra || row?.confirmed === false) continue;
    if (payload.fecha_local !== day) continue;
    const rowSid = normalizeDni(payload.supervisor_id || "");
    if (sid && rowSid && rowSid !== sid) continue;
    for (const person of payload.personas || []) {
      const dni = normalizeDni(person?.dni || person?.id);
      if (dni) out.add(dni);
    }
  }
  return out;
}

function sendLista() {
  askUploadPermission();
  if (state.busy) return;
  state.busy = true;
  try {
  const s = supervisor();
  if (!s) {
    speak("Vuelve a escanear tu DNI");
    show("supervisor");
    return;
  }
  if (isSendLocked()) {
    warnLocked();
    return;
  }
  let extra = !!state.extraOn && hasSavedSend();
  if (state.extraOn && !extra) {
    state.extraOn = false;
    showAlert("Todavía no", "Primero envíe el almuerzo normal. Extra solo después de ese envío.");
    return;
  }
  const mesa = getMesa();
  if (!mesa.length) {
    speak("Nadie en el resumen");
    return;
  }
  let people = uniqueMesaPeople(mesa);
  if (extra) {
    const sent = sentExtraDnis();
    people = people.filter((person) => !sent.has(normalizeDni(person.id)));
    if (!people.length) {
      speak("Esas personas ya se enviaron.");
      showAlert("Ya enviado", "Esas personas ya salieron en un extra. No se vuelven a mandar.");
      return;
    }
  }
  const t = nowParts(TZ);
  const comida = currentLote();
  const existing = extra ? null : store.getCola().find((r) => r.type === "lista" && !r.payload?.extra && r.payload?.comida === comida);
  const sendId = extra ? uuid() : (existing?.payload?.send_id || existing?.payload?.lote_lista_id || uuid());
  const n = mesaMealCount(people);
  const record = {
    clientId: extra ? `extra:${t.fecha}:${sendId}` : (existing?.clientId || `lista:${t.fecha}:${sendId}`),
    type: extra ? "extra" : "lista",
    payload: {
      fecha_local: t.fecha,
      hora_local: t.hora,
      timezone: TZ,
      supervisor_id: s.dni || s.id,
      supervisor_apellido: supervisorNombreCompleto(s),
      supervisor_apellido_nombre: supervisorNombreCompleto(s),
      hizo_pedido: true,
      extra: extra === true,
      tipo: extra ? "extra" : "normal",
      trabajadores_unicos: n,
      fundo: currentFundo(),
      comida,
      comedor: currentComedor(),
      send_id: sendId,
      personas: people.map((p) => ({
        id: p.id,
        dni: p.id,
        apellido: p.apellido || "",
        nombre: p.nombre || "",
        area: p.cargo || p.area || "",
        menus: menuQty(p),
      })),
    },
    createdAt: extra ? Date.now() : (existing?.createdAt || Date.now()),
  };
  store.upsertCola(record);
  setMesa(mesa.map((p) => ({ ...p, status: "lista" })));
  for (const p of mesa) rememberDni(p);
  if (extra) {
    state.extraOn = false;
    state.extraHold = true;
  }
  dismissAlert();
  refreshPendPill();
  if (state.view === "home") refreshHomeLock();
  else show("home");
  const online = navigator.onLine;
  const lugar = [currentComedor(), currentFundo()].filter(Boolean).join(", ");
  speak(extra
    ? (online ? `Extra. ${n} ${mealWord(comida, n)} para ${lugar}.` : `Sin señal. Extra guardado para ${lugar}.`)
    : (online ? `Se envió ${n} ${mealWord(comida, n)} a ${lugar}.` : `Sin señal. Almuerzo guardado para ${lugar}.`), { flush: true });
  saveAndSync(record).then(async (result) => {
    if (result.status === "enviado") {
      setMesa(getMesa().map((p) => ({ ...p, status: "enviado" })));
    }
    refreshPendPill();
    if (state.view === "home") refreshHomeLock();
    if (!extra && result.duplicate) {
      const raw = result.raw || {};
      const savedNone = Number(raw.trabajadores || 0) === 0 && (raw.already || raw.error === "ya_enviado");
      if (savedNone) {
        let reallySent = false;
        try {
          const t = await checkTurno({
            supervisorId: s.dni || s.id,
            fecha: todayKey(TZ),
            comida: currentLote(),
            timeoutMs: 4000,
          });
          reallySent = !!(t?.ok && t.enviado);
        } catch { /* ignore */ }
        if (reallySent) {
          store.setTurnoDia({
            dni: normalizeDni(s.dni || s.id),
            fecha: todayKey(TZ),
            comida: currentLote(),
            enviado: true,
          });
          if (state.view === "home") refreshHomeLock();
          speak("Ya se envió desde otro celular");
          showAlert(
            "Ya envió",
            "Este supervisor ya mandó el almuerzo de hoy desde otro celular. Si falta alguien, pulse Extra."
          );
          return;
        }
        store.clearTurnoDia();
        state.extraOn = false;
        if (state.view === "home") refreshHomeLock();
        speak("No se guardó. Intente Enviar de nuevo como almuerzo.");
        showAlert(
          "Reintente el almuerzo",
          "El servidor no guardó esta lista. Pulse Enviar otra vez (Almuerzo normal). No use Extra todavía."
        );
        return;
      }
      speak("Ya se envió desde otro celular");
      showAlert(
        "Ya envió",
        "Este supervisor ya mandó el almuerzo de hoy desde otro celular. Si falta alguien, pulse Extra."
      );
    }
  }).catch(() => {
    refreshPendPill();
  });
  } finally {
    state.busy = false;
  }
}

async function saveCierre() {
  const s = supervisor();
  if (!s) {
    speak("Vuelve a escanear tu DNI");
    show("supervisor");
    return;
  }
  const calc = computeHeadcount(recordsOfToday(TZ));
  const t = nowParts(TZ);
  const comentario = document.getElementById("cierreCom")?.value || "";
  const sid = normalizeDni(s.dni || s.id);
  const pendingCierre = store.getCola().find((r) => (
    r.type === "cierre"
    && r.payload?.fecha_local === t.fecha
    && normalizeDni(r.payload?.supervisor_id) === sid
  ));
  const job = saveAndSync({
    clientId: pendingCierre?.clientId || uuid(),
    type: "cierre",
    payload: {
      fecha_local: t.fecha,
      hora_local: t.hora,
      timezone: TZ,
      supervisor_id: s.dni || s.id,
      supervisor_apellido: supervisorNombreCompleto(s),
      supervisor_apellido_nombre: supervisorNombreCompleto(s),
      trabajadores_unicos: calc.trabajadores_unicos,
      pedidos_enviados: calc.pedidos_enviados,
      pedidos_pendientes: calc.pedidos_pendientes,
      comentario,
    },
    createdAt: Date.now(),
  });
  const quick = await Promise.race([
    job,
    new Promise((resolve) => setTimeout(() => resolve(null), 1600)),
  ]);
  speak(quick?.status === "enviado" ? "Cierre listo" : "Cierre guardado");
  show("summary");
  if (!quick) {
    job.then((done) => {
      if (done?.status === "enviado") speak("Cierre listo");
      refreshPendPill();
    }).catch(() => {});
  }
}

async function doSync() {
  if (!store.getScriptUrl()) {
    speak("Aún no se puede enviar. Pide ayuda a oficina.");
    if (state.view === "sync") show("sync");
    return;
  }
  const sum = await flushQueue();
  refreshPendPill();
  if (state.view !== "sync") return;
  if (sum.sent && !sum.pending) speak("Todo enviado");
  else if (sum.pending) speak("Quedó guardado. Se envía al tener señal.");
  else speak("Nada por enviar");
  show("sync");
}

async function clearAppCache() {
  store.clearDraftsOnly();
  await runAppUpdate("Borrando caché");
}

let tapLock = false;

async function onClick(e) {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  if (btn.disabled || btn.getAttribute("disabled") !== null) return;
  unlockVoice();
  const act = btn.dataset.act;
  if (act === "stay") {
    if (!e.target.closest(".pick")) closePicks();
    e.stopPropagation();
    return;
  }
  const once = ["send-lista", "reload-app", "clear-cache", "logout", "drop-mesa", "save-temp-person", "save-emergency-name", "keep-sup-lunch", "drop-sup-lunch", "add-emergency-sup", "confirm-emergency", "enter", "open-dni-login", "submit-dni-login"];
  if (once.includes(act)) {
    if (tapLock) return;
    tapLock = true;
    window.setTimeout(() => { tapLock = false; }, 700);
  }
  if (act === "tab") {
    state.tab = btn.dataset.id;
    if (btn.dataset.id === "home") {
      if (!supervisor()) show("supervisor");
      else show("home");
      return;
    }
    if (btn.dataset.id === "sync") {
      show("sync");
      doSync();
      return;
    }
    show(btn.dataset.id);
    return;
  }
  if (act === "dismiss-alert") {
    dismissAlert();
    if (state.view === "supervisor" || state.view === "home") resumeCam();
    return;
  }
  if (act === "flush-pend") {
    askUploadPermission();
    const n = pendingCount();
    flushNow().then((s) => {
      refreshPendPill();
      if (s?.sent) return;
      if (!n) return;
      if (!navigator.onLine) speak("Se envía cuando vuelva la señal.", { flush: true });
    }).catch(() => refreshPendPill());
    return;
  }
  if (act === "menu-plus" || act === "menu-minus") {
    if (isSendLocked() && !state.extraOn) return;
    const id = normalizeDni(btn.dataset.id);
    if (!id) return;
    setMesa(getMesa().map((p) => {
      if (normalizeDni(p.id) !== id) return p;
      const qty = menuQty(p);
      const next = act === "menu-plus" ? Math.min(2, qty + 1) : Math.max(1, qty - 1);
      return { ...p, menus: next };
    }));
    refreshMesaUi();
    return;
  }
  if (act === "start-cam") { unlockVoice(); startCamHere(true); return; }
  if (act === "stop-cam") {
    state.camOff = true;
    scanner.stop();
    setScanLive("Cámara apagada.", false);
    return;
  }
  if (act === "enter") { enterApp(); return; }
  if (act === "install-app") { installApp(); return; }
  if (act === "scan-sup") { goScan("sup"); return; }
  if (act === "scan-wrk") { goScan("wrk"); return; }
  if (act === "back-welcome") {
    state.entered = false;
    state.emergencyPending = false;
    show("welcome");
    return;
  }
  if (act === "cancel-scan") {
    if (state.scanMode === "sup") {
      state.entered = false;
      state.emergencyPending = false;
      show("welcome");
    } else show("home");
    return;
  }
  if (act === "home") {
    if (!supervisor()) show("supervisor");
    else show("home");
    return;
  }
  if (act === "toggle-fab") {
    const menu = document.getElementById("fab-menu");
    const btn = document.getElementById("fab-options-btn");
    if (!menu) return;
    menu.hidden = !menu.hidden;
    btn?.setAttribute("aria-expanded", menu.hidden ? "false" : "true");
    return;
  }
  if (act === "go-historial") {
    state.histPage = 1;
    state.histOpen = "";
    state.histPeoplePage = 1;
    state.histPeopleQuery = "";
    showHistorialModal();
    return;
  }
  if (act === "toggle-hist") {
    const id = btn.dataset.id || "";
    if (state.histOpen === id) {
      state.histOpen = "";
      state.histPeopleQuery = "";
    } else {
      state.histOpen = id;
      state.histPeoplePage = 1;
      state.histPeopleQuery = "";
    }
    showHistorialModal();
    return;
  }
  if (act === "hist-page-prev") {
    state.histPage = Math.max(1, (state.histPage || 1) - 1);
    state.histOpen = "";
    showHistorialModal();
    return;
  }
  if (act === "hist-page-next") {
    state.histPage = (state.histPage || 1) + 1;
    state.histOpen = "";
    showHistorialModal();
    return;
  }
  if (act === "hist-people-prev") {
    state.histPeoplePage = Math.max(1, (state.histPeoplePage || 1) - 1);
    showHistorialModal();
    return;
  }
  if (act === "hist-people-next") {
    state.histPeoplePage = (state.histPeoplePage || 1) + 1;
    showHistorialModal();
    return;
  }
  if (act === "go-dni") {
    if (isSendLocked()) { warnLocked(); return; }
    state.dniPage = 1;
    state.dniQuery = "";
    state.dniSelected = {};
    showDniModal();
    return;
  }
  if (act === "dni-page-prev") {
    state.dniPage = Math.max(1, (state.dniPage || 1) - 1);
    showDniModal();
    return;
  }
  if (act === "dni-page-next") {
    state.dniPage = (state.dniPage || 1) + 1;
    showDniModal();
    return;
  }
  if (act === "toggle-dni") {
    const id = btn.dataset.id;
    if (!id) return;
    state.dniSelected = state.dniSelected || {};
    if (state.dniSelected[id]) delete state.dniSelected[id];
    else state.dniSelected[id] = true;
    showDniModal();
    focusDniSearch();
    return;
  }
  if (act === "toggle-dni-all") {
    const ids = filteredDniGuardados().map((p) => p.id).filter(Boolean);
    const every = ids.length > 0 && ids.every((id) => state.dniSelected[id]);
    state.dniSelected = state.dniSelected || {};
    if (every) {
      for (const id of ids) delete state.dniSelected[id];
    } else {
      for (const id of ids) state.dniSelected[id] = true;
    }
    showDniModal();
    focusDniSearch();
    return;
  }
  if (act === "use-saved-dnis") {
    if (isSendLocked()) { warnLocked(); return; }
    const ids = dniSelectedIds();
    if (!ids.length) return;
    let added = 0;
    for (const id of ids) {
      const worker = personFromSaved(id);
      if (!worker) continue;
      const { already } = registerPerson(worker);
      if (!already) added += 1;
    }
    refreshMesaUi();
    dismissAlert();
    const n = added || ids.length;
    if (!added) speak("Ya estaban en la lista", { flush: true });
    return;
  }
  if (act === "use-saved-dni") {
    const worker = personFromSaved(btn.dataset.id);
    if (!worker) {
      showAlert("No encontrado", "Ese DNI no está guardado.");
      return;
    }
    const { already } = registerPerson(worker);
    refreshMesaUi();
    showDniModal();
    if (already) setScanLive("Ya está en el resumen.", true);
    else setScanLive(`${twoApellidos(worker)} · en lista`, true);
    return;
  }
  if (act === "go-perfil") { showPerfilModal(); return; }
  if (act === "go-ajustes") { showAjustesModal(); return; }
  if (act === "run-transfer") { runTransferMode(); return; }
  if (act === "do-update") { showUpdateModal(); return; }
  if (act === "reload-app") {
    runAppUpdate();
    return;
  }
  if (act === "add-emergency-sup") {
    toggleEmergencySup();
    return;
  }
  if (act === "open-dni-login") {
    if (state.view !== "supervisor" || state.loggingIn) return;
    showDniLoginModal(!!state.emergencyPending);
    return;
  }
  if (act === "submit-dni-login") {
    submitTypedDni(btn.dataset.cualquiera === "1");
    return;
  }
  if (act === "confirm-emergency") {
    dismissAlert();
    resumeCam();
    speak("Ten cuidado, por favor. Escanea tu QR.", { flush: true });
    return;
  }
  if (act === "save-emergency-name") {
    const dni = normalizeDni(btn.dataset.id || document.getElementById("emergNombre")?.dataset?.dni || "");
    const nombre = String(document.getElementById("emergNombre")?.value || "").replace(/\s+/g, " ").trim();
    document.getElementById("fEmergNom")?.classList.toggle("bad", !nombre);
    if (!isSesionDni(dni) || !nombre) {
      speak("Escriba su nombre completo.");
      return;
    }
    dismissAlert();
    if (!finishEmergencyLogin(dni, nombre)) {
      speak("Escriba su nombre completo.");
      showEmergencyNameModal(dni, nombre);
    }
    return;
  }
  if (act === "keep-sup-lunch") {
    dismissAlert();
    refreshMesaUi();
    setScanLive("Supervisor en lista. Escanee al siguiente.", true);
    window.setTimeout(() => {
      speak("Almuerzo del supervisor listo.", { flush: true });
      resumeCam();
      refreshHomeLock();
    }, 40);
    return;
  }
  if (act === "drop-sup-lunch") {
    const id = normalizeDni(btn.dataset.id || "");
    const who = getMesa().find((p) => normalizeDni(p.id) === id);
    const nombre = prepareSpeakName(who) || displayName(who) || "el supervisor";
    if (id) removeMesaPerson(id);
    dismissAlert();
    if (id) {
      scanner.forget(id);
      markProcessedQR(id);
    }
    refreshMesaUi();
    setScanLive(`${nombre}. Quitado. Acerca el siguiente QR.`, true);
    window.setTimeout(() => {
      speak(nombre ? `${nombre}, quitado.` : "Quitado de la lista.", { flush: true });
      resumeCam();
      refreshHomeLock();
    }, 80);
    return;
  }
  if (act === "add-temp-person") {
    if (isSendLocked()) { warnLocked(); return; }
    showTempPersonModal();
    return;
  }
  if (act === "pick-sexo") {
    const box = btn.closest(".sexo-pick");
    box?.querySelectorAll(".sexo-opt").forEach((el) => {
      const on = el === btn;
      el.classList.toggle("on", on);
      el.setAttribute("aria-pressed", on ? "true" : "false");
    });
    document.getElementById("fTempSexo")?.classList.remove("bad");
    return;
  }
  if (act === "save-temp-person") {
    const dni = normalizeDni(document.getElementById("tempDni")?.value || "");
    const typed = String(document.getElementById("tempNombre")?.value || "").replace(/\s+/g, " ").trim();
    const picked = document.querySelector(".sexo-opt.on")?.dataset.sexo || "";
    const official = /^\d{8}$/.test(dni) ? findOfficial(dni) : null;
    const nombre = official ? (displayName(official) || typed) : typed;
    const sexo = personSexo(official) || (picked === "M" || picked === "F" ? picked : "");
    const dniOk = /^\d{8}$/.test(dni);
    document.getElementById("fTempDni")?.classList.toggle("bad", !dniOk);
    document.getElementById("fTempNom")?.classList.toggle("bad", dniOk && !official && !typed);
    document.getElementById("fTempSexo")?.classList.toggle("bad", dniOk && !sexo);
    if (!dniOk || !nombre || !sexo) {
      speak(!dniOk ? "Falta el DNI." : (!nombre ? "Falta el nombre." : "Elija hombre o mujer."));
      return;
    }
    const parsed = nameParts({ nombreCompleto: nombre });
    const worker = official
      ? { ...official, sexo: personSexo(official) || sexo }
      : {
        dni,
        id: dni,
        apellido: parsed.apellido,
        nombre: parsed.nombre,
        nombreCompleto: parsed.nombreCompleto,
        cargo: "Temporal",
        temporal: true,
        sexo,
      };
    const { already } = registerPerson(worker);
    dismissAlert();
    refreshMesaUi();
    setScanLive(already ? "Ya está en el resumen." : "Temporal. Guardado en este celular.", true);
    return;
  }
  if (act === "ask-drop-mesa") {
    askDropMesa(btn.dataset.id, btn.dataset.name);
    return;
  }
  if (act === "drop-mesa") {
    const id = normalizeDni(btn.dataset.id || "");
    if (!id) return;
    const who = getMesa().find((p) => normalizeDni(p.id) === id);
    const nombre = prepareSpeakName(who) || displayName(who);
    removeMesaPerson(id);
    dismissAlert();
    refreshMesaUi();
    unlockWorkerScan(id);
    speak(nombre ? `${nombre}, quitado.` : "Quitado de la lista.", { flush: true });
    setScanLive("Listo. Acerca el QR.", true);
    return;
  }
  if (act === "go-summary") {
    if (isSendLocked()) { warnLocked(); return; }
    showSummaryModal();
    return;
  }
  if (act === "toggle-extra" || act === "ask-extra" || act === "confirm-extra") {
    toggleExtra();
    return;
  }
  if (act === "pick-open") {
    e.stopPropagation();
    const wrap = btn.closest(".pick");
    if (!wrap) return;
    const wasOpen = wrap.classList.contains("open");
    closePicks();
    if (wasOpen) return;
    wrap.classList.add("open");
    const panel = wrap.querySelector(".pick-panel");
    if (panel) panel.hidden = false;
    wrap.querySelector(".pick-search")?.focus();
    return;
  }
  if (act === "pick-opt") {
    e.stopPropagation();
    const pick = btn.dataset.pick;
    const id = btn.dataset.id;
    const lab = btn.dataset.label || btn.textContent.trim();
    if (pick === "sel-fundo" || pick === "sel-etapa") {
      const halls = comedores(id);
      const comedor = halls.includes(store.getPrefs().comedor) ? store.getPrefs().comedor : halls[0];
      store.setPrefs({ fundo: id, etapa: id, comedor });
      closePicks();
      if (document.querySelector(".summary-modal")) showSummaryModal();
      return;
    }
    if (pick === "sel-comedor") store.setPrefs({ comedor: id });
    const wrap = btn.closest(".pick");
    if (wrap) {
      wrap.dataset.value = id;
      const valueEl = wrap.querySelector(".pick-value");
      if (valueEl) valueEl.textContent = lab;
      wrap.querySelectorAll(".pick-opt").forEach((opt) => {
        opt.classList.toggle("on", opt.dataset.id === id);
      });
    }
    closePicks();
    return;
  }
  if (act === "set-lote") {
    store.setPrefs({ lote: "Almuerzo" });
    if (state.extraOn) {
      toggleExtra();
      return;
    }
    if (state.extraHold) {
      state.extraHold = false;
      if (state.view === "home") refreshHomeLock();
      return;
    }
    if (document.querySelector(".summary-modal")) {
      showSummaryModal();
      return;
    }
    return;
  }
  if (act === "set-comedor") {
    const name = btn.dataset.id;
    if (!comedores().includes(name)) return;
    store.setPrefs({ comedor: name });
    if (document.querySelector(".summary-modal")) showSummaryModal();
    return;
  }
  if (act === "page-prev") {
    state.mesaPage = Math.max(1, (state.mesaPage || 1) - 1);
    refreshMesaUi();
    return;
  }
  if (act === "page-next") {
    state.mesaPage = (state.mesaPage || 1) + 1;
    refreshMesaUi();
    return;
  }
  if (act === "go-lista") { show("lista"); return; }
  if (act === "go-cierre") { show("cierre"); return; }
  if (act === "logo-tap") {
    state.logoTaps = (state.logoTaps || 0) + 1;
    clearTimeout(state.logoTimer);
    state.logoTimer = setTimeout(() => { state.logoTaps = 0; }, 2200);
    if (state.logoTaps >= 7) {
      state.logoTaps = 0;
      state.admin = !state.admin;
      speak(state.admin ? "Ajustes" : "Listo");
      show("mas");
    }
    return;
  }
  if (act === "go-pick") {
    if (state.scanMode === "sup" || !supervisor()) return;
    state.formType = "pedido";
    show("pick");
    return;
  }
  if (act === "go-especial-pick") { show("pick"); return; }
  if (act === "manual-sup" || act === "manual-code") {
    const raw = prompt("Código o QR en texto");
    if (raw) onScan(raw);
    return;
  }
  if (act === "send-lista") { sendLista(); return; }
  if (act === "save-cierre") { saveCierre(); return; }
  if (act === "do-sync") { doSync(); return; }
  if (act === "ping") {
    pingServer().then((r) => speak(r.ok ? `Servidor en ${r.version || "línea"}` : "Sin servidor"));
    return;
  }
  if (act === "toggle-voice") {
    setVoiceEnabled(!voiceEnabled());
    speak(voiceEnabled() ? "La app habla" : "Voz apagada");
    show("mas");
    return;
  }
  if (act === "save-settings") {
    const url = document.getElementById("scriptUrl")?.value || "";
    const hc = document.getElementById("headcount")?.value || "";
    store.setScriptUrl(url);
    store.setPrefs({ headcount: Number(hc) || expectedHeadcount() });
    speak("Ajustes guardados");
    show("mas");
    return;
  }
  if (act === "clear-cache") { clearAppCache(); return; }
  if (act === "ask-logout") { showLogoutWarn(); return; }
  if (act === "logout") {
    dismissAlert();
    closeFab();
    store.clearDniGuardados();
    store.clearRecientes();
    store.clearMesa();
    store.clearSesion();
    store.clearTurnoDia();
    state.emergencyPending = false;
    state.extraOn = false;
    state.extraHold = false;
    speak("Turno cerrado. Se borraron los DNI guardados.");
    show("supervisor");
    return;
  }
  if (act === "save-reg") {
    const person = {
      id: document.getElementById("regId").value.trim(),
      apellido: document.getElementById("regAp").value.trim().toUpperCase(),
      nombre: document.getElementById("regNo").value.trim(),
      area: document.getElementById("regAr").value.trim(),
    };
    const oficial = findOfficial(person.id);
    if (!oficial) {
      document.getElementById("fId")?.classList.add("bad");
      showAlert("No está en la lista", "Ese DNI no está en trabajadores.");
      return;
    }
    registerPerson(oficial);
    show("home");
    return;
  }
  if (act === "pick-w") {
    const w = findOfficial(btn.dataset.id);
    if (!w) {
      showAlert("No está en la lista", "Solo supervisores de cosecha pueden pedir almuerzo.");
      return;
    }
    registerPerson(w);
    show("home");
  }
}

async function boot() {
  stripUpdateQuery();
  state.swGuardUntil = Date.now() + 12000;
  bindInstallPrompt();
  bindAppHeight();
  bindFieldLock((ok) => {
    if (!ok) {
      if (state.view !== "lock") show("lock", { replace: true });
      return;
    }
    if (state.view === "lock") {
      show(supervisor() ? "home" : "welcome", { replace: true });
    }
  });
  onVoiceState((on, phrase) => {
    state.lastSpeak = on ? phrase : "";
    const el = document.getElementById("speakbar");
    if (!el) return;
    el.classList.toggle("on", on);
    const span = el.querySelector("span");
    if (span) span.textContent = phrase || "";
  });
  document.getElementById("app").addEventListener("click", (e) => {
    onClick(e).catch(() => {
      state.handlingScan = false;
      state.isProcessing = false;
      scanner.setBusy(false);
    });
  });
  document.getElementById("app").addEventListener("input", (e) => {
    if (e.target.id === "pickQ") {
      state.pickQuery = e.target.value;
      const list = document.getElementById("pickList");
      if (!list) return;
      list.innerHTML = state.view === "picksup" ? supervisorRows(state.pickQuery) : workerRows(state.pickQuery);
    }
    if (e.target.id === "mesa-q") {
      const clean = String(e.target.value || "").replace(/\D/g, "").slice(0, 8);
      if (e.target.value !== clean) {
        e.target.value = clean;
        e.target.setSelectionRange(clean.length, clean.length);
      }
      state.mesaQuery = clean;
      state.mesaPage = 1;
      refreshMesaUi();
      return;
    }
    if (e.target.id === "comentario" || e.target.id === "dieta" || e.target.id === "alergias") {
      grabFields();
      persistDraft();
    }
  });
  window.addEventListener("online", () => {
    state.online = true;
    refreshPendPill();
    flushQueue().then((s) => {
      if (s?.duplicates) speak("Hoy ya envió. Solo extra.");
      else if (s?.sent) speak("Enviado");
      refreshPendPill();
      refreshHomeLock();
      if (supervisor()) syncTurnoDelDia().then(() => refreshHomeLock());
    });
  });
  window.addEventListener("offline", () => {
    state.online = false;
    refreshPendPill();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      scanner.pause();
      try { store.checkpoint(); } catch { /* la cola ya está en local */ }
      armBackgroundSync();
      return;
    }
    if (document.visibilityState === "visible") {
      state.online = navigator.onLine;
      if ((state.view === "home" || state.view === "supervisor") && !state.camOff && !state.loggingIn) {
        const video = document.getElementById("cam");
        if (video && scanner.isLiveOn(video)) {
          scanner.resume();
          scanner.setBusy(!!state.isProcessing);
          video.play().catch(() => {});
        } else if (video) {
          startCamHere();
        }
      }
      store.restoreSesion().then(() => {
        if (state.view !== "welcome" && state.view !== "supervisor" && state.view !== "lock" && !supervisor()) {
          show("supervisor", { replace: true });
          return;
        }
        flushQueue().then(() => refreshPendPill());
        if (supervisor()) syncTurnoDelDia().then(() => refreshHomeLock());
      });
    }
  });
  window.addEventListener("pagehide", () => {
    try { store.checkpoint(); } catch { /* la cola ya está en local */ }
    armBackgroundSync();
  });
  window.addEventListener("pageshow", () => {
    state.online = navigator.onLine;
    store.restoreSesion().then(() => {
      flushQueue().then(() => refreshPendPill());
      if (supervisor()) syncTurnoDelDia().then(() => refreshHomeLock());
    });
  });
  window.addEventListener("popstate", syncFromUrl);
  window.addEventListener("hashchange", syncFromUrl);

  const catalogs = Promise.all([
    loadJson("./data/config.json", {}),
    loadJson("./data/supervisors.json", { supervisores: [] }),
  ]);

  if ("serviceWorker" in navigator) {
    watchAppUpdates();
    const restKey = "qb_rest_" + CACHE_NAME;
    const requestRest = () => {
      try {
        if (localStorage.getItem(restKey) === "1") return;
      } catch { /* sigue */ }
      navigator.serviceWorker.controller?.postMessage("WARM_REST");
    };
    navigator.serviceWorker.addEventListener("message", (event) => {
      if (event.data !== "WARM_REST_OK") return;
      try { localStorage.setItem(restKey, "1"); } catch { /* sigue */ }
    });
    navigator.serviceWorker.addEventListener("controllerchange", requestRest);
    if (navigator.serviceWorker.controller) requestRest();
    navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" }).catch(() => {});
  }

  const [cfg, sup] = await catalogs;
  state.cfg = cfg;
  state.menu = null;
  state.items = [];

  state.supByDni = new Map();
  const byDni = sup.byDni && typeof sup.byDni === "object" ? sup.byDni : {};
  for (const [dni, row] of Object.entries(byDni)) {
    const person = mapTrabajador({ dni, nombre: row.nombre, cargo: row.cargo || "SUPERVISOR DE COSECHA" });
    if (!person.dni) continue;
    state.supByDni.set(person.dni, {
      ...person,
      celular: row.celular || "",
      supervisorGlobal: row.supervisorGlobal || "",
      encargadoDni: row.encargadoDni || "",
    });
  }
  if (!state.supByDni.size && Array.isArray(sup.supervisores)) {
    for (const row of sup.supervisores) {
      const person = mapTrabajador(row);
      if (person.dni) state.supByDni.set(person.dni, person);
    }
  }
  state.supervisors = [...state.supByDni.values()];
  state.oficial = state.supByDni;
  state.workers = [];
  if (cfg.appsScriptUrl) store.setScriptUrl(cfg.appsScriptUrl);
  ensureWorkers();

  await store.restoreSesion();
  dropScanCola();
  const hash = viewFromHash();
  const wasUpdating = (() => {
    try { return !!sessionStorage.getItem("qb_updating"); } catch { return false; }
  })();
  if (supervisor()) {
    store.setSesion(supervisor());
    const next = hash && hash !== "welcome" && hash !== "lock" && hash !== "supervisor" ? hash : "home";
    show(next, { replace: true });
    syncTurnoDelDia({ timeoutMs: 2200 }).then(() => refreshHomeLock());
  } else {
    show(hash === "supervisor" ? "supervisor" : "welcome", { replace: true });
    if (state.view === "welcome" && !wasUpdating) speak("Bienvenido a Cocina Q Berries");
  }
  startAutoSync((summary) => {
    refreshPendPill();
    refreshHomeLock();
    if (summary?.sent) notifyUploaded(summary.sent);
  });
  if (wasUpdating) hideUpdatingVeil();
}

function enterApp() {
  if (!isFieldDevice()) {
    show("lock", { replace: true });
    return;
  }
  if (state.view !== "welcome") return;
  state.entered = true;
  unlockVoice();
  if (!supervisor()) {
    speak("Escanea al supervisor");
    show("supervisor");
    return;
  }
  const who = prepareSpeakName(supervisor());
  speak(who ? `Bienvenido ${who}` : "Bienvenido", { flush: true });
  show("home");
}

boot();

export { encodeQr };
