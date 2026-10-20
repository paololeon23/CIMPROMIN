/**
 * CIMPROMIN Tareo. Una hoja. Un trabajador por día.
 * POST { clientId, type, payload:{ personas, marcas:[{ dni, hora, tipo, clase }] } }
 * GET  /exec
 * GET  /exec?path=tareo&fecha=YYYY-MM-DD
 * GET  /exec?path=tareo&dni=12345678
 *
 * Horario 08:00 a 18:00. Sin marca de almuerzo: 12:00 a 13:00.
 * El mismo envío no se escribe dos veces. Otro envío del día actualiza la fila.
 * Ejecutar setupSheets una vez después de pegar.
 */

var APP_VERSION = "1.5.2";
var TZ = "America/Lima";
var CACHE_TTL_SEC = 21600;
var INGRESO_MIN = 8 * 60;
var SALIDA_MIN = 18 * 60;
var ALMUERZO_DESDE = 12 * 60;
var ALMUERZO_HASTA = 13 * 60;
var HEAD = "#063b70";

var COLS = [
  { key: "fecha", label: "Fecha", width: 110 },
  { key: "dni", label: "DNI", width: 110 },
  { key: "trabajador", label: "Trabajador", width: 280 },
  { key: "ingreso", label: "Ingreso", width: 90 },
  { key: "salida", label: "Salida", width: 90 },
  { key: "almuerzo_inicio", label: "Hora almuerzo inicio", width: 160 },
  { key: "almuerzo_fin", label: "Hora almuerzo fin", width: 150 },
  { key: "efectivas", label: "Horas efectivas", width: 140 },
  { key: "extra", label: "Horas extra", width: 120 },
  { key: "tardanza", label: "Tardanza", width: 110 }
];

function doGet(e) {
  var q = (e && e.parameter) ? e.parameter : {};
  var path = String(q.path || "").toLowerCase();
  if (path === "turno") {
    return jsonOut({ ok: true, enviado: false, fecha: limaFecha() });
  }
  if (path === "tareo" || path === "jornada" || q.fecha || q.dni || q.desde) return listTareo(q);
  return jsonOut({
    ok: true,
    ping: true,
    version: APP_VERSION,
    app: "Tareo",
    fecha: limaFecha(),
    timezone: TZ
  });
}

function doPost(e) {
  var raw = (e && e.postData && e.postData.contents) ? String(e.postData.contents) : "";
  var body = {};
  try { body = raw ? JSON.parse(raw) : {}; } catch (err) {
    return jsonOut({ ok: false, error: "json_invalido" });
  }
  if (!body || !body.payload) return jsonOut({ ok: false, error: "peticion_desconocida" });
  return workerSave(body);
}

function workerSave(body) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return jsonOut({ ok: false, error: "lock_timeout" });
  try {
    var clientId = String(body.clientId || "").trim();
    var rev = Number(body.rev) || 0;
    var prev = clientId ? seenRev(clientId) : null;
    if (prev != null && rev && rev <= prev) {
      return jsonOut({ ok: true, saved: true, duplicate: true, tareo: true });
    }
    if (String(body.type || "").toLowerCase() === "cierre") {
      mark(clientId, rev);
      return jsonOut({ ok: true, saved: true });
    }

    var p = body.payload || {};
    var sid = onlyDni(p.supervisor_id);
    if (!/^\d{8}$/.test(sid)) return jsonOut({ ok: false, error: "sesion_invalida" });

    var people = groupPeople(p.personas, p.marcas);
    var keys = Object.keys(people);
    if (!keys.length) return jsonOut({ ok: false, error: "sin_personas" });

    var fecha = fechaTrabajo(p.fecha_local);
    var total = writePeople(fecha, people);
    mark(clientId, rev);
    return jsonOut({ ok: true, saved: true, duplicate: prev != null, tareo: true, trabajadores: total, total: total });
  } catch (err) {
    return jsonOut({ ok: false, error: String(err && err.message ? err.message : err) });
  } finally {
    lock.releaseLock();
  }
}

function groupPeople(personas, marcas) {
  var by = {};
  var i;
  personas = Array.isArray(personas) ? personas : [];
  for (i = 0; i < personas.length; i++) putPerson(by, personas[i]);
  marcas = Array.isArray(marcas) ? marcas : [];
  for (i = 0; i < marcas.length; i++) {
    var row = putPerson(by, marcas[i]);
    if (row && marcas[i].hora) row.marks.push(marcas[i]);
  }
  return by;
}

function putPerson(by, raw) {
  var dni = onlyDni(raw && (raw.dni || raw.id));
  if (!/^\d{8}$/.test(dni)) return null;
  if (!by[dni]) by[dni] = { dni: dni, apellido: "", nombre: "", marks: [] };
  if (raw.apellido) by[dni].apellido = String(raw.apellido);
  if (raw.nombre) by[dni].nombre = String(raw.nombre);
  return by[dni];
}

function writePeople(fecha, people) {
  var sh = sheet();
  var width = COLS.length;
  var last = sh.getLastRow();
  var values = last > 1 ? sh.getRange(2, 1, last - 1, width).getValues() : [];
  var at = {};
  var drop = [];
  var i;
  for (i = 0; i < values.length; i++) {
    var key = normFecha(values[i][0]) + "|" + onlyDni(values[i][1]);
    if (!/^\d{4}-\d{2}-\d{2}\|\d{8}$/.test(key)) continue;
    if (at[key]) drop.push(at[key]);
    at[key] = i + 2;
  }

  var append = [];
  var n = 0;
  for (var dni in people) {
    var line = buildRow(fecha, people[dni]);
    var row = at[fecha + "|" + dni];
    if (row) sh.getRange(row, 1, 1, width).setValues([line]);
    else append.push(line);
    n += 1;
  }
  if (append.length) {
    var start = sh.getLastRow() + 1;
    sh.getRange(start, 2, append.length, 1).setNumberFormat("@");
    sh.getRange(start, 1, append.length, width).setValues(append);
  }
  drop.sort(function (a, b) { return b - a; });
  for (i = 0; i < drop.length; i++) sh.deleteRow(drop[i]);
  return n;
}

function buildRow(fecha, person) {
  var calc = calcJornada(person.marks);
  var nombre = (String(person.apellido || "") + " " + String(person.nombre || "")).replace(/\s+/g, " ").trim().toUpperCase();
  return [
    textCell(fecha),
    textCell(person.dni),
    textCell(nombre),
    textCell(calc.ingreso),
    textCell(calc.salida),
    textCell(calc.almuerzoInicio),
    textCell(calc.almuerzoFin),
    calc.efectivas,
    calc.extra,
    calc.tardanza
  ];
}

function calcJornada(marks) {
  var list = (marks || []).slice().sort(function (a, b) {
    return (mins(a.hora) || 0) - (mins(b.hora) || 0);
  });
  var ingreso = null;
  var salida = null;
  var alm = null;
  var fin = null;
  var i;
  for (i = 0; i < list.length; i++) {
    var clase = String(list[i].clase || "");
    var tipo = String(list[i].tipo || "");
    var m = mins(list[i].hora);
    if (m == null) continue;
    if (ingreso == null && (clase === "entrada" || tipo === "entrada")) ingreso = m;
    if (clase === "salida") salida = m;
    if (clase === "almuerzo") {
      if (alm == null || m < alm) alm = m;
    }
    if (clase === "retorno" && alm != null && fin == null) fin = m;
  }
  if (ingreso == null && list.length) ingreso = mins(list[0].hora);

  var desde = ALMUERZO_DESDE;
  var hasta = ALMUERZO_HASTA;
  var pausa = 0;
  if (alm != null && fin != null && fin >= alm) {
    desde = alm;
    hasta = fin;
    pausa = fin - alm;
  } else if (ingreso != null && salida != null && salida >= ingreso) {
    var lo = Math.max(ingreso, ALMUERZO_DESDE);
    var hi = Math.min(salida, ALMUERZO_HASTA);
    pausa = hi > lo ? hi - lo : 0;
  }

  var efectivas = "";
  var extra = "";
  var tardanza = "";
  if (ingreso != null && salida != null && salida >= ingreso) {
    efectivas = dur(Math.max(0, salida - ingreso - pausa));
    var ex = 0;
    if (ingreso < INGRESO_MIN) ex += INGRESO_MIN - ingreso;
    if (salida > SALIDA_MIN) ex += salida - SALIDA_MIN;
    extra = dur(ex);
    tardanza = dur(ingreso > INGRESO_MIN ? ingreso - INGRESO_MIN : 0);
  }
  return {
    ingreso: hhmm(ingreso),
    salida: hhmm(salida),
    almuerzoInicio: hhmm(desde),
    almuerzoFin: hhmm(hasta),
    efectivas: efectivas,
    extra: extra,
    tardanza: tardanza
  };
}

function listTareo(q) {
  var hoy = limaFecha();
  var desde = String(q.desde || q.fecha || hoy).slice(0, 10);
  var hasta = String(q.hasta || q.fecha || desde).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(desde)) desde = hoy;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(hasta)) hasta = desde;
  if (desde > hasta) { var t = desde; desde = hasta; hasta = t; }
  var dni = onlyDni(q.dni || "");
  var sh = sheet();
  var last = sh.getLastRow();
  var out = [];
  if (last > 1) {
    var values = sh.getRange(2, 1, last - 1, COLS.length).getValues();
    var i;
    for (i = 0; i < values.length; i++) {
      var fecha = normFecha(values[i][0]);
      var id = onlyDni(values[i][1]);
      if (!fecha || fecha < desde || fecha > hasta) continue;
      if (/^\d{8}$/.test(dni) && id !== dni) continue;
      if (!/^\d{8}$/.test(id)) continue;
      out.push({
        fecha: fecha,
        dni: id,
        trabajador: String(values[i][2] || ""),
        ingreso: asHora(values[i][3]),
        salida: asHora(values[i][4]),
        almuerzo_inicio: asHora(values[i][5]),
        almuerzo_fin: asHora(values[i][6]),
        horas_efectivas: String(values[i][7] || ""),
        horas_extra: String(values[i][8] || ""),
        tardanza: String(values[i][9] || "")
      });
    }
  }
  return jsonOut({
    ok: true,
    path: "tareo",
    version: APP_VERSION,
    horario: { ingreso: "08:00", salida: "18:00", almuerzo: "12:00-13:00" },
    desde: desde,
    hasta: hasta,
    tareo: out
  });
}

function sheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName("Tareo");
  if (!sh) sh = ss.insertSheet("Tareo");
  if (String(sh.getRange(1, 1).getValue() || "") !== COLS[0].label) {
    var labels = [];
    var i;
    for (i = 0; i < COLS.length; i++) labels.push(COLS[i].label);
    sh.getRange(1, 1, 1, COLS.length).setValues([labels]);
    if (sh.getLastColumn() > COLS.length) sh.deleteColumns(COLS.length + 1, sh.getLastColumn() - COLS.length);
    sh.getRange(1, 2, Math.max(sh.getMaxRows(), 1), 1).setNumberFormat("@");
  }
  return sh;
}

function setupSheets() {
  var sh = sheet();
  var width = COLS.length;
  var head = sh.getRange(1, 1, 1, width);
  var labels = [];
  var i;
  for (i = 0; i < COLS.length; i++) labels.push(COLS[i].label);
  head.setValues([labels]);
  head.setBackground(HEAD);
  head.setFontColor("#ffffff");
  head.setFontWeight("bold");
  head.setFontSize(11);
  head.setFontFamily("Arial");
  head.setHorizontalAlignment("center");
  head.setVerticalAlignment("middle");
  sh.setFrozenRows(1);
  sh.setRowHeight(1, 36);
  sh.setTabColor(HEAD);
  for (i = 0; i < COLS.length; i++) sh.setColumnWidth(i + 1, COLS[i].width);
  sh.getRange(1, 2, Math.max(sh.getMaxRows(), 1), 1).setNumberFormat("@");
  if (sh.getLastColumn() > width) sh.deleteColumns(width + 1, sh.getLastColumn() - width);
  var drop = ["Supervisores", "Trabajadores", "Comidas extras"];
  var ss = sh.getParent();
  for (i = 0; i < drop.length; i++) {
    var old = ss.getSheetByName(drop[i]);
    if (old && ss.getSheets().length > 1) ss.deleteSheet(old);
  }
}

function seenRev(id) {
  try {
    var raw = CacheService.getScriptCache().get("id:" + id);
    if (raw == null || raw === "") return null;
    var n = Number(raw);
    return isFinite(n) ? n : 0;
  } catch (e) { return null; }
}

function mark(id, rev) {
  if (!id) return;
  var n = Number(rev);
  if (!isFinite(n) || n < 1) n = new Date().getTime();
  try { CacheService.getScriptCache().put("id:" + id, String(Math.floor(n)), CACHE_TTL_SEC); } catch (e) { /* el día y el DNI igual no duplican */ }
}

function fechaTrabajo(raw) {
  var s = String(raw || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return limaFecha();
  return s;
}

function mins(raw) {
  var m = String(raw || "").match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function hhmm(total) {
  if (total == null || total < 0) return "";
  return ("0" + Math.floor(total / 60)).slice(-2) + ":" + ("0" + (total % 60)).slice(-2);
}

function dur(total) {
  if (total == null || total < 0) return "";
  return Math.floor(total / 60) + "h " + ("0" + (total % 60)).slice(-2) + "m";
}

function limaFecha() {
  return Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd");
}

function normFecha(v) {
  if (Object.prototype.toString.call(v) === "[object Date]" && !isNaN(v.getTime())) {
    return Utilities.formatDate(v, TZ, "yyyy-MM-dd");
  }
  var m = String(v || "").match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : "";
}

function asHora(v) {
  if (Object.prototype.toString.call(v) === "[object Date]" && !isNaN(v.getTime())) {
    return Utilities.formatDate(v, TZ, "HH:mm");
  }
  var m = String(v || "").match(/(\d{1,2}):(\d{2})/);
  return m ? ("0" + m[1]).slice(-2) + ":" + m[2] : "";
}

function onlyDni(raw) {
  if (typeof raw === "number" && isFinite(raw)) raw = String(Math.round(raw));
  var s = String(raw == null ? "" : raw).replace(/\D/g, "");
  if (s.length > 8) s = s.slice(0, 8);
  if (s.length >= 6 && s.length < 8) s = ("00000000" + s).slice(-8);
  return s;
}

function textCell(v) {
  var s = String(v == null ? "" : v).replace(/[\u0000-\u001f]/g, " ").replace(/^'/, "").trim();
  if (!s) return "";
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return "'" + s;
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
