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

var APP_VERSION = "1.5.6";
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
  // Panel oficina: { accion: crear|editar|eliminar, fecha, dni, ... }
  if (body && body.accion) return officeSave(body);
  // App celular: { clientId, type, payload:{ personas, marcas } }
  if (!body || !body.payload) return jsonOut({ ok: false, error: "peticion_desconocida" });
  return workerSave(body);
}

function officeSave(body) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return jsonOut({ ok: false, error: "lock_timeout" });
  try {
    var accion = String(body.accion || "").toLowerCase();
    var fecha = fechaTrabajo(body.fecha);
    var dni = onlyDni(body.dni);
    if (!/^\d{8}$/.test(dni)) return jsonOut({ ok: false, error: "dni_invalido" });
    if (accion === "eliminar") {
      removePersonDay(fecha, dni);
      return jsonOut({ ok: true, tareo: dayRows(fecha) });
    }
    if (accion !== "crear" && accion !== "editar") {
      return jsonOut({ ok: false, error: "accion_desconocida" });
    }
    var dniNuevo = onlyDni(body.dni_nuevo || "");
    if (accion === "editar" && /^\d{8}$/.test(dniNuevo) && dniNuevo !== dni) {
      removePersonDay(fecha, dni);
      dni = dniNuevo;
    }
    upsertOfficeRow(fecha, dni, body);
    return jsonOut({ ok: true, tareo: dayRows(fecha) });
  } catch (err) {
    return jsonOut({ ok: false, error: String(err && err.message ? err.message : err) });
  } finally {
    lock.releaseLock();
  }
}

function officeLine(fecha, dni, body) {
  var nombre = String(body.trabajador || "").replace(/\s+/g, " ").trim().toUpperCase();
  var ingreso = asHora(body.ingreso);
  var salida = asHora(body.salida);
  var almIn = asHora(body.almuerzo_inicio);
  var almOut = asHora(body.almuerzo_fin);
  var efectivas = String(body.horas_efectivas || "").trim();
  var extra = String(body.horas_extra || "").trim();
  var tardanza = String(body.tardanza || "").trim();
  if (!efectivas && ingreso && salida) {
    var calc = calcJornada([
      { hora: ingreso, clase: "entrada", tipo: "entrada" },
      almIn ? { hora: almIn, clase: "almuerzo" } : null,
      almOut ? { hora: almOut, clase: "retorno" } : null,
      { hora: salida, clase: "salida" }
    ].filter(Boolean));
    efectivas = calc.efectivas;
    if (!extra) extra = calc.extra;
    if (!tardanza) tardanza = calc.tardanza;
    if (!almIn) almIn = calc.almuerzoInicio;
    if (!almOut) almOut = calc.almuerzoFin;
  }
  return [
    textCell(fecha),
    textCell(dni),
    textCell(nombre),
    textCell(ingreso),
    textCell(salida),
    textCell(almIn),
    textCell(almOut),
    efectivas,
    extra,
    tardanza
  ];
}

function upsertOfficeRow(fecha, dni, body) {
  var sh = sheet();
  var width = COLS.length;
  var row = findPersonDayRow(fecha, dni);
  var line = officeLine(fecha, dni, body);
  if (row) {
    sh.getRange(row, 1, 1, width).setValues([line]);
    return;
  }
  var start = sh.getLastRow() + 1;
  sh.getRange(start, 1, 1, 1).setNumberFormat("@");
  sh.getRange(start, 2, 1, 1).setNumberFormat("@");
  sh.getRange(start, 1, 1, width).setValues([line]);
}

function findPersonDayRow(fecha, dni) {
  var sh = sheet();
  var last = sh.getLastRow();
  if (last < 2) return 0;
  var values = sh.getRange(2, 1, last - 1, 2).getValues();
  var i;
  for (i = 0; i < values.length; i++) {
    if (normFecha(values[i][0]) === fecha && onlyDni(values[i][1]) === dni) return i + 2;
  }
  return 0;
}

function removePersonDay(fecha, dni) {
  var row = findPersonDayRow(fecha, dni);
  if (row) sheet().deleteRow(row);
}

function dayRows(fecha) {
  var sh = sheet();
  var last = sh.getLastRow();
  var out = [];
  if (last < 2) return out;
  var values = sh.getRange(2, 1, last - 1, COLS.length).getValues();
  var i;
  for (i = 0; i < values.length; i++) {
    var day = normFecha(values[i][0]);
    var id = onlyDni(values[i][1]);
    if (day !== fecha || !/^\d{8}$/.test(id)) continue;
    out.push({
      fecha: day,
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
  return out;
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
    sh.getRange(start, 1, append.length, 1).setNumberFormat("@");
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
    // Almuerzo/retorno no son ingreso ni salida (antes el retorno 00:00 pisaba la entrada).
    if (clase === "almuerzo") {
      if (alm == null || m < alm) alm = m;
      continue;
    }
    if (clase === "retorno") {
      if (fin == null) fin = m;
      continue;
    }
    if (ingreso == null && (clase === "entrada" || tipo === "entrada")) ingreso = m;
    if (clase === "salida" || tipo === "salida") salida = m;
  }
  if (ingreso == null) {
    for (i = 0; i < list.length; i++) {
      var c0 = String(list[i].clase || "");
      if (c0 === "almuerzo" || c0 === "retorno") continue;
      var m0 = mins(list[i].hora);
      if (m0 != null) { ingreso = m0; break; }
    }
  }

  var desde = ALMUERZO_DESDE;
  var hasta = ALMUERZO_HASTA;
  var pausa = 0;
  // Marcas 00:00 / 00:00 = salió sin almuerzo (no usar 12:00-13:00).
  if (alm != null && fin != null && alm === 0 && fin === 0) {
    desde = 0;
    hasta = 0;
    pausa = 0;
  } else if (alm != null && fin != null && fin >= alm) {
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
    // Fecha y DNI como texto para que el GET no corra el día por zona horaria.
    sh.getRange(1, 1, Math.max(sh.getMaxRows(), 1), 1).setNumberFormat("@");
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
  sh.getRange(1, 1, Math.max(sh.getMaxRows(), 1), 1).setNumberFormat("@");
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
    var tz = TZ;
    try {
      tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone() || TZ;
    } catch (err) { /* sigue con Lima */ }
    return Utilities.formatDate(v, tz, "yyyy-MM-dd");
  }
  var m = String(v || "").match(/(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  m = String(v || "").match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (m) {
    return m[3] + "-" + ("0" + m[2]).slice(-2) + "-" + ("0" + m[1]).slice(-2);
  }
  return "";
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
