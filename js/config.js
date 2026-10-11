export const APP_VERSION = "1.3.83";
export const CACHE_NAME = "cocina-qb-v243";
export const APP_ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./sw.js",
  "./css/app.css",
  "./js/app.js",
  "./js/config.js",
  "./js/device.js",
  "./js/store.js",
  "./js/voice.js",
  "./js/calc.js",
  "./js/sync.js",
  "./js/scanner.js",
  "./js/vendor/jsqr.js",
  "./data/config.json",
  "./data/supervisors.json",
  "./data/trabajadores.json",
  "./assets/logo-qberries.png",
  "./assets/hombre.png",
  "./assets/mujer.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
];
export const TZ = "America/Lima";
export const HISTORY_TTL_MS = 48 * 60 * 60 * 1000;

export const STORAGE_KEYS = {
  cola: "cola_pendiente",
  historial: "historial_enviados",
  borradores: "borradores_por_formulario",
  prefs: "preferencias",
  sesion: "sesion_supervisor",
  catalogoTrab: "catalogo_local_trabajadores",
  catalogoSup: "catalogo_local_supervisores",
  recientes: "recientes_personas",
  dniGuardados: "dni_guardados",
  mesa: "mesa_hoy",
  turnoDia: "turno_dia_enviado",
  scriptUrl: "apps_script_url",
};

export const FORM_TYPES = {
  pedido: { id: "pedido", title: "Pedido de comida", sheet: "Pedidos" },
  especial: { id: "especial", title: "Pedido especial / dieta", sheet: "PedidosEspeciales" },
  lista: { id: "lista", title: "Lista de trabajadores", sheet: "ListaTrabajadores" },
  cierre: { id: "cierre", title: "Cierre de cocina", sheet: "CierreCocina" },
};

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function nowParts(timeZone = TZ) {
  const d = new Date();
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return {
    fecha: `${parts.year}-${parts.month}-${parts.day}`,
    hora: `${parts.hour}:${parts.minute}:${parts.second}.${ms}`,
    iso: d.toISOString(),
    ms: d.getTime(),
    timeZone,
  };
}

export function todayKey(timeZone = TZ) {
  return nowParts(timeZone).fecha;
}

export function normalizeDni(raw) {
  const text = String(raw || "").trim();
  const eight = text.match(/\d{8}/);
  if (eight) return eight[0];
  return text.replace(/\D/g, "");
}

export function isSesionDni(raw) {
  return /^\d{8}$/.test(normalizeDni(raw));
}

export function encodeQr(kind, person) {
  return normalizeDni(person.dni || person.id);
}

export function parseQr(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  const dni = normalizeDni(text);
  if (/^\d{8,12}$/.test(dni)) {
    return { kind: "dni", id: dni, dni, apellido: "", nombre: "", area: "" };
  }
  if (text.startsWith("{")) {
    try {
      const j = JSON.parse(text);
      const id = normalizeDni(j.dni || j.id || "") || String(j.id || "");
      const kind = String(j.t || j.kind || "").toLowerCase();
      return {
        kind: kind === "sup" || kind === "supervisor" ? "sup" : "dni",
        id,
        dni: normalizeDni(j.dni || id),
        apellido: String(j.ln || j.apellido || "").toUpperCase(),
        nombre: String(j.fn || j.nombre || ""),
        area: String(j.area || ""),
      };
    } catch {
      return null;
    }
  }
  const p = text.split("|").map((s) => s.trim());
  if (p[0] === "QB1" && (p[1] === "SUP" || p[1] === "WRK")) {
    return {
      kind: p[1] === "SUP" ? "sup" : "wrk",
      id: normalizeDni(p[2]) || p[2] || "",
      dni: normalizeDni(p[2]),
      apellido: (p[3] || "").toUpperCase(),
      nombre: p[4] || "",
      area: p[5] || "",
    };
  }
  return null;
}
