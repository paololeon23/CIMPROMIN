import { APP_VERSION, APP_ASSETS, CACHE_NAME, FORM_TYPES, TZ, encodeQr, parseQr, normalizeDni, isSesionDni, todayKey, uuid, nowParts } from "./config.js";
import { bindAppHeight, bindFieldLock, isFieldDevice, preventBounce } from "./device.js";
import { recordsOfToday, store } from "./store.js";
import { onVoiceState, setVoiceEnabled, speak, speakPersonName, prepareSpeakName, unlockVoice, voiceEnabled, isSpeaking } from "./voice.js";
import { computeHeadcount } from "./calc.js";
import { armBackgroundSync, checkTurno, flushNow, flushQueue, isClientInflight, pingServer, saveAndSync, startAutoSync } from "./sync.js";
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
        <h3>Tareo de personal</h3>
        <p>En Safari: toque Compartir y luego Agregar a pantalla de inicio. El nombre es Tareo.</p>
        <button class="btn" data-act="dismiss-alert" type="button">Entendido</button>
      </div>
    </div>`);
    return;
  }
  showAlert("Instalar", "En el menú del navegador elija Instalar app o Agregar a pantalla de inicio. El nombre es Tareo.");
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
  lunchDni: "",
  lunchClase: "",
  retiroDni: "",
  retiroStamp: null,
  lunchHold: false,
  lunchTimer: 0,
  lunchHablado: "",
  lunchHH: "12",
  lunchMM: "00",
  lunchMasivo: false,
  massIni: "12:00",
  massFin: "13:00",
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
  histFecha: "",
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
    : `<button class="brand-mark" data-act="logo-tap" type="button" aria-label="CIMPROMIN">
        <img src="./assets/CIMPROMIN_alta_calidad.png" alt="" />
      </button>`;
  const bar = progress == null
    ? ""
    : `<div class="appbar-progress"><i style="width:${Math.max(0, Math.min(100, progress))}%"></i></div>`;
  return `<header class="appbar">
    <div class="appbar-row">
      <div class="appbar-lead">${lead}</div>
      <div class="appbar-titles">
        <span class="brand-kicker">CIMPROMIN</span>
        <h1>${esc(title || "Tareo")}</h1>
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
  paintTareoHoy();
  refreshPendPill();
}

function isSendLocked() {
  // Tareo: no frenar el turno después de un envío. Eso era de la solicitud de almuerzo.
  return false;
}

function warnLocked() {
  showAlert(
    "Ya envió",
    `El tareo de hoy ya se envió. Pulse Extra si alguien se olvidó o llegó tarde.`
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
    showAlert("Todavía no", "Primero envíe el tareo del turno. Después puede mandar extras, también sin señal.");
    return;
  }
  // Extra siempre arranca vacío. No se carga el almuerzo del supervisor.
  state.extraOn = true;
  state.extraHold = false;
  store.clearMesa();
  speak("Tareo extra. Lista vacía. Escanee solo a quien falta.");
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
  const sid = normalizeDni(supervisor()?.dni || supervisor()?.id || "");
  const seen = new Set();
  const rows = [];
  const take = (r, pending) => {
    if (!r || (r.type !== "lista" && r.type !== "extra")) return;
    if (!pending && r.confirmed === false) return;
    const psid = normalizeDni(r.payload?.supervisor_id || "");
    if (sid && psid && psid !== sid) return;
    const id = histRecordId(r);
    if (!id || seen.has(id)) return;
    seen.add(id);
    rows.push(pending ? { ...r, pending: true } : r);
  };
  store.getHistorial().forEach((r) => take(r, false));
  store.getCola().forEach((r) => take(r, true));
  rows.sort((a, b) => (b.savedAt || b.createdAt || 0) - (a.savedAt || a.createdAt || 0));
  return rows;
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

function histFecha(iso) {
  const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "—";
}

function histCantidad(r) {
  const people = histPersonas(r);
  if (people.length) return people.reduce((sum, person) => sum + menuQty(person), 0);
  const n = Number(r.payload?.trabajadores_unicos);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function fechaLarga(iso) {
  const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return histFecha(iso);
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  const dias = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];
  return `${dias[date.getUTCDay()]} ${m[3]}/${m[2]}/${m[1]}`;
}

function asistenciasPorFecha() {
  const byDate = new Map();
  for (const mark of store.getJornada()) {
    const dni = normalizeDni(mark?.dni);
    if (!mark?.fecha || !dni) continue;
    if (!byDate.has(mark.fecha)) byDate.set(mark.fecha, new Map());
    const people = byDate.get(mark.fecha);
    if (!people.has(dni)) {
      people.set(dni, {
        dni,
        apellido: mark.apellido || "",
        nombre: mark.nombre || "",
        cargo: mark.cargo || "",
        marks: [],
      });
    }
    const person = people.get(dni);
    if (mark.apellido) person.apellido = mark.apellido;
    if (mark.nombre) person.nombre = mark.nombre;
    if (mark.cargo) person.cargo = mark.cargo;
    person.marks.push(mark);
  }
  return [...byDate.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([fecha, people]) => ({
      fecha,
      personas: [...people.values()].map((person) => ({
        ...person,
        marks: person.marks.sort((a, b) => (a.at || 0) - (b.at || 0)),
      })).sort((a, b) => String(a.apellido).localeCompare(String(b.apellido), "es")),
    }));
}

function fechasVisibles(dias) {
  const elegida = String(state.histFecha || "");
  if (!elegida) return dias.slice(0, 3);
  const idx = dias.findIndex((dia) => dia.fecha === elegida);
  if (idx < 0) return [];
  return dias.slice(idx, idx + 3);
}

function coincidePersona(person, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return true;
  const blob = `${person.apellido || ""} ${person.nombre || ""} ${person.dni || ""}`.toLowerCase();
  return q.split(/\s+/).every((part) => blob.includes(part));
}

function marcasFila(person) {
  return person.marks.map((mark) => {
    const salida = mark.tipo === "salida";
    return `<span class="jornada-line ${salida ? "out" : "in"}"><i>${salida ? "Salida" : "Entrada"}</i><b>${horaMinutos(mark.hora)}</b></span>`;
  }).join("");
}

function showHistorialModal() {
  closeFab();
  const dias = asistenciasPorFecha();
  const query = String(state.histPeopleQuery || "").trim();
  const elegida = String(state.histFecha || "");
  const visibles = fechasVisibles(dias);
  const openId = state.histOpen || "";
  let body = "";
  if (query) {
    const hits = [];
    for (const dia of dias) {
      for (const person of dia.personas) {
        if (coincidePersona(person, query)) hits.push({ ...person, fecha: dia.fecha });
      }
    }
    body = hits.map((person) => (
      `<div class="hist-person">
        <div>
          <b>${esc(nombreFila(person))}</b>
          <div class="meta">DNI ${esc(person.dni)}</div>
          <div class="meta">${esc(fechaLarga(person.fecha))}</div>
          <div class="jornada">${marcasFila(person)}</div>
        </div>
      </div>`
    )).join("") || `<p class="sub">Nadie coincide con esa búsqueda.</p>`;
  } else if (elegida && !visibles.length) {
    body = `<p class="sub">Nadie asistió el ${esc(fechaLarga(elegida))}.</p>`;
  } else if (!dias.length) {
    body = `<p class="sub">Aún no hay asistencia registrada.</p>`;
  } else {
    body = visibles.map((dia) => {
      const n = dia.personas.length;
      const open = openId === dia.fecha;
      const people = dia.personas.map((person) => (
        `<div class="hist-person">
          <div>
            <b>${esc(nombreFila(person))}</b>
            <div class="meta">DNI ${esc(person.dni)}${person.cargo ? ` · ${esc(person.cargo)}` : ""}</div>
            <div class="jornada">${marcasFila(person)}</div>
          </div>
        </div>`
      )).join("");
      return `<div class="hist-item${open ? " open" : ""}">
        <button type="button" class="asist-day" data-act="toggle-hist" data-id="${esc(dia.fecha)}" aria-expanded="${open ? "true" : "false"}">
          <div>
            <b>${esc(fechaLarga(dia.fecha))}</b>
            <span>${n} ${n === 1 ? "persona" : "personas"}</span>
          </div>
          <b class="asist-n">${n}</b>
        </button>
        ${open ? `<div class="asist-people">${people}</div>` : ""}
      </div>`;
    }).join("");
  }
  openAlert(`<div class="modal-back" data-act="dismiss-alert">
    <div class="modal summary-modal" role="dialog" aria-modal="true" data-act="stay">
      ${sectionHead("Historial", "Asistencia por fecha. Busque a una persona para ver si vino.")}
      <div class="asist-tools">
        <label class="asist-cal">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path fill="none" stroke="currentColor" stroke-width="1.8" d="M3 10h18M8 3v4M16 3v4"/></svg>
          <span>${elegida ? esc(fechaLarga(elegida)) : "Últimas 3 fechas"}</span>
          <input id="hist-fecha" type="date" value="${esc(elegida)}" max="${esc(todayKey(TZ))}" aria-label="Elegir fecha">
        </label>
        ${elegida ? `<button class="asist-clear" data-act="hist-fechas-recientes" type="button">Últimas 3</button>` : ""}
      </div>
      <div class="field asist-search">
        <label>Buscar persona</label>
        <input id="hist-search" type="search" autocomplete="off" placeholder="Nombre o DNI" value="${esc(query)}">
      </div>
      <div class="hist-list">${body}</div>
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
  openAlert(`<div class="modal-back" data-act="dismiss-alert">
    <div class="modal summary-modal perfil" role="dialog" aria-modal="true" data-act="stay">
      <header class="perfil-head">
        <p>Perfil</p>
        <h2>${esc(nombreFila(s) || "—")}</h2>
      </header>
      <div class="perfil-card">
        ${avatarHtml(s || {}, "lg")}
        <p class="perfil-dni">DNI ${esc(s?.dni || s?.id || "—")}</p>
        <p class="perfil-cargo">${esc(s?.cargo || "—")}</p>
        <span class="perfil-rol">${s?.emergencia ? "Jefe de emergencia" : "Jefe del turno"}</span>
      </div>
      <div class="footer-actions">
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
    document.getElementById("fTempDni")?.classList.remove("bad");
    document.getElementById("fTempNom")?.classList.remove("bad");
    return;
  }
  if (name.dataset.auto === "1") {
    name.value = "";
    delete name.dataset.auto;
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
      ${sectionHead("Persona temporal", "Escriba el DNI. Si está en la base, el nombre se llena solo. Si no está, el nombre es obligatorio.")}
      <div class="field" id="fTempDni">
        <label>DNI</label>
        <input id="tempDni" inputmode="numeric" maxlength="8" autocomplete="off" placeholder="8 dígitos">
      </div>
      <div class="field" id="fTempNom">
        <label>Nombre</label>
        <input id="tempNombre" autocomplete="off" placeholder="Apellidos y nombres" autocapitalize="characters">
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

function tareadosHoy() {
  const ids = new Set();
  const add = (raw) => {
    const id = normalizeDni(raw);
    if (id) ids.add(id);
  };
  for (const person of getMesa()) add(person.id || person.dni);
  const day = todayKey(TZ);
  const sid = normalizeDni(supervisor()?.dni || supervisor()?.id || "");
  for (const row of store.getCola().concat(store.getHistorial())) {
    if (!row || (row.type !== "lista" && row.type !== "extra")) continue;
    if (row.confirmed === false) continue;
    const payload = row.payload || {};
    if (payload.fecha_local !== day) continue;
    const rowSid = normalizeDni(payload.supervisor_id || "");
    if (sid && rowSid && rowSid !== sid) continue;
    for (const person of payload.personas || []) add(person?.dni || person?.id);
  }
  return ids.size;
}

function paintTareoHoy() {
  const n = tareadosHoy();
  const num = document.getElementById("tareo-hoy-num");
  const label = document.getElementById("tareo-hoy-label");
  if (num) num.textContent = String(n);
  if (label) label.textContent = n === 1 ? "persona tareada hoy" : "personas tareadas hoy";
}

function lotePills() {
  const extra = !!state.extraOn || !!state.extraHold;
  const n = tareadosHoy();
  return `<div class="lote-pills" role="group" aria-label="Tareo de hoy">
    <div class="tareo-hoy-count" aria-live="polite">
      <b id="tareo-hoy-num">${n}</b>
      <span id="tareo-hoy-label">${n === 1 ? "persona tareada hoy" : "personas tareadas hoy"}</span>
    </div>
    <button type="button" class="extra${extra ? " on" : ""}" data-act="toggle-extra">Extra</button>
  </div>`;
}

function loteCard() {
  const locked = isSendLocked();
  const extra = !!state.extraOn;
  return `<section class="section-card">
    ${extra ? `<p class="extra-note">Modo extra activo. Se olvidó o llegó tarde.</p>` : ""}
    ${locked ? `<p class="extra-note">Ya envió el tareo. Pulse Extra si falta alguien.</p>` : ""}
    ${!locked && !extra && !navigator.onLine ? `<p class="extra-note">Sin señal. Puede escanear y enviar.</p>` : ""}
    ${sectionHead("Turno", extra ? "Solo quien falta. Entra como extra." : "Jornada del turno. Luego identifique a cada persona.")}
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
  if (e.target.id === "hist-fecha") {
    state.histFecha = String(e.target.value || "");
    state.histOpen = state.histFecha;
    showHistorialModal();
    return;
  }
  if (e.target.id === "hist-search") {
    state.histPeopleQuery = String(e.target.value || "").slice(0, 48);
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

function mealWord(_lote, n) {
  return n === 1 ? "registro" : "registros";
}

function comedorPills() {
  const cur = currentComedor();
  return `<div class="lote-pills comedor-pills" role="group" aria-label="Lugar">
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
    host.addEventListener("change", onPickInput);
    host.addEventListener("keydown", onPickKey);
  }
  return host;
}

function openAlert(html) {
  ensureAlertHost().innerHTML = html;
  document.body.classList.add("modal-open");
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
        <img src="./assets/CIMPROMIN_alta_calidad.png" alt="CIMPROMIN" width="280" height="280" decoding="async" fetchpriority="high" />
      </figure>
    </div>
    <div class="welcome-sheet">
      <h1>Tareo de <span>personal</span></h1>
      <p>El jefe inicia sesión y registra a su equipo.</p>
      <div class="dots" aria-hidden="true"><i class="on"></i><i></i><i></i></div>
      <button class="cta" data-act="enter" type="button">Iniciar sesión</button>
      ${installSlot()}
    </div>
  </section>`);
}

function lockView() {
  render(`<section class="lock">
    <div class="lock-card">
      <figure class="lock-mark">
        <img src="./assets/CIMPROMIN_alta_calidad.png" alt="CIMPROMIN" />
      </figure>
      <h1>Ábrela en el celular</h1>
      <p>El tareo se registra desde el teléfono del jefe de turno.</p>
    </div>
  </section>`);
}

function qrIcon() {
  return `<svg class="qr-ic" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M3 3h8v8H3zm2 2v4h4V5zm8-2h8v8h-8zm2 2v4h4V5zM3 13h8v8H3zm2 2v4h4v-4zm10-2h3v3h-3zm5 0h3v3h-3zm-5 5h3v5h-3zm5 5h3v3h-3zm-2-3h2v2h-2z"/></svg>`;
}

function camActions() {
  return `<div class="cam-actions">
    <button class="btn cam" data-act="start-cam" type="button">${qrIcon()} Escanear QR</button>
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

const MARCA_GAP_MS = 8000;
const CONFIRMA_MS = 1600;

const CLASE_MARCA = {
  entrada: { label: "Entrada", habla: "Entrada", kind: "in", tipo: "entrada" },
  almuerzo: { label: "Salida", habla: "Salida", kind: "break", tipo: "salida" },
  retorno: { label: "Entrada", habla: "Entrada", kind: "back", tipo: "entrada" },
  salida: { label: "Salida", habla: "Salida", kind: "out", tipo: "salida" },
};

function claseMarcacion(mark, index) {
  if (mark?.clase && CLASE_MARCA[mark.clase]) return mark.clase;
  if (mark?.tipo === "salida") return "salida";
  return index > 0 ? "retorno" : "entrada";
}

function esMarcaAlmuerzo(mark) {
  return mark?.clase === "almuerzo" || mark?.clase === "retorno";
}

function siguienteClase(previas, hora) {
  // El almuerzo va por el tenedor con hora editable; el escaneo solo mira entrada y salida.
  const scans = (previas || []).filter((m) => !esMarcaAlmuerzo(m));
  const last = scans.at(-1);
  if (!last) return "entrada";
  const clase = claseMarcacion(last, scans.length - 1);
  if (clase === "entrada") return "salida";
  // Ya marcó salida hoy: no hay otra entrada el mismo día.
  return "cerrado";
}

function yaMarcoSalidaHoy(dni) {
  return marcasDe(dni).some((m) => !esMarcaAlmuerzo(m) && (m.clase === "salida" || m.tipo === "salida"));
}

function avisoSalidaCerrada(worker) {
  const nombre = prepareSpeakName(worker) || twoApellidos(worker) || "";
  const dni = normalizeDni(worker?.dni || worker?.id) || "—";
  showScanHit({
    dni,
    nombre,
    cargo: [nameParts(worker).nombre, worker?.cargo].filter(Boolean).join(" · "),
    ok: false,
    stateLabel: "Ya marcó salida",
    note: "Personal que marcó salida no está permitido ingresar.",
  });
  showScanToast("Ya marcó salida. No puede ingresar otra vez hoy.", 2400);
  speak("Personal que marcó salida no está permitido ingresar.", { flush: true });
}

function marcasDe(dni, fecha = todayKey(TZ)) {
  const key = normalizeDni(dni);
  if (!key) return [];
  return store.getJornada()
    .filter((m) => normalizeDni(m.dni) === key && m.fecha === fecha)
    .sort((a, b) => (a.at || 0) - (b.at || 0));
}

function marcaDemasiadoPronto(dni) {
  const last = marcasDe(dni).filter((m) => !esMarcaAlmuerzo(m)).at(-1);
  if (!last) return false;
  const gap = Date.now() - (last.at || 0);
  return gap >= 0 && gap < MARCA_GAP_MS;
}

function semanaActual() {
  const t = nowParts(TZ);
  const [y, mo, d] = t.fecha.split("-").map(Number);
  const date = new Date(Date.UTC(y, mo - 1, d));
  const mondayOffset = (date.getUTCDay() + 6) % 7;
  const start = new Date(date);
  start.setUTCDate(date.getUTCDate() - mondayOffset);
  const days = [];
  for (let i = 0; i < 7; i += 1) {
    const day = new Date(start);
    day.setUTCDate(start.getUTCDate() + i);
    days.push(day.toISOString().slice(0, 10));
  }
  return days;
}

function aMinutos(raw) {
  const m = String(raw || "").match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function jornadaDe(dni, fecha = todayKey(TZ)) {
  const marks = marcasDe(dni, fecha);
  const hoy = fecha === todayKey(TZ);
  const ahora = aMinutos(nowParts(TZ).hora);
  const eventos = marks.map((mark, i) => {
    const next = marks[i + 1];
    let label = "Entrada";
    let kind = "in";
    const clase = claseMarcacion(mark, i);
    if (CLASE_MARCA[clase] && mark.clase) {
      label = CLASE_MARCA[clase].label;
      kind = CLASE_MARCA[clase].kind;
    } else if (mark.tipo === "salida") {
      const temporal = !!(next && next.tipo === "entrada");
      label = "Salida";
      kind = temporal ? "break" : "out";
    } else if (i > 0) {
      label = "Retorno";
      kind = "back";
    }
    return { ...mark, label, kind };
  });
  let dentro = 0;
  let fuera = 0;
  for (let i = 0; i < marks.length; i += 1) {
    const a = aMinutos(marks[i].hora);
    const b = marks[i + 1] ? aMinutos(marks[i + 1].hora) : null;
    if (a == null) continue;
    if (marks[i].tipo === "entrada") {
      const end = b != null ? b : (hoy && ahora != null ? ahora : null);
      if (end != null && end >= a) dentro += end - a;
    } else if (b != null && b >= a) {
      fuera += b - a;
    }
  }
  const first = marks[0];
  const last = marks.at(-1);
  let empresa = null;
  if (first) {
    const a = aMinutos(first.hora);
    const b = last?.tipo === "salida"
      ? aMinutos(last.hora)
      : (hoy && ahora != null ? ahora : aMinutos(last?.hora));
    if (a != null && b != null && b >= a) empresa = b - a;
  }
  const lastClase = last?.clase || (last?.tipo === "salida" ? "salida" : "");
  const completo = lastClase === "salida";
  return {
    eventos,
    dentro,
    fuera,
    empresa,
    completo,
    incompleto: marks.length > 0 && !completo,
    dentroEstado: last?.tipo === "entrada",
  };
}

function semanaDe(dni) {
  let efectivas = 0;
  let completos = 0;
  let incompletas = 0;
  for (const fecha of semanaActual()) {
    const j = jornadaDe(dni, fecha);
    if (!j.eventos.length) continue;
    efectivas += j.dentro;
    if (j.completo) completos += 1;
    else incompletas += 1;
  }
  return { efectivas, completos, incompletas };
}

function fmtDur(mins) {
  if (mins == null || mins < 0) return "—";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

function personaAlmuerzo(id) {
  const mesa = getMesa().find((p) => normalizeDni(p.id) === id) || {};
  const oficial = findWorkerByDni(id) || {};
  const pick = (key) => mesa[key] || oficial[key] || "";
  return {
    dni: id,
    id,
    apellido: pick("apellido"),
    nombre: pick("nombre"),
    nombreCompleto: pick("nombreCompleto"),
    cargo: pick("cargo") || pick("area"),
    area: pick("area") || pick("cargo"),
  };
}

function showLunchModal(dni, claseKeep) {
  const id = normalizeDni(dni);
  if (!id) return;
  state.lunchDni = id;
  const who = personaAlmuerzo(id);
  const salio = marcaAlmuerzo(id, "almuerzo");
  const entro = marcaAlmuerzo(id, "retorno");
  if (claseKeep === "almuerzo" || claseKeep === "retorno") state.lunchClase = claseKeep;
  else state.lunchClase = salio && !entro ? "retorno" : "almuerzo";
  const elegida = state.lunchClase === "retorno" ? entro : salio;
  const hora = elegida?.hora || (state.lunchClase === "retorno" ? "13:00" : "12:00");
  ponerReloj(hora);
  const nombre = displayName(who);
  const entradaDia = marcasDe(id).find((m) => m.clase === "entrada") || null;
  const on = (clase) => state.lunchClase === clase ? " lunch-on" : "";
  const aviso = avisoGuardado();
  openAlert(`<div class="modal-back" data-act="dismiss-alert">
    <div class="modal summary-modal lunch-modal" role="dialog" aria-modal="true" data-act="stay">
      <h2>Almuerzo</h2>
      <p class="lunch-name">${esc(nombre || id)}</p>
      <p class="lunch-dni">${entradaDia ? `Entrada ${esc(horaMinutos(entradaDia.hora))}` : "Sin entrada"}</p>
      <div class="time-picker-modal">
        <div class="time-picker-head">
          <div class="time-picker-title">Seleccionar hora</div>
          <div class="time-picker-current" id="time-picker-current">${esc(horaReloj())}</div>
        </div>
        <div class="time-picker-wheel" id="lunch-hora">
          <div class="time-picker-col">
            <button type="button" class="time-picker-step" data-act="lunch-step" data-part="h" data-dir="1" aria-label="Subir hora">▲</button>
            <div class="time-picker-value" id="time-picker-hour">${esc(state.lunchHH)}</div>
            <button type="button" class="time-picker-step" data-act="lunch-step" data-part="h" data-dir="-1" aria-label="Bajar hora">▼</button>
          </div>
          <div class="time-picker-sep">:</div>
          <div class="time-picker-col">
            <button type="button" class="time-picker-step" data-act="lunch-step" data-part="m" data-dir="1" aria-label="Subir minuto">▲</button>
            <div class="time-picker-value" id="time-picker-minute">${esc(state.lunchMM)}</div>
            <button type="button" class="time-picker-step" data-act="lunch-step" data-part="m" data-dir="-1" aria-label="Bajar minuto">▼</button>
          </div>
        </div>
        <div class="time-picker-actions">
          <button type="button" class="btn ghost" data-act="lunch-now">Tomar hora exacta</button>
          <button type="button" class="btn ghost" data-act="lunch-cancel">Cancelar</button>
          <button type="button" class="btn" data-act="lunch-apply">Tomar hora</button>
        </div>
      </div>
      <p class="lunch-hint${aviso ? " bad" : ""}" id="lunch-aviso">${aviso ? esc(aviso) : "Si hay cola, corrija la hora. Así nadie sale perjudicado."}</p>
      <div class="lunch-actions">
        <button class="btn ghost${on("almuerzo")}" data-act="lunch-pick" data-clase="almuerzo" data-id="${esc(id)}" type="button">Inicio almuerzo<small>${esc(salio?.hora || "12:00")}</small></button>
        <button class="btn ghost${on("retorno")}" data-act="lunch-pick" data-clase="retorno" data-id="${esc(id)}" type="button">Fin de almuerzo<small>${esc(entro?.hora || "13:00")}</small></button>
      </div>
      <button class="btn lunch-close" data-act="lunch-save" type="button">Guardar</button>
    </div>
  </div>`);
}

function pintarRelojVista() {
  const hh = document.getElementById("time-picker-hour");
  const mm = document.getElementById("time-picker-minute");
  const cur = document.getElementById("time-picker-current");
  if (hh) hh.textContent = state.lunchHH;
  if (mm) mm.textContent = state.lunchMM;
  if (cur) cur.textContent = horaReloj();
}

function ponerReloj(hora) {
  const clean = horaMinutos(hora) || "00:00";
  const [hh, mm] = clean.split(":");
  state.lunchHH = String(hh || "00").padStart(2, "0");
  state.lunchMM = String(mm || "00").padStart(2, "0");
  pintarRelojVista();
}

function stepReloj(part, dir) {
  const step = Number(dir) || 0;
  if (part === "h") {
    let h = (Number(state.lunchHH) + step + 24) % 24;
    state.lunchHH = String(h).padStart(2, "0");
  } else {
    let m = (Number(state.lunchMM) + step + 60) % 60;
    state.lunchMM = String(m).padStart(2, "0");
  }
  pintarRelojVista();
}

function pintarOpcion() {
  document.querySelectorAll("[data-act='lunch-pick']").forEach((el) => {
    el.classList.toggle("lunch-on", el.dataset.clase === state.lunchClase);
  });
}

function limitesAlmuerzo(clase) {
  const marks = marcasDe(state.lunchDni);
  const entrada = marks.find((m) => m.clase === "entrada");
  const salida = [...marks].reverse().find((m) => m.clase === "salida");
  const salio = marcaAlmuerzo(state.lunchDni, "almuerzo");
  const entro = marcaAlmuerzo(state.lunchDni, "retorno");
  let min = null;
  let minHora = "";
  let minAviso = "";
  let max = null;
  let maxHora = "";
  let maxAviso = "";
  if (entrada && aMinutos(entrada.hora) != null) {
    min = aMinutos(entrada.hora);
    minHora = entrada.hora;
    minAviso = "No puede ser antes de la entrada.";
  }
  // Inicio puede ser igual o antes que el fin. Solo se rechaza si queda después.
  if (clase === "retorno" && salio && aMinutos(salio.hora) != null && (min == null || aMinutos(salio.hora) > min)) {
    min = aMinutos(salio.hora);
    minHora = salio.hora;
    minAviso = "El fin no puede ser antes del inicio.";
  }
  if (clase === "almuerzo" && entro && aMinutos(entro.hora) != null) {
    max = aMinutos(entro.hora);
    maxHora = entro.hora;
    maxAviso = "El inicio no puede ser después del fin.";
  }
  if (salida && aMinutos(salida.hora) != null && (max == null || aMinutos(salida.hora) < max)) {
    max = aMinutos(salida.hora);
    maxHora = salida.hora;
    maxAviso = "No puede ser después de la salida.";
  }
  return { min, minHora, minAviso, max, maxHora, maxAviso };
}

function ordenAlmuerzo(clase, hora) {
  const limpia = horaMinutos(hora);
  // 00:00 = sin pausa de almuerzo (salida anticipada).
  if (limpia === "00:00") return { ok: true, hora: "00:00", aviso: "" };
  const nueva = aMinutos(limpia);
  if (nueva == null) return { ok: false, hora: "", aviso: "" };
  const lim = limitesAlmuerzo(clase);
  if (lim.min != null && nueva < lim.min) return { ok: false, hora: lim.minHora, aviso: lim.minAviso };
  if (lim.max != null && nueva > lim.max) return { ok: false, hora: lim.maxHora, aviso: lim.maxAviso };
  return { ok: true, hora: limpia, aviso: "" };
}

function avisoGuardado() {
  if (esSinAlmuerzo(state.lunchDni)) return "";
  const salio = marcaAlmuerzo(state.lunchDni, "almuerzo");
  const entro = marcaAlmuerzo(state.lunchDni, "retorno");
  if (salio) {
    const orden = ordenAlmuerzo("almuerzo", salio.hora);
    if (!orden.ok) return orden.aviso;
  }
  if (entro) {
    const orden = ordenAlmuerzo("retorno", entro.hora);
    if (!orden.ok) return orden.aviso;
  }
  return "";
}

function hablarTareo(texto) {
  const phrase = String(texto || "").replace(/almuerzo/ig, "").replace(/\s+/g, " ").trim();
  if (!phrase || phrase === state.lunchHablado) return;
  state.lunchHablado = phrase;
  speak(phrase, { flush: true });
}

function fraseMarcacion(clase) {
  const nombre = prepareSpeakName(personaAlmuerzo(state.lunchDni));
  const habla = clase === "retorno" ? "Fin" : "Inicio";
  return [habla, nombre].filter(Boolean).join(". ");
}

function avisoAlmuerzo(texto) {
  const el = document.getElementById("lunch-aviso");
  if (!el) return;
  el.textContent = texto || "Si hay cola, corrija la hora. Así nadie sale perjudicado.";
  el.classList.toggle("bad", !!texto);
}

function aplicarHoraAlmuerzo({ hablar = true } = {}) {
  const hora = horaReloj();
  const clase = state.lunchClase === "retorno" ? "retorno" : "almuerzo";
  const orden = ordenAlmuerzo(clase, hora);
  if (!orden.ok) {
    avisoAlmuerzo(orden.aviso);
    hablarTareo(orden.aviso);
    const previa = marcaAlmuerzo(state.lunchDni, clase)?.hora || "";
    const previaMala = !!previa && !ordenAlmuerzo(clase, previa).ok;
    const volver = previaMala ? orden.hora : (previa || orden.hora);
    if (volver) ponerReloj(volver);
    return false;
  }
  avisoAlmuerzo("");
  if (!guardarAlmuerzo(state.lunchDni, clase, hora)) return false;
  const small = document.querySelector(`[data-act="lunch-pick"][data-clase="${clase}"] small`);
  if (small) small.textContent = hora;
  if (hablar) hablarTareo(fraseMarcacion(clase));
  if (state.view === "home") refreshMesaUi();
  return true;
}

function almuerzoEnviado(dni) {
  return marcasDe(dni).some((m) => esMarcaAlmuerzo(m) && m.enviado);
}

function marcarAlmuerzoEnviado(people) {
  const day = todayKey(TZ);
  const want = new Set((people || []).map((p) => normalizeDni(p.id || p.dni)).filter(Boolean));
  if (!want.size) return;
  let changed = false;
  const list = store.getJornada().map((m) => {
    if (m.fecha !== day || !esMarcaAlmuerzo(m) || m.enviado || !want.has(normalizeDni(m.dni))) return m;
    changed = true;
    return { ...m, enviado: true };
  });
  if (changed) store.setJornada(list);
}

function showMassLunchModal() {
  const libres = getMesa().filter((p) => !almuerzoEnviado(p.id || p.dni));
  if (!libres.length) {
    showAlert("Sin personas", getMesa().length
      ? "Todos ya tienen su hora enviada. Para cambiarla use el panel."
      : "Primero escanee a las personas.");
    return;
  }
  state.lunchMasivo = true;
  state.lunchDni = "";
  if (state.lunchClase !== "retorno") state.lunchClase = "almuerzo";
  ponerReloj(state.lunchClase === "retorno" ? state.massFin : state.massIni);
  const on = (clase) => state.lunchClase === clase ? " lunch-on" : "";
  openAlert(`<div class="modal-back" data-act="dismiss-alert">
    <div class="modal summary-modal lunch-modal" role="dialog" aria-modal="true" data-act="stay">
      <h2>Almuerzo de todos</h2>
      <p class="lunch-name">${libres.length} ${libres.length === 1 ? "persona" : "personas"}</p>
      <p class="lunch-dni">Para quienes entraron a la misma hora o cerca</p>
      <div class="time-picker-modal">
        <div class="time-picker-head">
          <div class="time-picker-title">Seleccionar hora</div>
          <div class="time-picker-current" id="time-picker-current">${esc(horaReloj())}</div>
        </div>
        <div class="time-picker-wheel" id="lunch-hora">
          <div class="time-picker-col">
            <button type="button" class="time-picker-step" data-act="lunch-step" data-part="h" data-dir="1" aria-label="Subir hora">▲</button>
            <div class="time-picker-value" id="time-picker-hour">${esc(state.lunchHH)}</div>
            <button type="button" class="time-picker-step" data-act="lunch-step" data-part="h" data-dir="-1" aria-label="Bajar hora">▼</button>
          </div>
          <div class="time-picker-sep">:</div>
          <div class="time-picker-col">
            <button type="button" class="time-picker-step" data-act="lunch-step" data-part="m" data-dir="1" aria-label="Subir minuto">▲</button>
            <div class="time-picker-value" id="time-picker-minute">${esc(state.lunchMM)}</div>
            <button type="button" class="time-picker-step" data-act="lunch-step" data-part="m" data-dir="-1" aria-label="Bajar minuto">▼</button>
          </div>
        </div>
        <div class="time-picker-actions">
          <button type="button" class="btn ghost" data-act="lunch-now">Tomar hora exacta</button>
          <button type="button" class="btn ghost" data-act="lunch-cancel">Cancelar</button>
          <button type="button" class="btn" data-act="lunch-apply">Tomar hora</button>
        </div>
      </div>
      <p class="lunch-hint" id="lunch-aviso">Nadie queda con almuerzo antes de su entrada. Quien salga distinto, se corrige con su tenedor.</p>
      <div class="lunch-actions">
        <button class="btn ghost${on("almuerzo")}" data-act="mass-pick" data-clase="almuerzo" type="button">Inicio almuerzo<small>${esc(state.massIni)}</small></button>
        <button class="btn ghost${on("retorno")}" data-act="mass-pick" data-clase="retorno" type="button">Fin de almuerzo<small>${esc(state.massFin)}</small></button>
      </div>
      <button class="btn lunch-close" data-act="mass-save" type="button">Guardar a todos</button>
    </div>
  </div>`);
}

function tomarHoraMasiva() {
  const hora = horaReloj();
  const clase = state.lunchClase === "retorno" ? "retorno" : "almuerzo";
  const ini = clase === "almuerzo" ? hora : state.massIni;
  const fin = clase === "retorno" ? hora : state.massFin;
  if (aMinutos(ini) > aMinutos(fin)) {
    avisoAlmuerzo(clase === "almuerzo" ? "El inicio no puede ser después del fin." : "El fin no puede ser antes del inicio.");
    ponerReloj(clase === "almuerzo" ? state.massIni : state.massFin);
    return false;
  }
  if (clase === "almuerzo") state.massIni = hora;
  else state.massFin = hora;
  avisoAlmuerzo("");
  const small = document.querySelector(`[data-act="mass-pick"][data-clase="${clase}"] small`);
  if (small) small.textContent = hora;
  return true;
}

function guardarAlmuerzoMasivo() {
  const ini = aMinutos(state.massIni);
  const fin = aMinutos(state.massFin);
  let hechos = 0;
  let omitidos = 0;
  for (const person of getMesa()) {
    const id = normalizeDni(person.id || person.dni);
    if (!id || almuerzoEnviado(id)) continue;
    const marks = marcasDe(id);
    const entrada = marks.find((m) => m.clase === "entrada");
    const salida = [...marks].reverse().find((m) => m.clase === "salida");
    const ent = entrada ? aMinutos(entrada.hora) : null;
    const sal = salida ? aMinutos(salida.hora) : null;
    if (ent == null || ent > ini || (sal != null && sal < fin)) {
      omitidos += 1;
      continue;
    }
    guardarAlmuerzo(id, "almuerzo", state.massIni);
    guardarAlmuerzo(id, "retorno", state.massFin);
    hechos += 1;
  }
  return { hechos, omitidos };
}

function cerrarLunchModal() {
  state.lunchMasivo = false;
  state.lunchDni = "";
  state.lunchClase = "";
  window.clearTimeout(state.lunchTimer);
  dismissAlert();
  if (state.view === "home") refreshMesaUi();
  if (state.view === "supervisor" || state.view === "home") resumeCam();
}

function horaReloj() {
  return `${state.lunchHH || "00"}:${state.lunchMM || "00"}`;
}

function marcaAlmuerzo(dni, clase) {
  return marcasDe(dni).find((m) => m.clase === clase) || null;
}

function msLima(fecha, hora) {
  const [y, mo, d] = String(fecha || "").split("-").map(Number);
  const [hh, mm] = String(hora || "").split(":").map(Number);
  if (!y || Number.isNaN(hh)) return Date.now();
  return Date.UTC(y, (mo || 1) - 1, d || 1, hh + 5, mm || 0, 0);
}

function guardarAlmuerzo(dni, clase, horaRaw) {
  const id = normalizeDni(dni);
  const hora = horaMinutos(horaRaw);
  if (!id || !hora || (clase !== "almuerzo" && clase !== "retorno")) return false;
  const t = nowParts(TZ);
  const who = personaAlmuerzo(id);
  const parts = nameParts(who);
  const list = store.getJornada().filter((m) => !(normalizeDni(m.dni) === id && m.fecha === t.fecha && m.clase === clase));
  list.push({
    dni: id,
    fecha: t.fecha,
    hora,
    at: msLima(t.fecha, hora),
    // tipo = clase para que el servidor no confunda retorno con entrada.
    tipo: clase,
    clase,
    apellido: twoApellidos(who),
    nombre: parts.nombre || who.nombre || "",
    cargo: who.cargo || who.area || "",
  });
  store.setJornada(list);
  return true;
}

function flechaMarca(salida) {
  const path = salida
    ? "M10 4H5.5A1.5 1.5 0 0 0 4 5.5v13A1.5 1.5 0 0 0 5.5 20H10M15 8l4 4-4 4M19 12H9"
    : "M14 4h4.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H14M10 8l4 4-4 4M14 12H4";
  return `<svg class="jornada-arrow" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/></svg>`;
}

function tieneAlmuerzo(dni) {
  const marks = marcasDe(dni);
  return marks.some((m) => m.clase === "almuerzo") && marks.some((m) => m.clase === "retorno");
}

/** Salida anticipada / sin pausa: almuerzo 00:00–00:00 y tenedor verde. */
function marcarSinAlmuerzo(dni) {
  const id = normalizeDni(dni);
  if (!id) return false;
  guardarAlmuerzo(id, "almuerzo", "00:00");
  guardarAlmuerzo(id, "retorno", "00:00");
  return true;
}

function esSinAlmuerzo(dni) {
  const salio = marcaAlmuerzo(dni, "almuerzo");
  const entro = marcaAlmuerzo(dni, "retorno");
  return horaMinutos(salio?.hora) === "00:00" && horaMinutos(entro?.hora) === "00:00";
}

function jornadaHtml(dni) {
  const j = jornadaDe(dni);
  if (!j.eventos.length) return "";
  const id = normalizeDni(dni);
  const who = getMesa().find((p) => normalizeDni(p.id) === id);
  const visibles = j.eventos.filter((ev) => ev.clase !== "almuerzo" && ev.clase !== "retorno");
  const lado = (salida) => visibles.filter((ev) => (ev.tipo === "salida") === salida).map((ev) => {
    const label = salida ? "Salida" : "Entrada";
    return `<span class="jornada-line ${salida ? "out" : "in"}"><i>${label}</i>${flechaMarca(salida)}<b>${horaMinutos(ev.hora)}</b></span>`;
  }).join("");
  const on = tieneAlmuerzo(id) ? " on ok" : "";
  const btn = `<button class="lunch-btn${on}" data-act="lunch-open" data-id="${esc(id)}" type="button" aria-label="Salida y entrada de ${esc(nombreFila(who) || id)}">${forkIcon()}</button>`;
  return `<div class="jornada"><span class="jornada-side">${lado(false)}</span>${btn}<span class="jornada-side right">${lado(true)}</span></div>`;
}

function asegurarEntradaPrevia(worker) {
  const dni = normalizeDni(worker?.dni || worker?.id);
  if (!dni || marcasDe(dni).length) return;
  const row = getMesa().find((p) => normalizeDni(p.id) === dni);
  if (!row) return;
  const t = nowParts(TZ);
  store.addMarcacion({
    dni,
    fecha: row.fecha || t.fecha,
    hora: horaMinutos(row.hora) || t.hora,
    at: row.escaneadoAt || t.ms,
    tipo: "entrada",
    clase: "entrada",
    apellido: row.apellido || "",
    nombre: row.nombre || "",
    cargo: row.cargo || "",
  });
}

function showRetiroModal(worker) {
  const id = normalizeDni(worker?.dni || worker?.id);
  if (!id) return;
  state.retiroDni = id;
  state.retiroStamp = nowParts(TZ);
  const who = personaAlmuerzo(id);
  const nombre = displayName(who) || id;
  const dicho = prepareSpeakName(who) || nombre;
  openAlert(`<div class="modal-back" data-act="stay">
    <div class="modal summary-modal" role="dialog" aria-modal="true" data-act="stay">
      <h2>¿Marcar salida?</h2>
      <p class="lunch-name">${esc(nombre)}</p>
      <p class="lunch-dni">DNI ${esc(id)} · Entrada ${esc(horaEntrada(id) || "—")}</p>
      <p class="lunch-hint">Ya hay una entrada. Este segundo escaneo puede cerrar el tareo sin almuerzo.</p>
      <div class="retiro-actions">
        <button class="btn" data-act="retiro-si" data-id="${esc(id)}" type="button">Sí, salir sin almuerzo</button>
        <button class="btn ghost" data-act="retiro-no" type="button">Cancelar</button>
      </div>
    </div>
  </div>`);
  speak(`Marcar salida sin almuerzo? ${dicho}`, { flush: true });
}

function horaEntrada(dni) {
  const mark = marcasDe(dni).find((m) => m.clase === "entrada" || m.tipo === "entrada");
  return mark?.hora || "";
}

function cerrarAvisoRetiro() {
  state.retiroDni = "";
  state.retiroStamp = null;
  dismissAlert();
  showScanToast("Sigue en la lista de tareo.", 1800);
  speak("Cancelado. Sigue en la lista.", { flush: true });
  if (state.view === "supervisor" || state.view === "home") resumeCam();
}

function choqueAlmuerzo(dni, hora) {
  const ahora = aMinutos(hora);
  if (ahora == null) return "";
  let max = null;
  let maxHora = "";
  for (const mark of marcasDe(dni)) {
    if (!esMarcaAlmuerzo(mark)) continue;
    const m = aMinutos(mark.hora);
    if (m != null && (max == null || m > max)) {
      max = m;
      maxHora = horaMinutos(mark.hora);
    }
  }
  return max != null && ahora < max ? maxHora : "";
}

function avisoChoqueAlmuerzo(worker, hora) {
  const nombre = prepareSpeakName(worker) || twoApellidos(worker) || "";
  const ahora = horaMinutos(nowParts(TZ).hora);
  showScanHit({
    dni: worker?.dni || worker?.id || "—",
    nombre,
    cargo: [nameParts(worker).nombre, worker?.cargo].filter(Boolean).join(" · "),
    ok: false,
    stateLabel: "Revise la hora",
    note: `Salida ${ahora} es antes del fin de almuerzo ${hora}. Corrija con el tenedor.`,
  });
  showScanToast(`Salida antes de ${hora}. Corrija el almuerzo.`, 2400);
  speak("La salida no puede ser antes del fin. Corrija la hora.", { flush: true });
}

function registrarMarcacion(worker, stamp) {
  const dni = normalizeDni(worker?.dni || worker?.id);
  if (!dni) return { ok: false };
  asegurarEntradaPrevia(worker);
  if (marcaDemasiadoPronto(dni)) return { ok: false, tooSoon: true };
  const previas = marcasDe(dni);
  const t = stamp || nowParts(TZ);
  const clase = siguienteClase(previas, t.hora);
  if (clase === "cerrado" || (clase === "entrada" && yaMarcoSalidaHoy(dni))) {
    return { ok: false, cerrado: true };
  }
  if (clase === "salida") {
    const choque = choqueAlmuerzo(dni, t.hora);
    if (choque) return { ok: false, choque };
  }
  const info = CLASE_MARCA[clase];
  if (!info) return { ok: false, cerrado: true };
  const parts = nameParts(worker);
  store.addMarcacion({
    dni,
    fecha: t.fecha,
    hora: horaMinutos(t.hora),
    at: t.ms,
    tipo: info.tipo,
    clase,
    apellido: twoApellidos(worker),
    nombre: parts.nombre || "",
    cargo: worker.cargo || "",
  });
  if (!personOnMesa(dni)) registerPerson(worker, { silent: true });
  const dentro = info.tipo === "entrada";
  return {
    ok: true,
    clase,
    kind: info.kind,
    label: info.label,
    habla: info.habla,
    note: dentro ? "Está dentro. Siguiente." : "Está fuera. Siguiente.",
    primera: previas.length === 0,
  };
}

function confirmarMarcacion(worker, mark) {
  const nombre = prepareSpeakName(worker) || twoApellidos(worker) || "";
  showScanHit({
    dni: worker.dni,
    sexo: personSexo(worker),
    nombre,
    cargo: [nameParts(worker).nombre, worker.cargo].filter(Boolean).join(" · "),
    ok: true,
    kind: mark.kind,
    stateLabel: mark.label,
    note: mark.note,
  });
  showScanToast(`${mark.label}. ${nombre}`.trim(), CONFIRMA_MS);
  state.confirmUntil = Date.now() + CONFIRMA_MS;
  try { navigator.vibrate?.(mark.clase === "salida" || mark.clase === "almuerzo" ? [40, 30, 40] : 50); } catch { /* sin vibración */ }
  const frase = mark.clase === "salida" ? "Salida" : [mark.habla, nombre].filter(Boolean).join(". ");
  const dni = normalizeDni(worker.dni || worker.id);
  state.speechLockDni = dni;
  state.speechLockUntil = Date.now() + 8000;
  speak(frase, {
    onDone: () => {
      if (state.speechLockDni === dni) state.speechLockUntil = Date.now() + 700;
    },
  });
  const token = (state.hitToken || 0) + 1;
  state.hitToken = token;
  window.setTimeout(() => {
    if (state.hitToken !== token) return;
    const host = document.getElementById("scan-hit");
    if (host) host.hidden = true;
    if (state.view === "home") setScanLive("Siguiente.");
  }, CONFIRMA_MS);
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
      stateLabel: "Ya registrado",
      note: "Ya registrado. Siguiente.",
    });
    showScanToast("Ya registrado.", 1200);
    speak("Ya registrado.");
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
  if (state.scanMode === "wrk" && dni && marcaDemasiadoPronto(dni)) {
    if (Date.now() > (state.confirmUntil || 0)) warnRepeatedPerson(dni);
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

function avatarHtml(_person, size = "") {
  const cls = `avatar${size ? ` ${size}` : ""}`;
  return `<span class="${cls}" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3.2"/><path d="M5.5 19.2a6.5 6.5 0 0 1 13 0"/></svg></span>`;
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
  const t = nowParts(TZ);
  const row = {
    ...person,
    id,
    dni: person.dni || id,
    menus: menuQty(prev),
    fecha: prev?.fecha || person.fecha || t.fecha,
    hora: prev?.hora || person.hora || t.hora,
    escaneadoAt: prev?.escaneadoAt || person.escaneadoAt || t.ms,
  };
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

function scanHelp() {
  return `<aside class="scan-help">
    <p class="scan-help-title">Cómo entrar</p>
    <ol>
      <li>Verde: solo jefes autorizados. Escanee su QR o escriba el DNI.</li>
      <li>Rojo: cualquier persona, por emergencia. También puede escribir el DNI.</li>
      <li>Si entra en rojo, usted registra el tareo. Tenga cuidado.</li>
    </ol>
  </aside>`;
}

function showEmergencyWarn() {
  openAlert(`<div class="modal-back" data-act="dismiss-alert">
    <div class="modal summary-modal" role="dialog" aria-modal="true" data-act="stay">
      ${sectionHead("Cualquier persona", "El botón rojo deja entrar a cualquiera. Usted será responsable del tareo. Escanea tu QR o escribe el DNI. Después podrá elegir fundo y lugar.")}
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
      ${sectionHead("Cualquiera", "No está en la lista de jefes. Escriba su nombre completo. Este tareo sale como jornada normal.")}
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
    ? "Escriba los 8 dígitos. Si no está en la lista de jefes, pediremos el nombre. Este tareo sale como jornada normal."
    : "Escriba los 8 dígitos. Solo entra quien está en la lista de supervisores.";
  openAlert(`<div class="modal-back" data-act="dismiss-alert">
    <div class="modal summary-modal" role="dialog" aria-modal="true" data-act="stay">
      ${sectionHead(title, sub)}
      ${cualquiera ? `<p class="extra-note">Cualquier persona. Tenga cuidado: usted registra el tareo.</p>` : ""}
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
    ${appBar({ title: "Iniciar sesión", sub: emerg ? "Rojo · cualquier persona" : "Verde · solo jefes", back: "back-welcome" })}
    <div class="scan-fit">
      <section class="section-card scan-panel${emerg ? " is-emerg" : ""}">
        <div class="scan-head">
          ${sectionHead("Acceso del jefe", "Escanea tu QR o escribe el DNI.")}
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
  return `<div class="mesa-find-row">
    <label class="mesa-find">
      <input id="mesa-q" class="dni-search" type="search" inputmode="numeric" maxlength="8" enterkeyhint="search" autocomplete="off" placeholder="Buscar DNI" value="${esc(q)}" aria-label="Buscar por DNI">
    </label>
    <button class="lunch-btn lunch-mass" data-act="mass-open" type="button" aria-label="Almuerzo de todos">${forkIcon()}</button>
  </div>`;
}

function menuQty(person) {
  return Number(person?.menus) === 2 ? 2 : 1;
}

function mesaMealCount(mesa) {
  return mesa.reduce((sum, person) => sum + menuQty(person), 0);
}

function nombreFila(person) {
  const ape = String(person?.apellido || "").trim();
  const nom = String(person?.nombre || "").trim();
  return [ape, nom].filter(Boolean).join(" ") || person?.dni || person?.id || "";
}

function dniActivosHoy() {
  const keep = new Set();
  const day = todayKey(TZ);
  const sid = normalizeDni(supervisor()?.dni || supervisor()?.id || "");
  for (const person of getMesa()) {
    const id = normalizeDni(person.id || person.dni);
    if (id) keep.add(id);
  }
  for (const row of store.getCola().concat(store.getHistorial())) {
    if (!row || (row.type !== "lista" && row.type !== "extra")) continue;
    if (row.confirmed === false) continue;
    const payload = row.payload || {};
    if (payload.fecha_local !== day) continue;
    const rowSid = normalizeDni(payload.supervisor_id || "");
    if (sid && rowSid && rowSid !== sid) continue;
    for (const person of payload.personas || []) {
      const id = normalizeDni(person?.dni || person?.id);
      if (id) keep.add(id);
    }
  }
  return keep;
}

function limpiarMarcasSueltas() {
  const day = todayKey(TZ);
  const keep = dniActivosHoy();
  const all = store.getJornada();
  const next = all.filter((m) => m.fecha !== day || keep.has(normalizeDni(m.dni)));
  if (next.length !== all.length) store.setJornada(next);
}

function genteHoy() {
  limpiarMarcasSueltas();
  const map = new Map();
  const day = todayKey(TZ);
  for (const person of getMesa()) {
    const id = normalizeDni(person.id || person.dni);
    if (!id) continue;
    const prev = map.get(id);
    map.set(id, {
      ...prev,
      ...person,
      id,
      dni: id,
      fecha: person.fecha || prev?.fecha || day,
      hora: horaMinutos(person.hora) || prev?.hora || "",
      escaneadoAt: person.escaneadoAt || prev?.escaneadoAt || 0,
      enMesa: true,
    });
  }
  return [...map.values()].sort((a, b) => (b.escaneadoAt || 0) - (a.escaneadoAt || 0));
}

function mesaRows(mesa) {
  const shown = mesaForList(genteHoy());
  if (!genteHoy().length) {
    return `<div class="empty-mesa"><p>Aún nadie ha venido hoy.</p></div>`;
  }
  if (!shown.length) {
    return `<div class="empty-mesa"><p>Ningún DNI coincide.</p></div>`;
  }
  const { rows } = pageSlice(shown);
  return rows.map((p) => {
    const cargo = String(p.cargo || p.area || "").trim();
    return `<div class="person-row">
      <div class="person-top">
        <div>
          <b class="person-full">${esc(nombreFila(p))}</b>
          <div class="meta">DNI ${esc(p.id)}${cargo ? ` · ${esc(cargo)}` : ""}${p.temporal ? " · Temporal" : ""}</div>
          <div class="meta">Fecha ${esc(histFecha(p.fecha))}</div>
        </div>
        ${p.enMesa ? `<button class="row-del" data-act="ask-drop-mesa" data-id="${esc(p.id)}" data-name="${esc(displayName(p))}" type="button" aria-label="Quitar ${esc(displayName(p) || p.id)}"><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M6.2 5.1 5.1 6.2 10.9 12l-5.8 5.8 1.1 1.1L12 13.1l5.8 5.8 1.1-1.1L13.1 12l5.8-5.8-1.1-1.1L12 10.9 6.2 5.1z"/></svg></button>` : ""}
      </div>
      ${jornadaHtml(p.dni || p.id)}
    </div>`;
  }).join("");
}

function mesaCountCopy(n) {
  if (!n) return { note: "Aún nadie ha venido hoy", unit: "personas" };
  return { note: "Vinieron hoy", unit: n === 1 ? "persona" : "personas" };
}

function mesaCountCard(n) {
  const copy = mesaCountCopy(n);
  return `<section class="section-card count-card">
    ${sectionHead("Personal", copy.note, "mesa-note")}
    <div class="count-live" aria-live="polite">
      <b id="mesa-num">${n}</b>
      <span id="mesa-unit">${esc(copy.unit)}</span>
    </div>
  </section>`;
}

function refreshMesaUi() {
  const mesa = getMesa();
  const gente = genteHoy();
  const slice = pageSlice(mesaForList(gente));
  const list = document.getElementById("mesa-list");
  const count = document.getElementById("mesa-note");
  const num = document.getElementById("mesa-num");
  const unit = document.getElementById("mesa-unit");
  const pager = document.getElementById("mesa-pager");
  const copy = mesaCountCopy(gente.length);
  if (list) list.innerHTML = mesaRows(mesa);
  if (count) count.textContent = copy.note;
  if (num) num.textContent = String(gente.length);
  if (unit) unit.textContent = copy.unit;
  if (pager) pager.innerHTML = pagerHtml(slice.page, slice.pages);
  paintTareoHoy();
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
  speak("Jornada normal. Escanee a cada persona.", { flush: true });
  setScanLive("Jornada normal. Acerca el QR.", true);
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
      <p class="login-kicker">CIMPROMIN</p>
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

function hideScanHit() {
  const host = document.getElementById("scan-hit");
  if (!host) return;
  host.hidden = true;
  host.innerHTML = "";
  host.className = "hit-card";
}

function releaseQueueScreen(summary) {
  const n = (summary?.sent || 0) + (summary?.duplicates || 0);
  if (!n || (summary?.pending || 0) !== 0) return;
  releaseMesaAfterSend(store.getHistorial().slice(0, n));
  if (state.view === "home") refreshHomeLock();
}

function releaseMesaAfterSend(records) {
  const sent = new Set();
  for (const record of records || []) {
    for (const person of record?.payload?.personas || []) {
      const id = normalizeDni(person?.dni || person?.id);
      if (id) sent.add(id);
    }
  }
  if (!sent.size) return;
  // Enviar no borra la lista: cada trabajador conserva su estado en pantalla.
  for (const id of sent) unlockWorkerScan(id);
  const mesa = getMesa().map((person) => {
    const id = normalizeDni(person.id || person.dni);
    if (!id || !sent.has(id)) return person;
    return { ...person, status: "enviado" };
  });
  setMesa(mesa);
  hideScanHit();
  hideScanToast();
  setScanLive("Tareo enviado. La lista sigue en pantalla.", true);
  if (state.view === "home") refreshMesaUi();
}

function showScanHit({ dni = "—", nombre = "—", cargo = "—", ok = true, note = "", stateLabel = "", sexo = "", kind = "" }) {
  const host = document.getElementById("scan-hit");
  if (host) {
    host.hidden = false;
    host.className = `hit-card ${ok ? "ok" : "bad"}${kind ? ` ${kind}` : ""}`;
    const face = avatarHtml({ dni, sexo }, "lg");
    host.innerHTML = `
      <div class="hit-top">
        <span class="hit-label">Identificación</span>
        <span class="hit-state">${esc(stateLabel || (ok ? "Identificado" : "No encontrado"))}</span>
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

function tareoFecha() {
  const iso = todayKey(TZ);
  const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

function dashBoard() {
  const n = getMesa().length;
  return `<section class="dash-grid" aria-label="Tareo de hoy">
    <article class="dash-card wide">
      <span>Tareo de hoy</span>
      <b>${n}</b>
      <em>${n === 1 ? "trabajador en lista" : "trabajadores en lista"}</em>
    </article>
  </section>`;
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
  const gente = genteHoy();
  const slice = pageSlice(mesaForList(gente));
  render(`<div class="shell${isSendLocked() ? " is-locked" : ""}">
    ${appBar({ title: "Tareo", sub: `${tareoFecha()} · ${twoApellidos(s) || "jefe"}${s?.emergencia ? " · Emergencia" : ""}` })}
    <div class="scroll">
      <p class="tareo-lead">Registra la jornada de tu personal</p>
      ${dashBoard()}
      <section class="section-card">
        <div class="scan-head">
          ${sectionHead("Identificar", isSendLocked() ? "Bloqueado. Pulse Extra si alguien se olvidó o llegó tarde." : "Escanea el código del trabajador o ingresa el DNI.")}
          <button class="user-add" data-act="add-temp-person" type="button" aria-label="Ingresar DNI">${userIcon()}</button>
        </div>
        ${scanBox()}
        <p class="scan-live" id="scan-live">${isSendLocked() ? "Ya envió. Pulse Extra si alguien se olvidó o llegó tarde." : "Coloca el código dentro del marco."}</p>
        ${scanHitBox()}
      </section>
      ${mesaCountCard(gente.length)}
      ${mesaFindBox()}
      <div class="mesa" id="mesa-list">${mesaRows(mesa)}</div>
      <div id="mesa-pager">${pagerHtml(slice.page, slice.pages)}</div>
    </div>
    ${soloFooter("go-summary", "Enviar tareo", !mesa.length || isSendLocked())}
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
}

function dayView() {
  show("home");
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
    ${appBar({ title: "Cierre del turno", sub: "Resumen del turno", back: "home", progress: 90 })}
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
        : "Sin señal. Los registros están guardados en este celular."}</p>
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
        <button class="card" data-act="clear-cache" type="button"><h3>Limpiar app</h3><p>No borra registros guardados.</p></button>
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
    if (state.scanMode === "wrk" && dniBusy && marcaDemasiadoPronto(dniBusy)) {
      return;
    }
    if (key && key !== state.lastDetectedQR) notifyScanWait();
    return;
  }

  if (state.scanMode === "wrk" && key) {
    const dniKey = normalizeDni(key);
    if (dniKey && marcaDemasiadoPronto(dniKey)) {
      scanner.forget(dniKey);
      if (Date.now() > (state.confirmUntil || 0)) warnRepeatedPerson(dniKey);
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
      const confirming = Date.now() < (state.confirmUntil || 0);
      if (!keepRepeat && !confirming) {
        hideScanToast();
        if (state.view === "home" || state.view === "supervisor") {
          if (!(state.scanMode === "wrk" && isSendLocked())) {
            setScanLive("Siguiente.");
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

  const id = normalizeDni(worker.dni || worker.id || dni);
  asegurarEntradaPrevia(worker);
  if (marcaDemasiadoPronto(id)) return true;
  const next = siguienteClase(marcasDe(id));
  if (next === "cerrado" || yaMarcoSalidaHoy(id)) {
    avisoSalidaCerrada(worker);
    return true;
  }
  if (next === "salida" && !tieneAlmuerzo(id)) {
    showRetiroModal(worker);
    return true;
  }
  const mark = registrarMarcacion(worker);
  if (opId !== state.scanOpId) return false;
  if (!mark.ok) {
    if (mark.cerrado) avisoSalidaCerrada(worker);
    else if (mark.choque) avisoChoqueAlmuerzo(worker, mark.choque);
    else if (mark.otra) speak("Escanee a la persona indicada.");
    return true;
  }
  try { confirmarMarcacion(worker, mark); } catch { /* tarjeta de UI opcional */ }
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
    try { new Notification("Tareo", opts); } catch { /* sin permiso */ }
  };
  const ready = navigator.serviceWorker?.ready;
  if (!ready) { fallback(); return; }
  ready.then((reg) => {
    if (reg?.showNotification) reg.showNotification("Tareo", opts).catch(fallback);
    else fallback();
  }).catch(fallback);
}

function postDni(raw) {
  const d = normalizeDni(raw);
  if (/^\d{8}$/.test(d)) return d;
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (digits.length >= 6 && digits.length < 8) return digits.padStart(8, "0");
  return d;
}

function uniqueMesaPeople(list) {
  const map = new Map();
  for (const person of list || []) {
    const id = postDni(person?.id || person?.dni);
    if (!/^\d{8}$/.test(id)) continue;
    const prev = map.get(id);
    map.set(id, { ...(prev || {}), ...person, id, dni: id, menus: Math.max(menuQty(prev), menuQty(person)) });
  }
  return [...map.values()];
}

function marcasDeEnvio(people) {
  const day = todayKey(TZ);
  const want = new Set((people || []).map((p) => postDni(p.id || p.dni)));
  return store.getJornada()
    .filter((mark) => mark?.fecha === day && want.has(normalizeDni(mark.dni)))
    .sort((a, b) => (a.at || 0) - (b.at || 0))
    .map((mark) => ({
      dni: normalizeDni(mark.dni),
      apellido: mark.apellido || "",
      nombre: mark.nombre || "",
      hora: horaMinutos(mark.hora),
      tipo: mark.tipo || "",
      clase: mark.clase || "",
    }));
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
    showAlert("Todavía no", "Primero envíe la jornada normal. Extra solo después de ese envío.");
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
  const busy = !!(existing && isClientInflight(existing.clientId));
  const sendId = extra || busy ? uuid() : (existing?.payload?.send_id || existing?.payload?.lote_lista_id || uuid());
  const n = mesaMealCount(people);
  const record = {
    clientId: extra ? `extra:${t.fecha}:${sendId}` : (busy ? `lista:${t.fecha}:${sendId}` : (existing?.clientId || `lista:${t.fecha}:${sendId}`)),
    rev: Date.now(),
    type: extra ? "extra" : "lista",
    payload: {
      fecha_local: t.fecha,
      hora_local: t.hora,
      timezone: TZ,
      supervisor_id: postDni(s.dni || s.id),
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
      personas: people.map((p) => {
        const dni = postDni(p.id || p.dni);
        return {
          id: dni,
          dni,
          apellido: p.apellido || "",
          nombre: p.nombre || "",
          area: p.cargo || p.area || "",
          menus: menuQty(p),
        };
      }),
      marcas: marcasDeEnvio(people),
    },
    createdAt: extra ? Date.now() : (existing?.createdAt || Date.now()),
  };
  store.upsertCola(record);
  marcarAlmuerzoEnviado(people);
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
  speak(extra
    ? (online ? `Tareo extra. ${n} ${n === 1 ? "persona" : "personas"}.` : `Sin señal. Tareo extra guardado.`)
    : (online ? `Tareo enviado. ${n} ${n === 1 ? "persona" : "personas"}.` : `Sin señal. Tareo guardado.`), { flush: true });
  saveAndSync(record).then(async (result) => {
    if (online && result.status !== "enviado") {
      speak("Quedó guardado. Se envía al tener señal.", { flush: true });
    }
    const delivered = result.status === "enviado" && pendingCount() === 0;
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
          if (delivered) releaseMesaAfterSend([result.record || record]);
          if (state.view === "home") refreshHomeLock();
          speak("Ya se envió desde otro celular");
          showAlert(
            "Ya envió",
            "Este jefe ya mandó el tareo de hoy desde otro celular. Si falta alguien, pulse Extra."
          );
          return;
        }
        store.clearTurnoDia();
        state.extraOn = false;
        if (state.view === "home") refreshHomeLock();
        speak("No se guardó. Intente Enviar de nuevo como jornada.");
        showAlert(
          "Reintente el tareo",
          "El servidor no guardó esta lista. Pulse Enviar otra vez (jornada normal). No use Extra todavía."
        );
        return;
      }
      if (delivered) releaseMesaAfterSend([result.record || record]);
      speak("Ya se envió desde otro celular");
      showAlert(
        "Ya envió",
        "Este jefe ya mandó el tareo de hoy desde otro celular. Si falta alguien, pulse Extra."
      );
      return;
    }
    if (delivered) releaseMesaAfterSend([result.record || record]);
    else if (result.status === "enviado") {
      setMesa(getMesa().map((p) => ({ ...p, status: "enviado" })));
      if (state.view === "home") refreshMesaUi();
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
      supervisor_id: postDni(s.dni || s.id),
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
  const once = ["send-lista", "reload-app", "clear-cache", "logout", "drop-mesa", "save-temp-person", "save-emergency-name", "add-emergency-sup", "confirm-emergency", "enter", "open-dni-login", "submit-dni-login", "lunch-save", "mass-save"];
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
  if (act === "lunch-open") {
    if (almuerzoEnviado(btn.dataset.id)) {
      showAlert("Ya enviado", "Esta hora ya se envió. Para cambiarla use el panel.");
      return;
    }
    state.lunchClase = "";
    showLunchModal(btn.dataset.id);
    return;
  }
  if (act === "mass-open") {
    state.lunchClase = "almuerzo";
    showMassLunchModal();
    return;
  }
  if (act === "mass-pick") {
    state.lunchClase = btn.dataset.clase === "retorno" ? "retorno" : "almuerzo";
    document.querySelectorAll("[data-act='mass-pick']").forEach((el) => {
      el.classList.toggle("lunch-on", el.dataset.clase === state.lunchClase);
    });
    avisoAlmuerzo("");
    ponerReloj(state.lunchClase === "retorno" ? state.massFin : state.massIni);
    return;
  }
  if (act === "mass-save") {
    if (!tomarHoraMasiva()) return;
    const { hechos, omitidos } = guardarAlmuerzoMasivo();
    cerrarLunchModal();
    const resto = omitidos ? ` ${omitidos} sin cambio por su hora de entrada o salida.` : "";
    setScanLive(`Listo. ${hechos} ${hechos === 1 ? "persona" : "personas"}.${resto}`, true);
    speak(`Listo. ${hechos} ${hechos === 1 ? "persona" : "personas"}.`, { flush: true });
    return;
  }
  if (act === "lunch-step") {
    stepReloj(btn.dataset.part, btn.dataset.dir);
    return;
  }
  if (act === "lunch-now") {
    const t = nowParts(TZ);
    ponerReloj(t.hora);
    return;
  }
  if (act === "lunch-apply") {
    if (state.lunchMasivo) tomarHoraMasiva();
    else aplicarHoraAlmuerzo();
    return;
  }
  if (act === "lunch-save") {
    if (!aplicarHoraAlmuerzo()) return;
    cerrarLunchModal();
    return;
  }
  if (act === "lunch-cancel") {
    cerrarLunchModal();
    return;
  }
  if (act === "lunch-pick") {
    state.lunchClase = btn.dataset.clase === "retorno" ? "retorno" : "almuerzo";
    state.lunchDni = btn.dataset.id || state.lunchDni;
    pintarOpcion();
    state.lunchHablado = "";
    hablarTareo(fraseMarcacion(state.lunchClase));
    const mark = marcaAlmuerzo(state.lunchDni, state.lunchClase);
    ponerReloj(mark?.hora || (state.lunchClase === "retorno" ? "13:00" : "12:00"));
    return;
  }
  if (act === "retiro-si") {
    const id = normalizeDni(btn.dataset.id || state.retiroDni);
    const stamp = state.retiroStamp;
    state.retiroDni = "";
    state.retiroStamp = null;
    dismissAlert();
    const worker = findWorkerByDni(id) || personFromSaved(id);
    if (worker) {
      // Sin almuerzo: registra 00:00 / 00:00 y pinta el tenedor verde.
      marcarSinAlmuerzo(id);
      const mark = registrarMarcacion(worker, stamp);
      if (mark.ok) confirmarMarcacion(worker, mark);
      else if (mark.choque) avisoChoqueAlmuerzo(worker, mark.choque);
    }
    if (state.view === "home") refreshMesaUi();
    if (state.view === "supervisor" || state.view === "home") resumeCam();
    return;
  }
  if (act === "retiro-no") {
    cerrarAvisoRetiro();
    return;
  }
  if (act === "dismiss-alert") {
    if (state.retiroDni) {
      cerrarAvisoRetiro();
      return;
    }
    if (state.lunchDni || state.lunchMasivo) {
      cerrarLunchModal();
      return;
    }
    dismissAlert();
    if (state.view === "supervisor" || state.view === "home") resumeCam();
    return;
  }
  if (act === "flush-pend") {
    askUploadPermission();
    const beforeIds = store.getCola().map((r) => r.clientId);
    const n = pendingCount();
    flushNow().then((s) => {
      refreshPendPill();
      if (n > 0 && pendingCount() === 0 && ((s?.sent || 0) + (s?.duplicates || 0)) > 0) {
        const done = store.getHistorial().filter((r) => beforeIds.includes(r.clientId));
        releaseMesaAfterSend(done);
        if (state.view === "home") refreshHomeLock();
      }
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
    if (!menu) return;
    const open = menu.hidden;
    menu.hidden = !open;
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    return;
  }
  if (act === "go-historial") {
    state.histPage = 1;
    state.histOpen = "";
    state.histPeoplePage = 1;
    state.histPeopleQuery = "";
    state.histFecha = "";
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
  if (act === "hist-fechas-recientes") {
    state.histFecha = "";
    state.histOpen = "";
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
      const mark = registrarMarcacion(worker);
      if (mark.ok && mark.primera) added += 1;
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
    const mark = registrarMarcacion(worker);
    refreshMesaUi();
    showDniModal();
    if (mark.cerrado) {
      avisoSalidaCerrada(worker);
      return;
    }
    setScanLive(mark.ok ? `${mark.label}. ${twoApellidos(worker)}` : "Espere para la siguiente marcación.", true);
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
  if (act === "add-temp-person") {
    if (isSendLocked()) { warnLocked(); return; }
    showTempPersonModal();
    return;
  }
  if (act === "save-temp-person") {
    const dni = normalizeDni(document.getElementById("tempDni")?.value || "");
    const typed = String(document.getElementById("tempNombre")?.value || "").replace(/\s+/g, " ").trim();
    const official = /^\d{8}$/.test(dni) ? findOfficial(dni) : null;
    const nombre = official ? (displayName(official) || typed) : typed;
    const dniOk = /^\d{8}$/.test(dni);
    document.getElementById("fTempDni")?.classList.toggle("bad", !dniOk);
    document.getElementById("fTempNom")?.classList.toggle("bad", dniOk && !official && !typed);
    if (!dniOk || !nombre) {
      speak(!dniOk ? "Falta el DNI." : "Falta el nombre.");
      return;
    }
    const parsed = nameParts({ nombreCompleto: nombre });
    const sexo = personSexo(official);
    const worker = official
      ? { ...official, ...(sexo ? { sexo } : {}) }
      : {
        dni,
        id: dni,
        apellido: parsed.apellido,
        nombre: parsed.nombre,
        nombreCompleto: parsed.nombreCompleto,
        cargo: "Temporal",
        temporal: true,
      };
    const mark = registrarMarcacion(worker);
    dismissAlert();
    refreshMesaUi();
    if (mark.cerrado) {
      avisoSalidaCerrada(worker);
      return;
    }
    setScanLive(mark.ok ? `${mark.label}. ${mark.note}` : "Espere para la siguiente marcación.", !!mark.ok);
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
    sendLista();
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
    }
    return;
  }
  if (act === "set-comedor") {
    const name = btn.dataset.id;
    if (!comedores().includes(name)) return;
    store.setPrefs({ comedor: name });
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
    registrarMarcacion(oficial);
    show("home");
    return;
  }
  if (act === "pick-w") {
    const w = findOfficial(btn.dataset.id);
    if (!w) {
      showAlert("No está en la lista", "Solo los jefes autorizados pueden registrar el tareo.");
      return;
    }
    registrarMarcacion(w);
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
    if (!e.target.closest(".fab-wrap")) closeFab();
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
    const beforeIds = store.getCola().map((r) => r.clientId);
    const n = pendingCount();
    flushQueue().then((s) => {
      if (s?.duplicates) speak("Hoy ya envió. Solo extra.");
      else if (s?.sent) speak("Enviado");
      refreshPendPill();
      if (n > 0 && pendingCount() === 0 && ((s?.sent || 0) + (s?.duplicates || 0)) > 0) {
        releaseMesaAfterSend(store.getHistorial().filter((r) => beforeIds.includes(r.clientId)));
      }
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
        flushQueue().then((summary) => {
          refreshPendPill();
          releaseQueueScreen(summary);
        });
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
      flushQueue().then((summary) => {
        refreshPendPill();
        releaseQueueScreen(summary);
      });
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
    if (state.view === "welcome" && !wasUpdating) speak("Bienvenido a CIMPROMIN");
  }
  startAutoSync((summary) => {
    refreshPendPill();
    releaseQueueScreen(summary);
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
