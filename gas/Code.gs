/**
 * Cocina QBerries — Google Apps Script
 * Pegar en Extensiones → Apps Script. Implementar como Web App:
 *   Ejecutar como: yo   ·   Quién tiene acceso: Cualquiera
 *
 * La app de campo (Netlify) NO se toca. Sigue POSTeando { clientId, type, payload }.
 *
 * Admin (panel RH/cocina) — pegar ESTA misma URL /exec
 *   GET  /exec                      → hoy + ayer Lima  { ok, ping, reservas }
 *   GET  /exec?fecha=YYYY-MM-DD
 *   GET  /exec?desde=&hasta=
 *   GET  /exec?path=supervisores    → supervisores de hoy (hojas), no el JSON
 *   GET  /exec?path=comedores       → comedores + fundos
 *   GET  /exec?path=fundos
 *   GET  /exec?path=turno&supervisor=DNI
 *   POST { dni, apellido, nombres, supervisor, comedor, fundo } → agrega a ESA lista
 *   POST { action: "quitar", dni, date, supervisor }           → quita
 *   POST { action: "editar", supervisor, comedor, fundo, dni? } → cambia comedor/fundo
 *
 * Hojas: Trabajadores, Supervisores, Comidas extras.
 * hora_guardado = hora del celular. No se guarda client_id ni id de fila.
 * trabajador_apellido y trabajador_nombre van en celdas distintas.
 * total_comidas (hoja Supervisores) = almuerzo + extras confirmados de ese supervisor ese día.
 * Se actualiza al enviar lista, extra, alta o quitar. Canceladas no cuentan.
 * supervisor_apellido_nombre = nombre completo del supervisor (no solo apellidos).
 * La columna vieja supervisor_apellido se renombra sola.
 *
 * Lock del turno (solo hojas):
 *   1) ¿Este supervisor_id ya está hoy en Supervisores?
 *   2) ¿Este supervisor_id ya tiene gente hoy en Trabajadores?
 *   Si SÍ → no se escribe otra lista. Solo Comidas extras.
 *   Si 2 o 3 celulares mandan el mismo supervisor, el primero gana.
 *
 * Login en el celular usa supervisors.json. Emergencia: escanear carnet.
 * Code.gs NO valida catálogo. Guarda lo que llega del celular o del panel.
 *
 * Tras pegar: guardar. Misma URL. Ejecutar setupSheets una vez si las columnas cambiaron.
 */

var CACHE_TTL_SEC = 21600;
var APP_VERSION = "1.4.4";
var TZ = "America/Lima";

var FUNDOS = ["LICAPA I", "LICAPA II", "LICAPA III"];
var DROP_COLS = ["lote_lista_id", "etapa", "lote", "lotes", "id", "lote_campo", "modulo", "turno_campo"];

var COLS_TRABAJADORES = [
  "fecha_local",
  "hora_guardado",
  "supervisor_id",
  "supervisor_apellido_nombre",
  "trabajador_dni",
  "trabajador_apellido",
  "trabajador_nombre",
  "comida",
  "comedor",
  "fundo",
  "status",
  "comidas"
];

var COLS_SUPERVISORES = [
  "fecha_local",
  "hora_guardado",
  "supervisor_id",
  "supervisor_apellido_nombre",
  "comida",
  "comedor",
  "fundo",
  "total_comidas"
];

var PACK_MEMO = {};

var COMEDORES = [
  "Comedor 1", "Comedor 2", "Comedor 3", "Comedor 4", "Comedor 5",
  "Galpon", "Oficina Tecnica", "Comedor Administrativo",
  "Comedor 6", "Comedor 7", "Comedor 8", "Comedor 9", "Comedor 10",
  "Comedor Principal - II",
  "Comedor 11"
];

function doGet(e) {
  var q = (e && e.parameter) ? e.parameter : {};
  var path = String(q.path || q.ruta || "").toLowerCase();
  var action = String(q.action || q.accion || "").toLowerCase();

  if (action === "add" || action === "agregar") {
    return adminAdd({
      dni: q.dni,
      name: q.name || q.nombre,
      apellido: q.apellido || q.apellidos || q.trabajador_apellido,
      nombres: q.nombres || q.trabajador_nombre,
      supervisor: q.supervisor || q.supervisor_id,
      supervisor_id: q.supervisor_id,
      sede: q.sede || q.comedor,
      fundo: q.fundo || q.etapa
    });
  }
  if (action === "quitar" || action === "cancel" || action === "cancelar") {
    return adminQuitar({ dni: q.dni, date: q.date || q.fecha, id: q.id, supervisor: q.supervisor, supervisor_id: q.supervisor_id });
  }
  if (action === "editar" || action === "update" || action === "actualizar") {
    return adminEdit({
      dni: q.dni,
      date: q.date || q.fecha,
      supervisor: q.supervisor,
      supervisor_id: q.supervisor_id,
      sede: q.sede || q.comedor,
      fundo: q.fundo || q.etapa,
      comida: q.comida
    });
  }
  if (path === "supervisores") {
    return jsonOut({ ok: true, supervisores: listSupervisorsOnDuty() });
  }
  if (path === "comedores" || path === "opciones") {
    return jsonOut(catalogosAdmin());
  }
  if (path === "fundos" || path === "etapas") {
    return jsonOut({ ok: true, fundos: FUNDOS.slice(), etapas: FUNDOS.slice() });
  }
  if (path === "turno" || action === "turno") {
    return turnoStatus(q);
  }
  if (action === "totales" || action === "recalcular" || path === "totales") {
    return jsonOut({ ok: true, fecha: limaFecha(), totales: recalcSupervisorTotals(limaFecha()) });
  }

  var range = dateRangeFromQuery(q);
  var unDia = range.desde === range.hasta;
  return jsonOut({
    ok: true,
    ping: true,
    version: APP_VERSION,
    app: "Cocina QBerries",
    time: new Date().toISOString(),
    timezone: TZ,
    fecha: unDia ? range.desde : "",
    desde: range.desde,
    hasta: range.hasta,
    reservas: listReservas(range.desde, range.hasta)
  });
}

var PANEL_PASSWORD = "Qberrie$2026";

function panelPasswordOk(given) {
  var a = String(given == null ? "" : given);
  var b = String(PANEL_PASSWORD);
  var n = Math.max(a.length, b.length);
  var diff = a.length === b.length ? 0 : 1;
  var i;
  for (i = 0; i < n; i++) {
    var ca = i < a.length ? a.charCodeAt(i) : 0;
    var cb = i < b.length ? b.charCodeAt(i) : 0;
    diff = diff | (ca ^ cb);
  }
  return diff === 0 && a.length > 0;
}

function panelLogin(body) {
  if (panelPasswordOk(body && (body.password || body.clave))) return jsonOut({ ok: true });
  return jsonOut({ ok: false, error: "clave_invalida" });
}

function doPost(e) {
  var raw = (e && e.postData && e.postData.contents) ? String(e.postData.contents) : "";
  var body = {};
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch (err) {
    return jsonOut({ ok: false, error: "json_invalido" });
  }

  var action = String(body.action || body.accion || "").toLowerCase();
  if (action === "login") return panelLogin(body);

  if (isWorkerPayload(body)) {
    return workerSave(body);
  }

  if (action === "quitar" || action === "cancel" || action === "cancelar" || body.quitar === true) {
    return adminQuitar(body);
  }
  if (action === "editar" || action === "update" || action === "actualizar" || action === "patch" || body.editar === true) {
    return adminEdit(body);
  }
  if ((body.comedor || body.sede || body.fundo || body.etapa) && !(body.name || body.nombre || body.trabajador || body.apellido || body.nombres) && !body.payload) {
    return adminEdit(body);
  }
  if (body.dni && body.supervisor && (body.name || body.nombre || body.trabajador || body.apellido || body.apellidos || body.nombres)) {
    return adminAdd(body);
  }
  if (body.dni && (body.date || body.fecha) && !body.payload) {
    return adminQuitar(body);
  }
  return jsonOut({ ok: false, error: "peticion_desconocida" });
}

function clientIdSeen(clientId) {
  if (!clientId) return false;
  try {
    if (CacheService.getScriptCache().get("id:" + clientId)) return true;
  } catch (e) { /* ignore */ }
  try {
    if (PropertiesService.getScriptProperties().getProperty("cid." + clientId)) return true;
  } catch (e2) { /* ignore */ }
  return false;
}

function clientIdMark(clientId) {
  if (!clientId) return;
  try {
    CacheService.getScriptCache().put("id:" + clientId, "1", CACHE_TTL_SEC);
  } catch (e) { /* ignore */ }
  try {
    PropertiesService.getScriptProperties().setProperty("cid." + clientId, "1");
  } catch (e2) {
    pruneClientIdProps();
    try {
      PropertiesService.getScriptProperties().setProperty("cid." + clientId, "1");
    } catch (e3) { /* cupo lleno: la hoja sigue cubriendo listas */ }
  }
}

function pruneClientIdProps() {
  try {
    var props = PropertiesService.getScriptProperties();
    var all = props.getProperties();
    var keys = [];
    for (var k in all) {
      if (String(k).indexOf("cid.") === 0) keys.push(k);
    }
    if (keys.length < 180) return;
    keys.sort();
    var drop = keys.slice(0, keys.length - 120);
    for (var i = 0; i < drop.length; i++) props.deleteProperty(drop[i]);
  } catch (e) { /* ignore */ }
}

function isWorkerPayload(body) {
  if (!body || typeof body !== "object") return false;
  if (body.payload && typeof body.payload === "object") return true;
  if (body.clientId && (body.type === "lista" || body.type === "extra" || body.type === "cierre")) return true;
  return false;
}

function workerSave(body) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(8000)) {
    return jsonOut({ ok: false, error: "lock_timeout" });
  }
  try {
    var clientId = String(body.clientId || "").trim();
    if (clientIdSeen(clientId)) {
      return jsonOut({ ok: true, saved: true, duplicate: true });
    }

    var p = body.payload || {};
    var people = uniquePeople(Array.isArray(p.personas) ? p.personas : []);
    if (people.length > 400) people = people.slice(0, 400);
    var n = people.length ? people.length : Number(p.trabajadores_unicos) || 0;
    var horaG = cell(p.hora_local, 20);
    var fechaHoy = limaFecha();
    var fechaIn = String(p.fecha_local || "").slice(0, 10);
    var fecha = fechaIn === fechaHoy ? fechaIn : fechaHoy;
    var sid = onlyDni(p.supervisor_id || "");
    if (!/^\d{8}$/.test(sid)) {
      return jsonOut({ ok: false, error: "sesion_invalida" });
    }
    var sap = supervisorFullName(
      p.supervisor_apellido_nombre,
      p.supervisor_nombre_completo,
      p.supervisor_apellido,
      p.supervisor_nombres,
      p.supervisor_nombre
    );
    var comida = cell(p.comida, 40) || "Almuerzo";
    var comedor = canonSede(p.comedor) || cell(p.comedor, 40);
    var fundo = canonFundo(p.fundo || p.etapa);
    var loteCampo = cell(p.lote_campo, 20);
    var modulo = cell(p.modulo, 12);
    var turnoCampo = cell(p.turno_campo, 12);
    var type = String(body.type || "").toLowerCase();
    var extra = (type === "extra" || p.extra === true) && p.tipo !== "normal";
    var ss = SpreadsheetApp.getActiveSpreadsheet();

    if (type === "cierre") {
      clientIdMark(clientId);
      return jsonOut({ ok: true, saved: true, cierre: true, duplicate: false });
    }

    if (!people.length) {
      return jsonOut({ ok: false, error: "sin_personas" });
    }

    var yaEnvio = supervisorYaRegistroHoy(ss, sid, fecha);

    if (extra && !yaEnvio) {
      return jsonOut({
        ok: true,
        saved: true,
        extra: false,
        duplicate: true,
        already: false,
        error: "sin_almuerzo",
        trabajadores: 0,
        total: 0
      });
    }

    if (!extra && yaEnvio) {
      markSupervisorSent(sid, fecha, comida);
      clientIdMark(clientId);
      return jsonOut({
        ok: true,
        saved: true,
        duplicate: true,
        already: true,
        error: "ya_enviado",
        trabajadores: 0,
        total: 0
      });
    }

    if (extra) {
      var packX = ensurePersonSheet(ss, "Comidas extras");
      if (people.length) {
        writePeople(packX, people, {
          fecha: fecha,
          hora: horaG,
          sid: sid,
          sap: sap,
          comida: comida,
          comedor: comedor,
          fundo: fundo,
          lote_campo: loteCampo,
          modulo: modulo,
          turno_campo: turnoCampo,
          extra: true,
          status: "confirmed"
        });
      }
      clientIdMark(clientId);
      var totalX = refreshSupervisorTotal(ss, sid, fecha, people.length);
      bumpAdminCache();
      return jsonOut({
        ok: true,
        saved: true,
        extra: true,
        duplicate: false,
        trabajadores: people.length,
        total: totalX
      });
    }

    var packT = ensurePersonSheet(ss, "Trabajadores");
    var packS = ensureSupervisorSheet(ss);
    if (people.length) {
      writePeople(packT, people, {
        fecha: fecha,
        hora: horaG,
        sid: sid,
        sap: sap,
        comida: comida,
        comedor: comedor,
        fundo: fundo,
        lote_campo: loteCampo,
        modulo: modulo,
        turno_campo: turnoCampo,
        extra: false,
        status: "confirmed"
      });
    }
    appendSupervisor(packS, {
      fecha: fecha,
      hora: horaG,
      sid: sid,
      sap: sap,
      comida: comida,
      comedor: comedor,
      fundo: fundo,
      lote_campo: loteCampo,
      modulo: modulo,
      turno_campo: turnoCampo,
      total: n
    });
    markSupervisorSent(sid, fecha, comida);
    clientIdMark(clientId);
    var totalL = refreshSupervisorTotal(ss, sid, fecha, 0);
    bumpAdminCache();
    return jsonOut({
      ok: true,
      saved: true,
      duplicate: false,
      trabajadores: n,
      total: totalL
    });
  } catch (err) {
    return jsonOut({ ok: false, error: String(err && err.message ? err.message : err) });
  } finally {
    lock.releaseLock();
  }
}

function adminAdd(body) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(8000)) {
    return jsonOut({ ok: false, error: "lock_timeout" });
  }
  try {
    var dni = onlyDni(body.dni || body.documento);
    var apellidoIn = String(body.apellido || body.apellidos || body.trabajador_apellido || "").replace(/\s+/g, " ").trim();
    var nombresIn = String(body.nombres || body.trabajador_nombre || "").replace(/\s+/g, " ").trim();
    if (!nombresIn && apellidoIn) {
      nombresIn = String(body.nombre || "").replace(/\s+/g, " ").trim();
    }
    var name = String(body.name || body.trabajador || "").replace(/\s+/g, " ").trim();
    if (!name && !apellidoIn) name = String(body.nombre || "").replace(/\s+/g, " ").trim();
    if (!name) name = (apellidoIn + " " + nombresIn).replace(/\s+/g, " ").trim();
    var fecha = limaFecha();
    var sup = resolveDutySupervisor(body, fecha);
    if (!/^\d{8}$/.test(dni)) return jsonOut({ ok: false, error: "dni_invalido" });
    if (!name && !apellidoIn) return jsonOut({ ok: false, error: "nombre_invalido" });
    if (!sup || !/^\d{8}$/.test(sup.dni)) {
      return jsonOut({ ok: false, error: "supervisor_invalido" });
    }

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var yaEnvio = supervisorYaRegistroHoy(ss, sup.dni, fecha);
    var workerYa = findActiveSameDay(dni, fecha).length > 0;
    var extra = yaEnvio || workerYa;
    var sede = canonSede(body.sede || body.comedor || body.hall) || sup.comedor || lastSedeForSupervisor(sup.dni, fecha);
    if (!sede) sede = "Comedor 1";
    var fundo = canonFundo(body.fundo || body.etapa || body.lote || sup.fundo);
    var hora = limaHora();
    var parts = personNameParts({
      apellido: apellidoIn,
      nombres: nombresIn,
      name: name
    });
    if (!parts.apellido && !parts.nombre) return jsonOut({ ok: false, error: "nombre_invalido" });
    name = (parts.apellido + " " + parts.nombre).replace(/\s+/g, " ").trim();
    var sap = supervisorFullName(sup.name, sup.nombre, sup.apellido);
    var pack = ensurePersonSheet(ss, extra ? "Comidas extras" : "Trabajadores");
    appendReserva(pack, {
      fecha: fecha,
      hora: hora,
      sid: sup.dni,
      sap: sap,
      dni: dni,
      apellido: parts.apellido,
      nombre: parts.nombre,
      comida: "Almuerzo",
      comedor: sede,
      fundo: fundo,
      status: "confirmed"
    });
    if (!yaEnvio && !extra) {
      appendSupervisor(ensureSupervisorSheet(ss), {
        fecha: fecha,
        hora: hora,
        sid: sup.dni,
        sap: sap,
        comida: "Almuerzo",
        comedor: sede,
        fundo: fundo,
        total: 1
      });
      markSupervisorSent(sup.dni, fecha, "Almuerzo");
    }
    var totalAdd = refreshSupervisorTotal(ss, sup.dni, fecha, extra || yaEnvio ? 1 : 0);
    bumpAdminCache();
    return jsonOut({
      ok: true,
      saved: true,
      extra: extra,
      total: totalAdd,
      reserva: {
        id: dni,
        dni: dni,
        name: name,
        apellido: parts.apellido,
        nombre: parts.nombre,
        date: fecha,
        time: hora,
        supervisor: titleCase(sap) || sup.dni,
        supervisor_id: sup.dni,
        sede: sede,
        extra: extra,
        tipo: extra ? "extra" : "lista",
        status: "confirmed"
      }
    });
  } catch (err) {
    return jsonOut({ ok: false, error: String(err && err.message ? err.message : err) });
  } finally {
    lock.releaseLock();
  }
}

function adminQuitar(body) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(8000)) {
    return jsonOut({ ok: false, error: "lock_timeout" });
  }
  try {
    var dni = onlyDni(body.dni || body.documento);
    var fecha = String(body.date || body.fecha || limaFecha()).slice(0, 10);
    var id = String(body.id || body._id || "").trim();
    if (!id && !/^\d{8}$/.test(dni)) return jsonOut({ ok: false, error: "dni_invalido" });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return jsonOut({ ok: false, error: "fecha_invalida" });

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sup = resolveDutySupervisor(body, fecha);
    var sid = sup && sup.dni ? sup.dni : onlyDni(body.supervisor_id || "");
    var hits = 0;
    hits += cancelInSheet(ensurePersonSheet(ss, "Trabajadores"), dni, fecha, id, sid);
    hits += cancelInSheet(ensurePersonSheet(ss, "Comidas extras"), dni, fecha, id, sid);
    if (!/^\d{8}$/.test(sid)) sid = sidForWorkerDay(ss, dni || id, fecha);
    var totalQ = /^\d{8}$/.test(sid) ? refreshSupervisorTotal(ss, sid, fecha, -hits) : 0;
    bumpAdminCache();
    return jsonOut({ ok: true, saved: true, cancelled: hits, total: totalQ });
  } catch (err) {
    return jsonOut({ ok: false, error: String(err && err.message ? err.message : err) });
  } finally {
    lock.releaseLock();
  }
}

function catalogosAdmin() {
  return {
    ok: true,
    comedores: COMEDORES.map(function (n) { return { name: n, sede: n }; }),
    fundos: FUNDOS.slice(),
    etapas: FUNDOS.slice()
  };
}

function adminEdit(body) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(8000)) {
    return jsonOut({ ok: false, error: "lock_timeout" });
  }
  try {
    var fecha = String(body.date || body.fecha || limaFecha()).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) fecha = limaFecha();
    var dni = onlyDni(body.dni || body.documento);
    var sup = resolveDutySupervisor(body, fecha);
    var sid = (sup && sup.dni) || onlyDni(body.supervisor_id || "");
    var sedeIn = String(body.sede || body.comedor || body.hall || "").trim();
    var fundoIn = String(body.fundo || body.etapa || body.lote || "").trim();
    var comidaIn = String(body.comida || "").trim();
    var patch = {
      sede: sedeIn ? canonSede(sedeIn) : "",
      fundo: fundoIn ? canonFundo(fundoIn) : "",
      comida: comidaIn ? cell(comidaIn, 40) : ""
    };
    if (!patch.sede && !patch.fundo && !patch.comida) {
      return jsonOut({ ok: false, error: "sin_cambios" });
    }
    if (!/^\d{8}$/.test(dni) && !/^\d{8}$/.test(sid)) {
      return jsonOut({ ok: false, error: "supervisor_invalido" });
    }
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var n = 0;
    n += patchSheetRows(ensurePersonSheet(ss, "Trabajadores"), fecha, sid, dni, patch, true);
    n += patchSheetRows(ensurePersonSheet(ss, "Comidas extras"), fecha, sid, dni, patch, true);
    n += patchSheetRows(ensureSupervisorSheet(ss), fecha, sid, "", patch, false);
    bumpAdminCache();
    return jsonOut({
      ok: true,
      saved: true,
      updated: n,
      comedor: patch.sede || undefined,
      fundo: patch.fundo || undefined,
      etapa: patch.fundo || undefined,
      comida: patch.comida || undefined
    });
  } catch (err) {
    return jsonOut({ ok: false, error: String(err && err.message ? err.message : err) });
  } finally {
    lock.releaseLock();
  }
}

function patchSheetRows(pack, fecha, sid, dni, patch, peopleSheet) {
  var sh = pack.sh;
  var last = sh.getLastRow();
  if (last < 2) return 0;
  var lastCol = Math.max(sh.getLastColumn(), pack.width || 1);
  var start = Math.max(2, last - 1999);
  var values = sh.getRange(start, 1, last - start + 1, lastCol).getValues();
  var n = 0;
  var dirty = false;
  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    if (!fechaEs(val(pack, row, "fecha_local"), fecha)) continue;
    if (peopleSheet && /^\d{8}$/.test(dni) && onlyDni(val(pack, row, "trabajador_dni")) !== dni) continue;
    if (/^\d{8}$/.test(sid) && onlyDni(val(pack, row, "supervisor_id")) !== sid) continue;
    if (peopleSheet && normStatus(val(pack, row, "status")) === "cancelled") continue;
    if (patch.sede && pack.map.comedor) {
      row[pack.map.comedor - 1] = patch.sede;
      dirty = true;
    }
    if (patch.fundo && pack.map.fundo) {
      row[pack.map.fundo - 1] = patch.fundo;
      dirty = true;
    }
    if (patch.comida && pack.map.comida) {
      row[pack.map.comida - 1] = patch.comida;
      dirty = true;
    }
    n += 1;
    lockRowDni(pack, row);
  }
  if (dirty) {
    for (var r = 0; r < values.length; r++) lockRowDni(pack, values[r]);
    stampDniColumns(sh, pack, start, values.length);
    sh.getRange(start, 1, values.length, lastCol).setValues(values);
  }
  return n;
}

function listReservas(desde, hasta) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var list = [];
  var people = ensurePersonSheet(ss, "Trabajadores");
  var extras = ensurePersonSheet(ss, "Comidas extras");
  if (desde === hasta) {
    list = list.concat(readSheetDay(people, false, desde));
    list = list.concat(readSheetDay(extras, true, desde));
  } else {
    list = list.concat(readSheetReservas(people, false, desde, hasta));
    list = list.concat(readSheetReservas(extras, true, desde, hasta));
  }
  list = dedupeActivas(list);
  return list;
}

function readSheetReservas(pack, fromExtra, desde, hasta) {
  var sh = pack.sh;
  var last = sh.getLastRow();
  if (last < 2) return [];
  var lastCol = Math.max(sh.getLastColumn(), COLS_TRABAJADORES.length);
  var start = Math.max(2, last - 3999);
  var values = sh.getRange(start, 1, last - start + 1, lastCol).getValues();
  var out = [];
  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    var item = reservaFromRow(pack, row, fromExtra);
    if (!item || item.date < desde || item.date > hasta) continue;
    out.push(item);
  }
  return out;
}

function readSheetDay(pack, fromExtra, fecha) {
  var sh = pack.sh;
  var last = sh.getLastRow();
  if (last < 2 || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return [];
  var lastCol = Math.max(sh.getLastColumn(), COLS_TRABAJADORES.length);
  var out = [];
  var cursor = last;
  var guard = 0;
  while (cursor >= 2 && guard < 24) {
    guard += 1;
    var start = Math.max(2, cursor - 799);
    var values = sh.getRange(start, 1, cursor - start + 1, lastCol).getValues();
    var dated = 0;
    var older = 0;
    for (var i = 0; i < values.length; i++) {
      var item = reservaFromRow(pack, values[i], fromExtra);
      if (!item) continue;
      dated += 1;
      if (item.date < fecha) older += 1;
      else if (item.date === fecha) out.push(item);
    }
    if (out.length && dated && older === dated) break;
    if (start === 2) break;
    cursor = start - 1;
  }
  return out;
}

function reservaFromRow(pack, row, fromExtra) {
  var fecha = normFecha(val(pack, row, "fecha_local"));
  if (!fecha) return null;
  var dni = onlyDni(val(pack, row, "trabajador_dni"));
  if (!/^\d{8}$/.test(dni)) return null;
  var status = normStatus(val(pack, row, "status"));
  var extra = fromExtra || isExtraFlag(val(pack, row, "extra"));
  if (status === "cancelled") extra = false;
  var sid = onlyDni(val(pack, row, "supervisor_id"));
  var supervisor = titleCase(valSupName(pack, row)) || sid;
  var sede = canonSede(val(pack, row, "comedor"));
  if (!supervisor || !sede) return null;
  var apellido = String(val(pack, row, "trabajador_apellido") || "").trim();
  var nombre = String(val(pack, row, "trabajador_nombre") || "").trim();
  var name = (apellido + " " + nombre).replace(/\s+/g, " ").trim();
  if (!name) return null;
  var fundo = canonFundo(val(pack, row, "fundo") || val(pack, row, "etapa"));
  return {
    id: dni,
    dni: dni,
    name: name,
    apellido: apellido,
    nombre: nombre,
    date: fecha,
    time: normHora(val(pack, row, "hora_guardado")),
    supervisor: supervisor,
    supervisor_id: sid,
    sede: sede,
    comedor: sede,
    fundo: fundo,
    etapa: fundo,
    extra: extra,
    tipo: extra ? "extra" : "lista",
    status: status,
    comidas: Number(val(pack, row, "comidas")) === 2 ? 2 : 1
  };
}

function dedupeActivas(list) {
  var seen = {};
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var r = list[i];
    if (r.status === "cancelled") {
      out.push(r);
      continue;
    }
    var normal = !r.extra;
    var key = (r.supervisor_id || "") + "|" + r.dni + "|" + r.date + "|" + (normal ? "normal" : "extra");
    var copies = Number(r.comidas) === 2 ? 2 : 1;
    if (seen[key]) {
      var prev = seen[key];
      if (Number(r.comidas) === 2 || Number(prev.comidas) === 2) prev.comidas = 2;
      else prev.comidas = Math.min(2, (Number(prev.comidas) || 1) + 1);
      continue;
    }
    r = copyRsv(r);
    r.extra = !normal;
    r.tipo = normal ? "lista" : "extra";
    r.comidas = copies;
    seen[key] = r;
    out.push(r);
  }
  return out;
}

function copyRsv(r) {
  return {
    id: r.id,
    dni: r.dni,
    name: r.name,
    apellido: r.apellido || "",
    nombre: r.nombre || "",
    date: r.date,
    time: r.time,
    supervisor: r.supervisor,
    supervisor_id: r.supervisor_id || "",
    sede: r.sede,
    comedor: r.comedor || r.sede,
    fundo: r.fundo || r.etapa || "",
    etapa: r.etapa || r.fundo || "",
    extra: !!r.extra,
    tipo: r.extra ? "extra" : "lista",
    status: r.status,
    comidas: Number(r.comidas) === 2 ? 2 : 1
  };
}

function findActiveSameDay(dni, fecha) {
  var all = listReservas(fecha, fecha);
  var hits = [];
  for (var i = 0; i < all.length; i++) {
    if (all[i].dni === dni && all[i].date === fecha && all[i].status !== "cancelled") hits.push(all[i]);
  }
  return hits;
}

function cancelInSheet(pack, dni, fecha, id, sid) {
  var sh = pack.sh;
  var last = sh.getLastRow();
  if (last < 2) return 0;
  var lastCol = Math.max(sh.getLastColumn(), COLS_TRABAJADORES.length);
  var start = Math.max(2, last - 3999);
  var values = sh.getRange(start, 1, last - start + 1, lastCol).getValues();
  var colStatus = pack.map.status || lastCol;
  var n = 0;
  var wantSid = onlyDni(sid);
  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    var rowFecha = normFecha(val(pack, row, "fecha_local"));
    var rowDni = onlyDni(val(pack, row, "trabajador_dni"));
    var wantDni = onlyDni(dni || id);
    var match = false;
    if (wantDni && /^\d{8}$/.test(wantDni) && rowDni === wantDni && fechaEs(val(pack, row, "fecha_local"), fecha)) match = true;
    else if (id && String(val(pack, row, "id") || "").trim() === id) match = true;
    if (!match) continue;
    if (/^\d{8}$/.test(wantSid) && onlyDni(val(pack, row, "supervisor_id")) !== wantSid) continue;
    if (normStatus(val(pack, row, "status")) === "cancelled") continue;
    sh.getRange(start + i, colStatus).setValue("cancelled");
    n += 1;
  }
  return n;
}

function turnoStatus(q) {
  var sid = onlyDni(q.supervisor || q.supervisor_id || q.dni);
  if (!/^\d{8}$/.test(sid)) return jsonOut({ ok: false, error: "sesion_invalida" });
  var fecha = String(q.fecha || q.date || limaFecha()).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) fecha = limaFecha();
  var comida = cell(q.comida || "Almuerzo", 40);
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var enviado = supervisorYaRegistroHoy(ss, sid, fecha);
  if (enviado) markSupervisorSent(sid, fecha, comida);
  return jsonOut({
    ok: true,
    enviado: enviado,
    extra_ok: enviado,
    fecha: fecha,
    supervisor_id: sid,
    comida: comida
  });
}

function supervisorSentKey(sid, fecha, comida) {
  return "supsent:" + fecha + ":" + sid + ":" + fold(comida || "almuerzo");
}

function markSupervisorSent(sid, fecha, comida) {
  try {
    CacheService.getScriptCache().put(supervisorSentKey(sid, fecha, comida), "1", CACHE_TTL_SEC);
  } catch (e) { /* ignore */ }
}

function supervisorYaRegistroHoy(ss, sid, fecha) {
  if (!/^\d{8}$/.test(sid) || !fecha) return false;
  // Solo hojas reales. La caché sola provocaba "ya enviado" falso → Extra con Lista 0.
  if (supervisorIdEnHojaSupervisores(ss, sid, fecha)) {
    markSupervisorSent(sid, fecha, "Almuerzo");
    return true;
  }
  if (supervisorSentInPeople(ensurePersonSheet(ss, "Trabajadores"), sid, fecha)) {
    markSupervisorSent(sid, fecha, "Almuerzo");
    return true;
  }
  try {
    CacheService.getScriptCache().remove(supervisorSentKey(sid, fecha, "Almuerzo"));
  } catch (e) { /* ignore */ }
  return false;
}

function supervisorIdEnHojaSupervisores(ss, sid, fecha) {
  var pack = ensureSupervisorSheet(ss);
  var sh = pack.sh;
  var last = sh.getLastRow();
  if (last < 2) return false;
  var lastCol = Math.max(sh.getLastColumn(), COLS_SUPERVISORES.length);
  var start = Math.max(2, last - 799);
  var values = sh.getRange(start, 1, last - start + 1, lastCol).getValues();
  for (var i = values.length - 1; i >= 0; i--) {
    var row = values[i];
    if (!fechaEs(val(pack, row, "fecha_local"), fecha)) continue;
    if (onlyDni(val(pack, row, "supervisor_id")) === sid) return true;
  }
  return false;
}

function supervisorSentInPeople(pack, sid, fecha) {
  var sh = pack.sh;
  var last = sh.getLastRow();
  if (last < 2) return false;
  var lastCol = Math.max(sh.getLastColumn(), COLS_TRABAJADORES.length);
  var start = Math.max(2, last - 1199);
  var values = sh.getRange(start, 1, last - start + 1, lastCol).getValues();
  for (var i = values.length - 1; i >= 0; i--) {
    var row = values[i];
    if (!fechaEs(val(pack, row, "fecha_local"), fecha)) continue;
    if (onlyDni(val(pack, row, "supervisor_id")) !== sid) continue;
    if (normStatus(val(pack, row, "status")) === "cancelled") continue;
    return true;
  }
  return false;
}

function menuCopies(person, extra) {
  var n = Number(person && (person.menus || person.cantidad));
  return n === 2 ? 2 : 1;
}

function activeCopiesByDni(pack, sid, fecha) {
  var out = {};
  var sh = pack.sh;
  var last = sh.getLastRow();
  if (last < 2) return out;
  var lastCol = Math.max(sh.getLastColumn(), COLS_TRABAJADORES.length);
  var start = Math.max(2, last - 3999);
  var values = sh.getRange(start, 1, last - start + 1, lastCol).getValues();
  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    if (!fechaEs(val(pack, row, "fecha_local"), fecha)) continue;
    if (onlyDni(val(pack, row, "supervisor_id")) !== sid) continue;
    if (normStatus(val(pack, row, "status")) === "cancelled") continue;
    var dni = onlyDni(val(pack, row, "trabajador_dni"));
    if (!/^\d{8}$/.test(dni)) continue;
    var copies = Number(val(pack, row, "comidas")) === 2 ? 2 : 1;
    if (!out[dni] || copies === 2) out[dni] = copies === 2 ? 2 : (out[dni] || 1);
  }
  return out;
}

function writePeople(pack, people, meta) {
  var existing = activeCopiesByDni(pack, meta.sid, meta.fecha);
  var rows = [];
  var extra = meta.extra === true;
  for (var i = 0; i < people.length; i++) {
    var w = people[i] || {};
    var dni = onlyDni(w.id || w.dni);
    if (!/^\d{8}$/.test(dni) || existing[dni]) continue;
    var parts = personNameParts(w);
    var copies = menuCopies(w, extra);
    rows.push(reservaRow(pack, {
      fecha: meta.fecha,
      hora: meta.hora,
      sid: meta.sid,
      sap: meta.sap,
      dni: dni,
      apellido: cell(parts.apellido, 80),
      nombre: cell(parts.nombre, 80),
      comida: meta.comida,
      comedor: meta.comedor,
      fundo: meta.fundo,
      lote_campo: meta.lote_campo,
      modulo: meta.modulo,
      turno_campo: meta.turno_campo,
      status: meta.status || "confirmed",
      comidas: copies
    }));
    existing[dni] = copies;
  }
  if (!rows.length) return 0;
  var writeAt = pack.sh.getLastRow() + 1;
  stampDniColumns(pack.sh, pack, writeAt, rows.length);
  pack.sh.getRange(writeAt, 1, rows.length, pack.width).setValues(rows);
  return rows.length;
}

function collapseDuplicatePeople(pack) {
  var sh = pack.sh;
  var last = sh.getLastRow();
  if (last < 2 || !pack.map.trabajador_dni) return 0;
  var lastCol = Math.max(sh.getLastColumn(), COLS_TRABAJADORES.length);
  var values = sh.getRange(2, 1, last - 1, lastCol).getValues();
  var seen = {};
  var drop = [];
  var comidasCol = pack.map.comidas;
  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    var dni = onlyDni(val(pack, row, "trabajador_dni"));
    var sid = onlyDni(val(pack, row, "supervisor_id"));
    var fecha = normFecha(val(pack, row, "fecha_local"));
    if (!/^\d{8}$/.test(dni) || !fecha) continue;
    var hora = val(pack, row, "hora_guardado");
    var stamp = Object.prototype.toString.call(hora) === "[object Date]" && !isNaN(hora.getTime())
      ? Utilities.formatDate(hora, TZ, "HH:mm:ss")
      : String(hora || "").trim();
    var key = [fecha, stamp, sid, dni, normStatus(val(pack, row, "status"))].join("|");
    var copies = Number(val(pack, row, "comidas")) === 2 ? 2 : 1;
    if (seen[key] == null) {
      seen[key] = { index: i, copies: copies };
      continue;
    }
    if (copies === 2) seen[key].copies = 2;
    drop.push(i);
  }
  if (comidasCol) {
    for (var k in seen) {
      if (seen[k].copies !== 2) continue;
      var keeper = seen[k].index;
      if (Number(values[keeper][comidasCol - 1]) === 2) continue;
      sh.getRange(keeper + 2, comidasCol).setValue(2);
    }
  }
  drop.sort(function (a, b) { return b - a; });
  for (var d = 0; d < drop.length; d++) sh.deleteRow(drop[d] + 2);
  return drop.length;
}

function appendReserva(pack, rec) {
  var at = pack.sh.getLastRow() + 1;
  stampDniColumns(pack.sh, pack, at, 1);
  pack.sh.getRange(at, 1, 1, pack.width).setValues([reservaRow(pack, rec)]);
}

function appendSupervisor(pack, rec) {
  var at = pack.sh.getLastRow() + 1;
  stampDniColumns(pack.sh, pack, at, 1);
  pack.sh.getRange(at, 1, 1, pack.width).setValues([supervisorRow(pack, rec)]);
}

function sidForWorkerDay(ss, dni, fecha) {
  var want = onlyDni(dni);
  if (!/^\d{8}$/.test(want) || !fecha) return "";
  var packs = [
    ensurePersonSheet(ss, "Trabajadores"),
    ensurePersonSheet(ss, "Comidas extras")
  ];
  for (var p = 0; p < packs.length; p++) {
    var pack = packs[p];
    var sh = pack.sh;
    var last = sh.getLastRow();
    if (last < 2) continue;
    var lastCol = Math.max(sh.getLastColumn(), COLS_TRABAJADORES.length);
    var start = Math.max(2, last - 3999);
    var values = sh.getRange(start, 1, last - start + 1, lastCol).getValues();
    for (var i = values.length - 1; i >= 0; i--) {
      var row = values[i];
      if (!fechaEs(val(pack, row, "fecha_local"), fecha)) continue;
      if (onlyDni(val(pack, row, "trabajador_dni")) !== want) continue;
      var sid = onlyDni(val(pack, row, "supervisor_id"));
      if (/^\d{8}$/.test(sid)) return sid;
    }
  }
  return "";
}

function countActiveMeals(pack, sid, fecha) {
  var sh = pack.sh;
  var last = sh.getLastRow();
  if (last < 2) return 0;
  var lastCol = Math.max(sh.getLastColumn(), COLS_TRABAJADORES.length);
  var start = Math.max(2, last - 3999);
  var values = sh.getRange(start, 1, last - start + 1, lastCol).getValues();
  var byDni = {};
  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    if (!fechaEs(val(pack, row, "fecha_local"), fecha)) continue;
    if (onlyDni(val(pack, row, "supervisor_id")) !== sid) continue;
    if (normStatus(val(pack, row, "status")) === "cancelled") continue;
    var dni = onlyDni(val(pack, row, "trabajador_dni"));
    if (!/^\d{8}$/.test(dni)) continue;
    var copies = Number(val(pack, row, "comidas")) === 2 ? 2 : 1;
    if (!byDni[dni]) byDni[dni] = copies;
    else if (byDni[dni] === 2 || copies === 2) byDni[dni] = 2;
    else byDni[dni] = Math.min(2, byDni[dni] + 1);
  }
  var n = 0;
  for (var key in byDni) n += byDni[key];
  return n;
}

function numTotal(v) {
  var n = Number(v);
  return isFinite(n) ? n : 0;
}

function refreshSupervisorTotal(ss, sid, fecha, delta) {
  if (!/^\d{8}$/.test(sid) || !fecha) return 0;
  SpreadsheetApp.flush();
  var counted = countActiveMeals(ensurePersonSheet(ss, "Trabajadores"), sid, fecha)
    + countActiveMeals(ensurePersonSheet(ss, "Comidas extras"), sid, fecha);
  var pack = ensureSupervisorSheet(ss);
  var sh = pack.sh;
  var last = sh.getLastRow();
  if (last < 2) return Math.max(counted, Number(delta) || 0);
  var col = pack.map.total_comidas;
  if (!col) return Math.max(counted, Number(delta) || 0);
  var lastCol = Math.max(sh.getLastColumn(), COLS_SUPERVISORES.length);
  var start = Math.max(2, last - 799);
  var values = sh.getRange(start, 1, last - start + 1, lastCol).getValues();
  var stored = 0;
  var hits = [];
  var lastSid = -1;
  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    if (onlyDni(val(pack, row, "supervisor_id")) !== sid) continue;
    lastSid = i;
    if (!fechaEs(val(pack, row, "fecha_local"), fecha)) continue;
    stored = numTotal(val(pack, row, "total_comidas"));
    hits.push(i);
  }
  if (!hits.length && lastSid >= 0) {
    stored = numTotal(val(pack, values[lastSid], "total_comidas"));
    hits.push(lastSid);
  }
  var total = counted;
  for (var h = 0; h < hits.length; h++) {
    values[hits[h]][col - 1] = total;
    lockRowDni(pack, values[hits[h]]);
  }
  if (hits.length) {
    for (var r = 0; r < values.length; r++) lockRowDni(pack, values[r]);
    stampDniColumns(sh, pack, start, values.length);
    sh.getRange(start, 1, values.length, lastCol).setValues(values);
  }
  return total;
}

function recalcSupervisorTotals(fecha) {
  var day = fecha || limaFecha();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var pack = ensureSupervisorSheet(ss);
  var sh = pack.sh;
  var last = sh.getLastRow();
  if (last < 2) return [];
  var lastCol = Math.max(sh.getLastColumn(), COLS_SUPERVISORES.length);
  var start = Math.max(2, last - 799);
  var values = sh.getRange(start, 1, last - start + 1, lastCol).getValues();
  var seen = {};
  var out = [];
  for (var i = values.length - 1; i >= 0; i--) {
    var sid = onlyDni(val(pack, values[i], "supervisor_id"));
    if (!/^\d{8}$/.test(sid) || seen[sid]) continue;
    if (!fechaEs(val(pack, values[i], "fecha_local"), day)) continue;
    seen[sid] = true;
    out.push({
      supervisor_id: sid,
      total_comidas: refreshSupervisorTotal(ss, sid, day, 0)
    });
  }
  return out;
}

function supervisorRow(pack, rec) {
  var row = [];
  for (var i = 0; i < pack.width; i++) row.push("");
  setCol(pack, row, "fecha_local", fechaCell(rec.fecha));
  setCol(pack, row, "hora_guardado", rec.hora);
  setCol(pack, row, "supervisor_id", dniCell(rec.sid));
  setCol(pack, row, "supervisor_apellido_nombre", rec.sap);
  setCol(pack, row, "comida", rec.comida);
  setCol(pack, row, "comedor", rec.comedor);
  setCol(pack, row, "fundo", rec.fundo);
  setCol(pack, row, "lote_campo", rec.lote_campo);
  setCol(pack, row, "modulo", rec.modulo);
  setCol(pack, row, "turno_campo", rec.turno_campo);
  setCol(pack, row, "total_comidas", rec.total);
  return row;
}

function reservaRow(pack, rec) {
  var row = [];
  for (var i = 0; i < pack.width; i++) row.push("");
  setCol(pack, row, "fecha_local", fechaCell(rec.fecha));
  setCol(pack, row, "hora_guardado", rec.hora);
  setCol(pack, row, "supervisor_id", dniCell(rec.sid));
  setCol(pack, row, "supervisor_apellido_nombre", rec.sap);
  setCol(pack, row, "trabajador_dni", dniCell(rec.dni));
  setCol(pack, row, "trabajador_apellido", rec.apellido);
  setCol(pack, row, "trabajador_nombre", rec.nombre);
  setCol(pack, row, "comida", rec.comida);
  setCol(pack, row, "comedor", rec.comedor);
  setCol(pack, row, "fundo", rec.fundo);
  setCol(pack, row, "lote_campo", rec.lote_campo);
  setCol(pack, row, "modulo", rec.modulo);
  setCol(pack, row, "turno_campo", rec.turno_campo);
  setCol(pack, row, "status", rec.status || "confirmed");
  setCol(pack, row, "comidas", rec.comidas === 2 ? 2 : 1);
  return row;
}

function setCol(pack, row, name, value) {
  var col = pack.map[name];
  if (!col) return;
  row[col - 1] = value == null ? "" : value;
}

function val(pack, row, name) {
  var col = pack.map[name];
  if (!col) return "";
  return row[col - 1];
}

function valSupName(pack, row) {
  return String(val(pack, row, "supervisor_apellido_nombre") || val(pack, row, "supervisor_apellido") || "").trim();
}

function supervisorFullName() {
  var best = "";
  for (var i = 0; i < arguments.length; i++) {
    var s = String(arguments[i] == null ? "" : arguments[i]).replace(/\s+/g, " ").trim();
    if (!s || /^\d{8}$/.test(onlyDni(s))) continue;
    if (s.length > best.length) best = s;
  }
  return cell(best, 80).toUpperCase();
}

function dropUnusedCols(sh) {
  var lastCol = sh.getLastColumn();
  if (lastCol < 1) return;
  var headers = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  for (var i = headers.length - 1; i >= 0; i--) {
    var key = String(headers[i] || "").toLowerCase().trim();
    if (DROP_COLS.indexOf(key) >= 0) sh.deleteColumn(i + 1);
  }
}

function headerIndex(sh) {
  var lastCol = Math.max(sh.getLastColumn(), 1);
  var headers = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  var map = {};
  for (var i = 0; i < headers.length; i++) {
    var key = String(headers[i] || "").toLowerCase().trim();
    if (key) map[key] = i;
  }
  return map;
}

function migrateSupervisorNameHeader(sh) {
  var map = headerIndex(sh);
  if (map.supervisor_apellido_nombre != null) return;
  if (map.supervisor_apellido != null) {
    sh.getRange(1, map.supervisor_apellido + 1).setValue("supervisor_apellido_nombre").setFontWeight("bold");
  }
}

function migrateFundoHeader(sh) {
  var map = headerIndex(sh);
  if (map.fundo != null) return;
  if (map.etapa != null) {
    sh.getRange(1, map.etapa + 1).setValue("fundo").setFontWeight("bold");
    return;
  }
  if (map.lote != null) {
    sh.getRange(1, map.lote + 1).setValue("fundo").setFontWeight("bold");
    return;
  }
  if (map.lotes != null) {
    sh.getRange(1, map.lotes + 1).setValue("fundo").setFontWeight("bold");
  }
}

function mapFromHeaders(hdrs) {
  var map = {};
  for (var i = 0; i < hdrs.length; i++) {
    var key = String(hdrs[i] || "").toLowerCase().trim();
    if (key) map[key] = i + 1;
  }
  return map;
}

function headersNeedFix(map, headers) {
  if (!map.fundo) return true;
  if (!map.supervisor_apellido_nombre) return true;
  var i;
  for (i = 0; i < headers.length; i++) {
    if (!map[headers[i]]) return true;
  }
  for (i = 0; i < DROP_COLS.length; i++) {
    if (map[DROP_COLS[i]]) return true;
  }
  return false;
}

function packWidth(map) {
  var w = 0;
  for (var k in map) {
    if (map[k] > w) w = map[k];
  }
  return w;
}

function ensureNamedSheet(ss, name, headers) {
  if (PACK_MEMO[name]) return PACK_MEMO[name];
  var sh = sheetReady(ss, name, headers);
  var lastCol = Math.max(sh.getLastColumn(), 1);
  var hdrs = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  var map = mapFromHeaders(hdrs);
  if (headersNeedFix(map, headers)) {
    migrateFundoHeader(sh);
    migrateSupervisorNameHeader(sh);
    dropUnusedCols(sh);
    lastCol = Math.max(sh.getLastColumn(), 1);
    hdrs = sh.getRange(1, 1, 1, lastCol).getValues()[0];
    map = mapFromHeaders(hdrs);
    for (var j = 0; j < headers.length; j++) {
      var need = headers[j];
      if (!map[need]) {
        var col = sh.getLastColumn() + 1;
        sh.getRange(1, col).setValue(need).setFontWeight("bold");
        map[need] = col;
      }
    }
    paintSheetHead(sh);
  }
  var pack = { sh: sh, map: map, width: packWidth(map) };
  PACK_MEMO[name] = pack;
  return pack;
}

function ensurePersonSheet(ss, name) {
  return ensureNamedSheet(ss, name, COLS_TRABAJADORES);
}

function ensureSupervisorSheet(ss) {
  return ensureNamedSheet(ss, "Supervisores", COLS_SUPERVISORES);
}

function namesMatch(a, b) {
  var fa = fold(a);
  var fb = fold(b);
  if (!fa || !fb) return false;
  if (fa === fb) return true;
  var ta = fold(twoApellidos(a));
  var tb = fold(twoApellidos(b));
  if (ta && tb && ta === tb) return true;
  if (fa.indexOf(fb) === 0 || fb.indexOf(fa) === 0) return true;
  if (ta && fb.indexOf(ta) === 0) return true;
  if (tb && fa.indexOf(tb) === 0) return true;
  return false;
}

function hitFromRow(pack, row) {
  var sid = onlyDni(val(pack, row, "supervisor_id"));
  if (!/^\d{8}$/.test(sid)) return null;
  var sap = valSupName(pack, row);
  return {
    dni: sid,
    name: sap || sid,
    nombre: (sap || sid).toUpperCase(),
    comedor: canonSede(val(pack, row, "comedor")),
    fundo: canonFundo(val(pack, row, "fundo") || val(pack, row, "etapa"))
  };
}

function supervisorOnDutyToday(digits, raw, fecha) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var packs = [
    ensureSupervisorSheet(ss),
    ensurePersonSheet(ss, "Trabajadores"),
    ensurePersonSheet(ss, "Comidas extras")
  ];
  var day = fecha || limaFecha();
  for (var p = 0; p < packs.length; p++) {
    var pack = packs[p];
    var sh = pack.sh;
    var last = sh.getLastRow();
    if (last < 2) continue;
    var lastCol = Math.max(sh.getLastColumn(), 1);
    var start = Math.max(2, last - 1999);
    var values = sh.getRange(start, 1, last - start + 1, lastCol).getValues();
    for (var i = values.length - 1; i >= 0; i--) {
      var row = values[i];
      if (!fechaEs(val(pack, row, "fecha_local"), day)) continue;
      var hit = hitFromRow(pack, row);
      if (!hit) continue;
      if (digits && hit.dni === digits) return hit;
      if (raw && namesMatch(hit.name, raw)) return hit;
    }
  }
  return null;
}

function listSupervisorsOnDuty(fecha) {
  var day = fecha || limaFecha();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var packs = [
    ensureSupervisorSheet(ss),
    ensurePersonSheet(ss, "Trabajadores"),
    ensurePersonSheet(ss, "Comidas extras")
  ];
  var seen = {};
  var list = [];
  for (var p = 0; p < packs.length; p++) {
    var pack = packs[p];
    var sh = pack.sh;
    var last = sh.getLastRow();
    if (last < 2) continue;
    var lastCol = Math.max(sh.getLastColumn(), 1);
    var start = Math.max(2, last - 1999);
    var values = sh.getRange(start, 1, last - start + 1, lastCol).getValues();
    for (var i = values.length - 1; i >= 0; i--) {
      var row = values[i];
      if (!fechaEs(val(pack, row, "fecha_local"), day)) continue;
      var hit = hitFromRow(pack, row);
      if (!hit || seen[hit.dni]) continue;
      seen[hit.dni] = true;
      list.push({
        dni: hit.dni,
        name: titleCase(hit.name) || hit.dni,
        nombre: (hit.nombre || hit.name || "").toUpperCase(),
        sede: hit.comedor || "",
        fundo: hit.fundo || "",
        cargo: "Supervisor"
      });
    }
  }
  return list;
}

function resolveDutySupervisor(body, fecha) {
  body = body || {};
  var raw = String(body.supervisor || body.supervisor_name || body.supervisor_id || "").trim();
  var digits = onlyDni(body.supervisor_id || body.supervisor_dni || raw);
  var fromSheet = supervisorOnDutyToday(digits, raw, fecha);
  if (fromSheet) return fromSheet;
  fromSheet = findSupervisorOnDuty(digits, fold(raw));
  if (fromSheet) return fromSheet;
  if (/^\d{8}$/.test(digits)) {
    var label = raw && !/^\d{8}$/.test(onlyDni(raw)) ? String(raw).replace(/\s+/g, " ").trim() : digits;
    return {
      dni: digits,
      name: label || digits,
      nombre: (label || digits).toUpperCase()
    };
  }
  return null;
}

function findSupervisorOnDuty(digits, key) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var packs = [
    ensurePersonSheet(ss, "Trabajadores"),
    ensurePersonSheet(ss, "Comidas extras"),
    ensureSupervisorSheet(ss)
  ];
  var hoy = limaFecha();
  var ayer = addDays(hoy, -1);
  for (var p = 0; p < packs.length; p++) {
    var pack = packs[p];
    var sh = pack.sh;
    var last = sh.getLastRow();
    if (last < 2) continue;
    var lastCol = Math.max(sh.getLastColumn(), 1);
    var start = Math.max(2, last - 1999);
    var values = sh.getRange(start, 1, last - start + 1, lastCol).getValues();
    for (var i = values.length - 1; i >= 0; i--) {
      var row = values[i];
      if (!fechaEs(val(pack, row, "fecha_local"), hoy) && !fechaEs(val(pack, row, "fecha_local"), ayer)) continue;
      var sid = onlyDni(val(pack, row, "supervisor_id"));
      if (!/^\d{8}$/.test(sid)) continue;
      var sap = valSupName(pack, row);
      var label = titleCase(sap) || sid;
      if ((digits && sid === digits) || (key && namesMatch(sap, key)) || (key && namesMatch(label, key))) {
        return { dni: sid, name: label, nombre: (sap || label).toUpperCase() };
      }
    }
  }
  return null;
}

function lastSedeForSupervisor(dni, fecha) {
  var list = listReservas(fecha, fecha);
  for (var i = list.length - 1; i >= 0; i--) {
    var r = list[i];
    if (r.status === "cancelled" || !r.sede) continue;
    if (onlyDni(r.supervisor_id) === dni) return r.sede;
  }
  var hit = supervisorOnDutyToday(dni, "", fecha);
  return (hit && hit.comedor) ? hit.comedor : "";
}

function findSupervisor(raw) {
  return resolveDutySupervisor({ supervisor: raw, supervisor_id: onlyDni(raw) }, limaFecha());
}

function dateRangeFromQuery(q) {
  var hoy = limaFecha();
  var ayer = addDays(hoy, -1);
  var fecha = String(q.fecha || q.date || "").slice(0, 10);
  var desde = String(q.desde || q.from || "").slice(0, 10);
  var hasta = String(q.hasta || q.to || "").slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return { desde: fecha, hasta: fecha };
  if (/^\d{4}-\d{2}-\d{2}$/.test(desde) && /^\d{4}-\d{2}-\d{2}$/.test(hasta)) {
    return desde <= hasta ? { desde: desde, hasta: hasta } : { desde: hasta, hasta: desde };
  }
  return { desde: ayer, hasta: hoy };
}

function limaFecha() {
  return Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd");
}

function limaHora() {
  return Utilities.formatDate(new Date(), TZ, "HH:mm");
}

function fechaCell(iso) {
  var s = String(iso || "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? "'" + s : s;
}

function pad2(n) {
  return ("0" + n).slice(-2);
}

function fechaEs(v, fecha) {
  if (!fecha) return false;
  if (String(v || "").indexOf(fecha) >= 0) return true;
  var n = normFecha(v);
  return n === fecha;
}

function addDays(iso, delta) {
  var p = iso.split("-");
  var d = new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2])));
  d.setUTCDate(d.getUTCDate() + delta);
  return Utilities.formatDate(d, "UTC", "yyyy-MM-dd");
}

function normFecha(v) {
  var hoy = limaFecha();
  if (Object.prototype.toString.call(v) === "[object Date]" && !isNaN(v.getTime())) {
    var opts = [
      Utilities.formatDate(v, TZ, "yyyy-MM-dd"),
      Utilities.formatDate(v, "UTC", "yyyy-MM-dd"),
      v.getUTCFullYear() + "-" + pad2(v.getUTCMonth() + 1) + "-" + pad2(v.getUTCDate()),
      v.getFullYear() + "-" + pad2(v.getMonth() + 1) + "-" + pad2(v.getDate())
    ];
    try {
      opts.push(Utilities.formatDate(v, SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone(), "yyyy-MM-dd"));
    } catch (e1) { /* ignore */ }
    var i;
    for (i = 0; i < opts.length; i++) {
      if (opts[i] === hoy) return hoy;
    }
    return opts[0] || "";
  }
  var s = String(v || "").trim();
  var m = s.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : "";
}

function normHora(v) {
  if (Object.prototype.toString.call(v) === "[object Date]" && !isNaN(v.getTime())) {
    return Utilities.formatDate(v, TZ, "HH:mm");
  }
  var s = String(v || "").trim();
  var m = s.match(/(\d{1,2}):(\d{2})/);
  if (!m) return limaHora();
  return ("0" + m[1]).slice(-2) + ":" + m[2];
}

function normStatus(v) {
  var s = fold(v);
  if (s === "cancelled" || s === "cancelada" || s === "canceled" || s === "cancelado") return "cancelled";
  if (s === "pending" || s === "pendiente") return "pending";
  return "confirmed";
}

function isExtraFlag(v) {
  if (v === true || v === 1) return true;
  var s = fold(v);
  return s === "true" || s === "1" || s === "si" || s === "extra";
}

function canonFundo(raw) {
  var s = fold(String(raw || ""));
  if (/licapa\s*(iii|3)\b/.test(s)) return "LICAPA III";
  if (/licapa\s*(ii|2)\b/.test(s)) return "LICAPA II";
  if (/licapa\s*(i|1)\b/.test(s)) return "LICAPA I";
  return "LICAPA I";
}

function canonSede(raw) {
  var s = String(raw || "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  var f = fold(s);
  if (f === "galpon" || f === "comedor galpon") return "Galpon";
  if (f === "oficina tecnica") return "Oficina Tecnica";
  if (f === "comedor principal - ii" || f === "comedor principal ii" || f === "principal ii") return "Comedor Principal - II";
  if (f === "garita 1" || f === "garita1") return "Garita 1";
  if (f === "garita 2" || f === "garita2") return "Garita 2";
  if (f === "administrativo" || f === "comedor administrativo") return "Comedor Administrativo";
  var m = f.match(/^comedor (\d{1,2})$/);
  if (m) {
    var num = Number(m[1]);
    if (num >= 1 && num <= 11) return "Comedor " + num;
  }
  for (var i = 0; i < COMEDORES.length; i++) {
    if (fold(COMEDORES[i]) === f) return COMEDORES[i];
  }
  return s;
}

function uniquePeople(people) {
  var seen = {};
  var out = [];
  for (var i = 0; i < people.length; i++) {
    var w = people[i] || {};
    var d = onlyDni(w.dni || w.id);
    if (!/^\d{8}$/.test(d) || seen[d]) continue;
    seen[d] = true;
    var copy = {};
    for (var k in w) copy[k] = w[k];
    copy.dni = d;
    copy.id = d;
    out.push(copy);
  }
  return out;
}

function onlyDni(raw) {
  if (typeof raw === "number" && isFinite(raw)) raw = String(Math.round(raw));
  var s = String(raw == null ? "" : raw).replace(/\D/g, "");
  if (s.length > 8) s = s.slice(0, 8);
  if (s.length >= 6 && s.length < 8) s = ("00000000" + s).slice(-8);
  return s;
}

function dniCell(raw) {
  var d = onlyDni(raw);
  return /^\d{8}$/.test(d) ? "'" + d : d;
}

function dniColumns(pack) {
  var cols = [];
  if (pack && pack.map) {
    if (pack.map.trabajador_dni) cols.push(pack.map.trabajador_dni);
    if (pack.map.supervisor_id) cols.push(pack.map.supervisor_id);
  }
  return cols;
}

function stampDniColumns(sh, pack, startRow, rowCount) {
  if (!sh || startRow < 2 || rowCount < 1) return;
  var cols = dniColumns(pack);
  for (var i = 0; i < cols.length; i++) {
    sh.getRange(startRow, cols[i], rowCount, 1).setNumberFormat("@");
  }
  SpreadsheetApp.flush();
}

function lockRowDni(pack, row) {
  if (!row) return row;
  var cols = dniColumns(pack);
  for (var i = 0; i < cols.length; i++) {
    var idx = cols[i] - 1;
    if (idx < 0 || idx >= row.length) continue;
    var d = onlyDni(row[idx]);
    if (/^\d{8}$/.test(d)) row[idx] = dniCell(d);
  }
  return row;
}

function personNameParts(w) {
  w = w || {};
  var ap = String(w.apellido || w.apellidos || w.trabajador_apellido || "").replace(/\s+/g, " ").trim();
  var no = String(w.nombres || w.trabajador_nombre || "").replace(/\s+/g, " ").trim();
  if (!no) no = String(w.nombre || "").replace(/\s+/g, " ").trim();
  var full = String(w.name || w.nombreCompleto || w.trabajador || "").replace(/\s+/g, " ").trim();
  if (ap) {
    if (full && !no) {
      var head = ap.toUpperCase();
      var blob = full.toUpperCase();
      if (blob.indexOf(head) === 0) no = full.slice(ap.length).replace(/\s+/g, " ").trim();
      else no = full;
    }
    return { apellido: ap.toUpperCase(), nombre: no.toUpperCase() };
  }
  if (full) {
    var p = splitName(full);
    return { apellido: p.apellido, nombre: String(p.nombre || "").toUpperCase() };
  }
  if (no) {
    var p2 = splitName(no);
    return { apellido: p2.apellido, nombre: String(p2.nombre || "").toUpperCase() };
  }
  return { apellido: "", nombre: "" };
}

function splitName(full) {
  var parts = String(full || "").replace(/\s+/g, " ").trim().split(" ");
  if (parts.length >= 2) {
    return { apellido: (parts[0] + " " + parts[1]).toUpperCase(), nombre: parts.slice(2).join(" ").toUpperCase() };
  }
  return { apellido: String(parts[0] || "").toUpperCase(), nombre: "" };
}

function twoApellidos(name) {
  return splitName(name).apellido;
}

function titleCase(s) {
  return String(s || "").toLowerCase().replace(/(^|[\s'])\S/g, function (c) {
    return c.toUpperCase();
  });
}

function fold(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[áàäâ]/g, "a")
    .replace(/[éèëê]/g, "e")
    .replace(/[íìïî]/g, "i")
    .replace(/[óòöô]/g, "o")
    .replace(/[úùüû]/g, "u")
    .replace(/ñ/g, "n")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function bumpAdminCache() {
  try {
    var c = CacheService.getScriptCache();
    var hoy = limaFecha();
    c.remove("rsv:" + hoy + ":" + hoy);
    c.remove("rsv:" + addDays(hoy, -1) + ":" + hoy);
  } catch (e) { /* ignore */ }
}

function cell(v, max) {
  var s = String(v == null ? "" : v);
  s = s.replace(/[\u0000-\u001f]/g, " ").trim();
  if (/^[=+\-@|]/.test(s)) s = "'" + s;
  return s.slice(0, max || 180);
}

function paintSheetHead(sh) {
  var last = Math.max(sh.getLastColumn(), 1);
  var head = sh.getRange(1, 1, 1, last);
  head.setBackground("#3f8736");
  head.setFontColor("#ffffff");
  head.setFontWeight("bold");
  head.setHorizontalAlignment("center");
  head.setVerticalAlignment("middle");
  sh.setFrozenRows(1);
  sh.setRowHeight(1, 32);
  try { sh.autoResizeColumns(1, last); } catch (e) { /* el ancho a mano no bloquea el envío */ }
}

function sheetReady(ss, name, headers) {
  var sh = ss.getSheetByName(name);
  if (sh) return sh;
  sh = ss.insertSheet(name);
  sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  sh.getRange(1, 1, 1, headers.length).setFontWeight("bold");
  sh.setFrozenRows(1);
  return sh;
}

function jsonOut(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function textOut(obj) {
  return jsonOut(obj);
}

function setupSheets() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  PACK_MEMO = {};
  var people = ensurePersonSheet(ss, "Trabajadores");
  var extras = ensurePersonSheet(ss, "Comidas extras");
  var supers = ensureSupervisorSheet(ss);
  paintSheetHead(people.sh);
  paintSheetHead(extras.sh);
  paintSheetHead(supers.sh);
  collapseDuplicatePeople(people);
  collapseDuplicatePeople(extras);
}
