// ShieldX Background Service Worker v4
// Cambios respecto a v3:
//  - onInstalled ya no borra los contadores al actualizar la extensión.
//  - El service worker es el ÚNICO que escribe contadores: los content scripts
//    envían incrementos. Elimina el doble conteo y las carreras entre frames.
//  - El badge acumula el total de la pestaña (todos sus iframes), no el del
//    último frame que reportó, y se reinicia al navegar.
//  - Lista de sitios excluidos: además de parar el content script, levanta
//    reglas de sesión allowAllRequests para que tampoco actúe la capa de red.

'use strict';

const VALID_MSG_TYPES = new Set([
  'BLOCKED', 'COOKIE_BLOCKED', 'GET_STATS', 'SET_SITE', 'RESET_STATS',
  'GESTURE', 'GUARD_BLOCKED', 'SYNC_RULES', 'DL_DECISION', 'DL_LIST'
]);

const DEFAULTS = {
  enabled: true,
  ytAdBlock: true,
  guardEnabled: true,     // anti pop-under y anti redirección forzada
  downloadGuard: true,    // confirmar descargas que el usuario no ha pedido
  antiAdblockWalls: true, // retirar los muros de "desactiva el bloqueador"
  blockedTotal: 0,
  cookiesBlocked: 0,
  redirectsBlocked: 0,
  siteExcluded: []
};

// tabId -> nº de elementos bloqueados en la carga actual de esa pestaña.
// Si el service worker se recicla se pierde y el badge vuelve a contar desde
// cero en esa pestaña; el total persistente vive en storage.local.
const pageCounts = new Map();

// ── Instalación / actualización ──────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  // Rellenar sólo las claves que falten: una actualización no debe borrar
  // los contadores ni la lista de sitios excluidos del usuario.
  chrome.storage.local.get(Object.keys(DEFAULTS), (data) => {
    const patch = {};
    for (const [k, v] of Object.entries(DEFAULTS)) {
      if (data[k] === undefined) patch[k] = v;
    }
    if (Object.keys(patch).length) chrome.storage.local.set(patch);
    syncSiteRules();
    syncMasterRulesets();
  });
});

chrome.runtime.onStartup.addListener(() => { syncSiteRules(); syncMasterRulesets(); });

// ── Interruptor maestro en la capa de red ────────────────────────────────────
// Pausar ShieldX paraba los content scripts, pero los rulesets estáticos de
// declarativeNetRequest seguían bloqueando peticiones: el popup decía PAUSADO y
// la web seguía rota. Ahora los rulesets se apagan y se encienden con el
// interruptor (y quedan guardados por Chrome entre sesiones).
const RULESETS = ['ruleset_ads', 'ruleset_redirect', 'ruleset_cleanurl'];

function syncMasterRulesets() {
  chrome.storage.local.get(['enabled'], (data) => {
    const on = data.enabled !== false;
    const dnr = chrome.declarativeNetRequest;
    if (!dnr || !dnr.updateEnabledRulesets) return;
    dnr.updateEnabledRulesets(
      on ? { enableRulesetIds: RULESETS } : { disableRulesetIds: RULESETS },
      () => void chrome.runtime.lastError);
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if ('enabled' in changes) syncMasterRulesets();
  // Las exclusiones se aplican a la red venga el cambio de donde venga (popup,
  // atajo, importación o edición directa del almacenamiento).
  if ('siteExcluded' in changes) syncSiteRules();
});

// ── Menú contextual: señalar y ocultar desde el clic derecho ─────────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'sx-pick',
    title: 'Ocultar elemento con ShieldX',
    contexts: ['page', 'image', 'link', 'selection', 'video']
  }, () => void chrome.runtime.lastError);
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'sx-pick' || !tab || tab.id === undefined) return;
  chrome.tabs.sendMessage(tab.id, { type: 'PICK_START' }, () => void chrome.runtime.lastError);
});

// ── Atajos de teclado ────────────────────────────────────────────────────────
// Alt+Shift+S excluye o reactiva el sitio actual sin abrir el popup, que es lo
// que uno quiere cuando una web se ve rota y hay que decidir en el momento.
// Alt+Shift+X entra en modo señalar. El tercero no trae tecla asignada de
// fábrica: el usuario puede ponerle una en chrome://extensions/shortcuts.
if (chrome.commands && chrome.commands.onCommand) {
  chrome.commands.onCommand.addListener((comando, tab) => {
    if (!tab || tab.id === undefined) return;

    if (comando === 'sx-pick') {
      chrome.tabs.sendMessage(tab.id, { type: 'PICK_START' },
        () => void chrome.runtime.lastError);
      return;
    }

    if (comando === 'sx-cookie-show') {
      chrome.tabs.sendMessage(tab.id, { type: 'COOKIE_SHOW' },
        () => void chrome.runtime.lastError);
      return;
    }

    if (comando === 'sx-toggle-site') {
      const host = hostFromUrl(tab.url);
      if (!host) return;   // páginas internas de Chrome
      chrome.storage.local.get(['siteExcluded'], (data) => {
        const list = new Set(Array.isArray(data.siteExcluded) ? data.siteExcluded : []);
        const estaba = list.has(host);
        if (estaba) list.delete(host); else list.add(host);
        chrome.storage.local.set({ siteExcluded: [...list] }, () => {
          syncSiteRules();
          avisar(tab.id, estaba
            ? 'ShieldX vuelve a actuar en ' + host
            : 'ShieldX ya no actúa en ' + host);
          chrome.tabs.reload(tab.id);
        });
      });
    }
  });
}

// Un aviso corto y sin botones: lo que se acaba de hacer con una tecla.
function avisar(tabId, texto) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: 'ShieldX',
    message: texto,
  }, () => void chrome.runtime.lastError);
}

// ── Reglas de red para los sitios excluidos ──────────────────────────────────
// allowAllRequests sobre el main_frame exime al documento y a todos sus
// subrecursos de las reglas estáticas de bloqueo.
function syncSiteRules() {
  chrome.storage.local.get(['siteExcluded'], (data) => {
    const hosts = Array.isArray(data.siteExcluded) ? data.siteExcluded : [];
    const addRules = hosts.slice(0, 500).map((host, i) => ({
      id: i + 1,
      priority: 10000, // por encima de las reglas de bloqueo (priority 1)
      action: { type: 'allowAllRequests' },
      condition: {
        requestDomains: [host],       // incluye subdominios
        resourceTypes: ['main_frame', 'sub_frame']
      }
    }));

    chrome.declarativeNetRequest.getSessionRules((existing) => {
      chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: existing.map(r => r.id),
        addRules
      }, () => void chrome.runtime.lastError);
    });
  });
}

function normalizeHost(host) {
  return String(host || '').toLowerCase().replace(/^www\./, '').trim();
}

function hostFromUrl(url) {
  try {
    const u = new URL(url);
    // Sólo la web de verdad: en chrome://extensions/ el "hostname" es
    // "extensions", y el atajo llegaba a excluir ese sitio fantasma.
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return normalizeHost(u.hostname);
  } catch (_) { return ''; }
}

// ── Contadores ───────────────────────────────────────────────────────────────
let pendingTotal = 0;
let flushTimer = null;

// Agrupa los incrementos: en una página con mucho DOM llegan decenas de
// mensajes por segundo y un get+set por cada uno se pisa a sí mismo.
function addToTotal(delta) {
  pendingTotal += delta;
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    const n = pendingTotal;
    pendingTotal = 0;
    flushTimer = null;
    if (n <= 0) return;
    chrome.storage.local.get(['blockedTotal'], (data) => {
      chrome.storage.local.set({ blockedTotal: (data.blockedTotal || 0) + n });
    });
  }, 500);
}

function paintBadge(tabId) {
  const n = pageCounts.get(tabId) || 0;
  const text = n === 0 ? '' : (n > 999 ? '999+' : String(n));
  chrome.action.setBadgeText({ text, tabId }, () => void chrome.runtime.lastError);
  if (text) {
    chrome.action.setBadgeBackgroundColor({ color: '#00FF88', tabId },
      () => void chrome.runtime.lastError);
  }
}

// ── Mensajes ─────────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!sender || sender.id !== chrome.runtime.id) return;
  if (typeof msg !== 'object' || msg === null) return;
  if (!VALID_MSG_TYPES.has(msg.type)) return;

  const tabId = sender.tab && sender.tab.id;

  if (msg.type === 'DL_DECISION' || msg.type === 'DL_LIST') {
    // Solo desde una pestaña real (script de contenido) o desde el popup de la extensión.
    const desdePopup = typeof sender.url === 'string' && sender.url.startsWith(chrome.runtime.getURL('popup.html'));
    if (tabId === undefined && !desdePopup) return;
    if (msg.type === 'DL_LIST') {
      hidratar(() => {
        const vivas = [...retenidas.values()].filter(r => !r.decidida);
        // Si lo pide una página, esa página mostrará el aviso: que se cierre allí al decidir.
        if (tabId !== undefined) vivas.forEach(r => r.tabs.add(tabId));
        sendResponse({ lista: vivas.map(r => ({ id: r.gid, nombre: r.nombre, detalle: r.detalle, estado: r.estado, origen: r.origen || '' })) });
      });
      return true;   // respuesta asíncrona
    }
    if (typeof msg.id !== 'string') return;
    soltar(msg.id, msg.permitir === true);
    return;
  }

  if (msg.type === 'BLOCKED') {
    const delta = msg.delta;
    if (typeof delta !== 'number' || !Number.isFinite(delta) ||
        delta <= 0 || delta > 10000) return;
    addToTotal(delta);
    if (tabId !== undefined) {
      pageCounts.set(tabId, (pageCounts.get(tabId) || 0) + delta);
      paintBadge(tabId);
    }
    return;
  }

  if (msg.type === 'COOKIE_BLOCKED') {
    addToTotal(1);
    if (tabId !== undefined) {
      pageCounts.set(tabId, (pageCounts.get(tabId) || 0) + 1);
      paintBadge(tabId);
    }
    chrome.storage.local.get(['cookiesBlocked'], (data) => {
      chrome.storage.local.set({ cookiesBlocked: (data.cookiesBlocked || 0) + 1 });
    });
    return;
  }

  // El content script avisa de cada clic real. Sirve para distinguir la
  // descarga que ha pedido el usuario de la que arranca sola.
  if (msg.type === 'GESTURE') {
    if (tabId !== undefined) lastGesture.set(tabId, Date.now());
    return;
  }

  if (msg.type === 'GUARD_BLOCKED') {
    addToTotal(1);
    if (tabId !== undefined) {
      pageCounts.set(tabId, (pageCounts.get(tabId) || 0) + 1);
      paintBadge(tabId);
    }
    chrome.storage.local.get(['redirectsBlocked'], (data) => {
      chrome.storage.local.set({ redirectsBlocked: (data.redirectsBlocked || 0) + 1 });
    });
    return;
  }

  // El popup acaba de importar ajustes: hay que levantar las reglas de red.
  if (msg.type === 'SYNC_RULES') { syncSiteRules(); return; }

  if (msg.type === 'GET_STATS') {
    const wanted = typeof msg.tabId === 'number' ? msg.tabId : null;
    chrome.storage.local.get(
      ['blockedTotal', 'cookiesBlocked', 'redirectsBlocked', 'enabled',
       'ytAdBlock', 'guardEnabled', 'downloadGuard', 'antiAdblockWalls',
       'siteExcluded'],
      (data) => {
        const excluded = Array.isArray(data.siteExcluded) ? data.siteExcluded : [];
        sendResponse({
          blockedTotal:     data.blockedTotal     || 0,
          cookiesBlocked:   data.cookiesBlocked   || 0,
          redirectsBlocked: data.redirectsBlocked || 0,
          enabled:          data.enabled       !== false,
          ytAdBlock:        data.ytAdBlock     !== false,
          guardEnabled:     data.guardEnabled  !== false,
          downloadGuard:    data.downloadGuard !== false,
          antiAdblockWalls: data.antiAdblockWalls !== false,
          pageCount:        wanted !== null ? (pageCounts.get(wanted) || 0) : 0,
          siteExcluded:     excluded
        });
      });
    return true; // respuesta asíncrona
  }

  if (msg.type === 'SET_SITE') {
    const host = normalizeHost(msg.host);
    if (!host || typeof msg.excluded !== 'boolean') return;
    chrome.storage.local.get(['siteExcluded'], (data) => {
      const list = new Set(Array.isArray(data.siteExcluded) ? data.siteExcluded : []);
      if (msg.excluded) list.add(host); else list.delete(host);
      chrome.storage.local.set({ siteExcluded: [...list] }, () => {
        syncSiteRules();
        sendResponse({ ok: true, siteExcluded: [...list] });
      });
    });
    return true;
  }

  if (msg.type === 'RESET_STATS') {
    pageCounts.clear();
    pendingTotal = 0;
    chrome.storage.local.set(
      { blockedTotal: 0, cookiesBlocked: 0, redirectsBlocked: 0 },
      () => sendResponse({ ok: true }));
    return true;
  }
});

// ── Descargas que el usuario no ha pedido ────────────────────────────────────
// Una descarga que arranca sin que hayas tocado nada en los últimos segundos es
// el patrón de las webs que te cuelan un .exe al entrar. Se pausa y se pregunta.
const lastGesture = new Map();   // tabId -> instante del último clic real
// Un botón "Descargar" suele esperar al servidor (generar el fichero, abrir la
// pestaña de descarga) antes de que arranque: 4 s dejaba pausadas descargas que
// el usuario sí había pedido.
const GESTURE_WINDOW = 20000;    // ms que se considera "lo ha pedido el usuario"
const pendingDownloads = new Map();   // notificationId -> downloadId

// chrome.downloads.DownloadItem NO tiene tabId (el simulacro de los tests lo
// inventaba, y por eso la vigilancia no actuaba jamás en Chrome real: cada
// descarga parecía "pedida por ti"). La pestaña de origen se deduce del referrer.
function originOf(url) {
  try { return new URL(url).origin; } catch (_) { return ''; }
}

function pestanasDeOrigen(item, tabs) {
  if (typeof item.tabId === 'number' && item.tabId >= 0) return [item.tabId];
  const ref = item.referrer || '';
  if (!ref) return [];
  const origen = originOf(ref);
  return tabs.filter(t => t.url && (t.url === ref || (origen && originOf(t.url) === origen)))
             .map(t => t.id);
}

function askedByUser(item, tabs) {
  // Lo que entrega la propia ShieldX tras pulsar Permitir.
  if (nombreEntrega(item)) return true;
  if (item.byExtensionId === chrome.runtime.id) return true;
  // Un archivo local (file://) nunca es una descarga que llegue de fuera.
  if (/^file:/i.test(item.finalUrl || item.url || '')) return true;
  // Otra extensión (gestor de descargas, exportador…) la pide a propósito.
  if (item.byExtensionId) return true;
  // Sin pestaña asociada (Guardar como… de la propia interfaz de Chrome).
  if (typeof item.tabId === 'number' && item.tabId < 0) return true;

  const reciente = (t) => t && Date.now() - t < GESTURE_WINDOW;

  // Descarga generada por la propia página (blob:): la URL lleva el dominio de
  // quien la creó. Solo vale un clic real en una pestaña de ESE dominio; si no
  // hay ninguna abierta, no hay quien la haya pedido.
  const u = item.finalUrl || item.url || '';
  if (u.startsWith('blob:')) {
    const dueno = originOf(u);
    const delDueno = (tabs || []).filter(t => t.url && originOf(t.url) === dueno).map(t => t.id);
    return delDueno.some(id => reciente(lastGesture.get(id)));
  }

  const candidatas = pestanasDeOrigen(item, tabs || []);
  // El clic tiene que ser en la pestaña de la que sale la descarga: un clic en
  // otra pestaña no autoriza lo que una pestaña de fondo se descarga sola.
  if (candidatas.length) return candidatas.some(id => reciente(lastGesture.get(id)));
  // Sin referrer: vale solo un clic reciente en una pestaña del MISMO sitio que la
  // descarga. Antes valía un clic en cualquier pestaña, y así una página de fondo
  // colaba descargas mientras el usuario hacía clic en otra.
  const sitio = originOf(item.finalUrl || item.url || '');
  if (!sitio) return false;
  const delSitio = (tabs || []).filter(t => t.url && originOf(t.url) === sitio).map(t => t.id);
  return delSitio.some(id => reciente(lastGesture.get(id)));
}

function describe(item) {
  let origen = '';
  try { const u = new URL(item.finalUrl || item.url || ''); origen = u.hostname || (u.protocol === 'blob:' ? new URL(u.pathname).hostname : ''); } catch (_) {}
  const nombre = (item.filename || '').split(/[\\/]/).pop() || '(sin nombre)';
  const tam = item.fileSize > 0
    ? ` · ${(item.fileSize / 1048576).toFixed(1)} MB`
    : '';
  return { nombre, cuerpo: `${nombre}${tam}\nDesde: ${origen || 'origen desconocido'}` };
}

// Registro de diagnóstico (últimas 50) y filtros contra avisos por descargas
// que no son nuevas ni distintas.

const dlLogMem = [];
function registrar(item, motivo) {
  dlLogMem.push({ t: new Date().toISOString(), motivo, id: item.id, start: item.startTime,
    url: (item.finalUrl || item.url || '').slice(0, 200), ref: (item.referrer || '').slice(0, 200),
    file: item.filename, ext: item.byExtensionId, estado: item.state });
  if (dlLogMem.length > 50) dlLogMem.shift();
  chrome.storage.local.set({ dlLog: dlLogMem });
}

// ── Guardián de descargas ────────────────────────────────────────────────────
// Una descarga que el usuario no pidió se deja bajar UNA vez a una carpeta de
// cuarentena (Descargas\ShieldX-cuarentena\nombre.ext.bloqueado). El programa
// auxiliar (ShieldX Guard, native messaging) vigila el archivo temporal mientras
// Chrome lo escribe y lo DESORDENA en vivo: nunca llega entero y utilizable a
// disco. Al confirmar, lo restaura y lo entrega; al rechazar, lo borra.
// Sin el auxiliar, queda el nombre inerte .bloqueado y la entrega por file://.
const retenidas = new Map();     // gid -> { gid, dlId, nombre, detalle, cuerpo, tabs, notifId, timer, estado, pendiente }
const porDescarga = new Map();   // id de Chrome -> gid
const esperando = new Map();     // id de Chrome -> callback cuando termine
const CUARENTENA = 'ShieldX-temp';   // subcarpeta (oculta) de la carpeta de descargas de Chrome: solo mientras baja
const SUFIJO = '.bloqueado';
const RETENCION_MAX = 24 * 60 * 60 * 1000;   // un día: luego se rechaza solo
const HOST_GUARDIA = 'com.shieldx.guard';
let keepAlive = null;

// ── Conexión con el programa auxiliar ────────────────────────────────────────
let puerto = null;
let rid = 0;
const respuestas = new Map();

function conectarGuardia() {
  if (puerto) return puerto;
  try {
    puerto = chrome.runtime.connectNative(HOST_GUARDIA);
  } catch (_) { puerto = null; return null; }
  puerto.onMessage.addListener((m) => {
    const cb = respuestas.get(m && m.rid);
    if (cb) { respuestas.delete(m.rid); cb(m); }
  });
  puerto.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    puerto = null;
    for (const [, cb] of respuestas) cb({ ok: false, error: 'auxiliar desconectado' });
    respuestas.clear();
 
    setTimeout(() => conectarGuardia(), 500);   // se reconecta solo: que esté siempre en marcha
  });
  return puerto;
}

function guardia(msg, cb) {
  const p = conectarGuardia();

  if (!p) { cb({ ok: false, error: 'sin auxiliar' }); return; }
  const n = ++rid;
  const t = setTimeout(() => { if (respuestas.delete(n)) cb({ ok: false, error: 'sin respuesta' }); }, 15000);
  respuestas.set(n, (m) => { clearTimeout(t); cb(m); });
  try { p.postMessage(Object.assign({}, msg, { rid: n })); }
  catch (e) { clearTimeout(t); respuestas.delete(n); cb({ ok: false, error: String(e) }); }
}

// Se conecta ya, al arrancar el service worker: así el auxiliar está en marcha
// (y vigilando) antes de que llegue la primera descarga.
conectarGuardia();

// ── Burbuja de descargas de Chrome ───────────────────────────────────────────
// Oculta por defecto: así una descarga no pedida no llega a animarse (Chrome la
// pinta al crearla, antes de que ShieldX decida). Se muestra solo para lo que el
// usuario sí pidió y se vuelve a ocultar al rato.
let uiTimer = null;
let uiError = '';
function uiDescargas(visible) {
  // Nunca debe poder romper el guardián: cualquier fallo se anota y se sigue.
  try {
    if (!chrome.downloads.setUiOptions) { uiError = 'setUiOptions no disponible'; return; }
    chrome.downloads.setUiOptions({ enabled: visible }, () => {
      if (chrome.runtime.lastError) uiError = chrome.runtime.lastError.message;
    });
  } catch (e) { uiError = String(e && e.message || e); }
}
function uiMostrarUnRato() {
  uiDescargas(true);
  clearTimeout(uiTimer);
  uiTimer = setTimeout(() => uiDescargas(false), 8000);
}
chrome.storage.local.get(['enabled', 'downloadGuard'], (d) => {
  uiDescargas(d.enabled === false || d.downloadGuard === false);
});

function mantenerVivo() {
  if (retenidas.size && !keepAlive) {
    // Un service worker MV3 se duerme a los ~30 s: sin esto perdería la decisión.
    keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(() => void chrome.runtime.lastError), 20000);
  } else if (!retenidas.size && keepAlive) {
    clearInterval(keepAlive); keepAlive = null;
  }
}

// Mensaje corto dentro de la página activa; si no hay ninguna que lo admita, del sistema.
function avisoFallo(texto) {
  const sistema = () => chrome.notifications.create({
    type: 'basic', iconUrl: 'icons/icon128.png', title: 'ShieldX', message: texto,
  }, () => void chrome.runtime.lastError);
  chrome.tabs.query({ active: true, lastFocusedWindow: true }, (activas) => {
    void chrome.runtime.lastError;
    const tab = (activas || [])[0];
    if (!tab || tab.id === undefined) { sistema(); return; }
    chrome.tabs.sendMessage(tab.id, { type: 'DL_TOAST', texto }, (resp) => {
      if (chrome.runtime.lastError || !resp || !resp.ok) sistema();
    });
  });
}

// Llama a cb(item) cuando la descarga ha terminado (o cb(null) si se interrumpió).
function cuandoCompleta(id, cb) {
  chrome.downloads.search({ id }, (res) => {
    void chrome.runtime.lastError;
    const it = res && res[0];
    if (!it || it.state === 'interrupted') { cb(null); return; }
    if (it.state === 'complete') { cb(it); return; }
    esperando.set(id, cb);
  });
}

chrome.downloads.onChanged.addListener((d) => {
  if (porDescarga.has(d.id) && (d.error || d.state || d.filename)) {
    registrar({ id: d.id, filename: d.filename && d.filename.current, state: d.state && d.state.current },
      'cambio: ' + JSON.stringify({ error: d.error && d.error.current, state: d.state && d.state.current, filename: d.filename && d.filename.current }));
  }
  // Chrome acaba de fijar la ruta real: el auxiliar vigila ESA carpeta (sea cual sea
  // la carpeta de descargas de Chrome), antes de que el archivo crezca.
  if (d.filename && d.filename.current && porDescarga.has(d.id)) {
    const ruta = d.filename.current;
    const dir = ruta.slice(0, Math.max(ruta.lastIndexOf('\\'), ruta.lastIndexOf('/')));
    if (dir) guardia({ cmd: 'vigilar', dir }, () => {});
  }
  if (!d.state) return;
  if (d.state.current === 'complete') alCompletar(d.id);
  const cb = esperando.get(d.id);
  if (!cb) return;
  if (d.state.current === 'complete') {
    esperando.delete(d.id);
    chrome.downloads.search({ id: d.id }, (res) => { void chrome.runtime.lastError; cb((res && res[0]) || null); });
  } else if (d.state.current === 'interrupted') {
    esperando.delete(d.id);
    cb(null);
  }
});

function borrarDescarga(id) {
  chrome.downloads.cancel(id, () => {
    void chrome.runtime.lastError;
    chrome.downloads.removeFile(id, () => {
      void chrome.runtime.lastError;
      chrome.downloads.erase({ id }, () => void chrome.runtime.lastError);
    });
  });
}

// Entregas propias: al pulsar Permitir, ShieldX crea una descarga nueva desde el
// archivo restaurado. El guardián NO debe tomarla por una descarga no pedida.
const entregando = new Map();   // url normalizada -> nombre real con el que entregarla
function claveUrl(u) {
  try { return decodeURIComponent(String(u || '')).split('\\').join('/').toLowerCase(); } catch (_) { return String(u || '').toLowerCase(); }
}
function nombreEntrega(item) {
  if (typeof entregando === 'undefined') return null;
  return entregando.get(claveUrl(item.url)) || entregando.get(claveUrl(item.finalUrl)) || null;
}
function descargarPropia(url, nombre, cb) {
  const k = claveUrl(url);
  entregando.set(k, nombre);
  setTimeout(() => entregando.delete(k), 120000);
  chrome.downloads.download({ url, filename: nombre, conflictAction: 'uniquify' }, cb);
}

function aUrlArchivo(ruta) {
  return 'file:///' + ruta.replace(/\\/g, '/').split('/')
    .map((s, i) => (i === 0 ? s : encodeURIComponent(s))).join('/');
}

// Chrome acaba de terminar la descarga: el auxiliar remata el desordenado (lo que
// faltaba: el final del archivo) y se oculta de la lista de descargas de Chrome.
function alCompletar(dlId) {
  const gid = porDescarga.get(dlId);
  const r = gid && retenidas.get(gid);
  if (!r || r.estado !== 'bajando') return;
  r.estado = 'desordenando';
  chrome.downloads.search({ id: dlId }, (res) => {
    void chrome.runtime.lastError;
    const it = res && res[0];
    const terminar = (ok) => {
      r.estado = ok ? 'desordenado' : 'sinauxiliar';
      porDescarga.delete(dlId);
      if (ok) chrome.downloads.erase({ id: dlId }, () => void chrome.runtime.lastError);
      if (r.pendiente) {
        const que = r.pendiente; r.pendiente = null;
        retenidas.delete(r.gid); mantenerVivo();
        ejecutar(r, que === 'permitir');
      }
    };
    if (!it || !it.filename) { terminar(false); return; }
    guardia({ cmd: 'desordenar', id: r.gid, path: it.filename, nombre: r.nombre }, (m) => terminar(!!(m && m.ok)));
  });
}

// ── Entrega ────────────────────────────────────────────────────────────────
// Con el auxiliar: restaurar; copiar con su nombre real para que aparezca como
// una descarga de Chrome (necesita "Permitir acceso a URL de archivo"); si no se
// puede, el auxiliar lo mueve a Descargas.
function entregarGuardia(r) {
  // El auxiliar lo deja con su nombre real: Chrome no deja renombrar una descarga
  // file://, así que el nombre bueno tiene que ir ya en la propia URL.
  guardia({ cmd: 'restaurar', id: r.gid, nombre: r.nombre }, (m) => {
    if (!m || !m.ok) { avisoFallo('No se pudo restaurar el archivo: ' + ((m && m.error) || 'sin respuesta')); return; }
    const moverDirecto = () => guardia({ cmd: 'mover', id: r.gid, nombre: r.nombre }, (x) => {
      avisoFallo(x && x.ok ? 'Entregado en Descargas: ' + x.nombre : 'No se pudo entregar: ' + ((x && x.error) || ''));
    });
    descargarPropia(aUrlArchivo(m.path), r.nombre, (nuevoId) => {
      if (chrome.runtime.lastError || nuevoId === undefined) { void chrome.runtime.lastError; moverDirecto(); return; }
      cuandoCompleta(nuevoId, (ok) => {
        if (!ok) { borrarDescarga(nuevoId); moverDirecto(); return; }
        guardia({ cmd: 'borrar', id: r.gid }, () => {});   // la copia buena ya está entregada
      });
    });
  });
}

// Sin auxiliar: el archivo está en cuarentena con nombre inerte y registrado en Chrome.
function entregarSinGuardia(r) {
  const quedaEnCuarentena = () => {
    chrome.downloads.show(r.dlId);
    avisoFallo('Se ha dejado en Descargas\\' + CUARENTENA + ' como "' + r.nombre + SUFIJO + '". Quítale "' + SUFIJO + '" para usarlo.');
  };
  cuandoCompleta(r.dlId, (it) => {
    if (!it || !it.filename) { avisoFallo('La descarga no llegó a completarse.'); return; }
    descargarPropia(aUrlArchivo(it.filename), r.nombre, (nuevoId) => {
      if (chrome.runtime.lastError || nuevoId === undefined) { void chrome.runtime.lastError; quedaEnCuarentena(); return; }
      cuandoCompleta(nuevoId, (ok) => {
        if (!ok) { borrarDescarga(nuevoId); quedaEnCuarentena(); return; }
        borrarDescarga(r.dlId);
      });
    });
  });
}

function ejecutar(r, permitir) {
  if (r.estado === 'sinauxiliar') {
    if (permitir) entregarSinGuardia(r); else borrarDescarga(r.dlId);
    return;
  }
  if (permitir) entregarGuardia(r);
  else guardia({ cmd: 'borrar', id: r.gid }, () => {});
}

function soltar(gid, permitir) {
  const r = retenidas.get(gid);
  if (!r || r.decidida) return;
  r.decidida = true;
  clearTimeout(r.timer);
  for (const t of r.tabs) chrome.tabs.sendMessage(t, { type: 'DL_CLOSE', id: gid }, () => void chrome.runtime.lastError);
  if (r.notifId) { pendingDownloads.delete(r.notifId); chrome.notifications.clear(r.notifId); }
  r.tabs.clear();
  if (r.estado === 'bajando') {
    // Aún está bajando: rechazar = cancelar ya; permitir = se ejecuta al terminar.
    if (!permitir) {
      retenidas.delete(gid); porDescarga.delete(r.dlId); mantenerVivo();
      borrarDescarga(r.dlId);
      guardia({ cmd: 'borrar', id: gid }, () => {});
    } else {
      r.pendiente = 'permitir';
    }
    return;
  }
  if (r.estado === 'desordenando') { r.pendiente = permitir ? 'permitir' : 'rechazar'; return; }
  retenidas.delete(gid); mantenerVivo();
  ejecutar(r, permitir);
}

// Recupera de disco las descargas que quedaron pendientes (Chrome cerrado, PC apagado).
function hidratar(cb) {
  guardia({ cmd: 'listar' }, (m) => {
    if (m && m.ok) {
      for (const p of m.pendientes || []) {
        if (!p.desordenado || retenidas.has(p.id)) continue;
        retenidas.set(p.id, { gid: p.id, dlId: null, nombre: p.nombre || 'archivo', detalle: 'Bloqueada anteriormente',
          cuerpo: '', tabs: new Set(), notifId: null, timer: null, estado: 'desordenado', pendiente: null });
      }
      mantenerVivo();
    }
    if (cb) cb();
  });
}
setTimeout(() => hidratar(), 1500);

// Muestra el aviso dentro de la pestaña activa (recuadro en la página). Si esa
// pestaña no admite scripts (chrome://, tienda…), cae a una notificación del
// sistema para no dejar la descarga sin pregunta.
function mostrarAviso(downloadId, intento = 0) {
  const r = retenidas.get(downloadId);
  if (!r || r.decidida || r.tabs.size) return;
  const caer = () => {
    if (!retenidas.has(downloadId) || r.notifId || r.tabs.size) return;
    chrome.notifications.create({
      type: 'basic', iconUrl: 'icons/icon128.png',
      title: 'ShieldX ha bloqueado una descarga que no pediste',
      message: r.cuerpo, requireInteraction: true,
      buttons: [{ title: 'Permitir' }, { title: 'Cancelar y borrar' }]
    }, (nid) => {
      if (chrome.runtime.lastError || !nid) return;   // sigue en "Descargas pendientes" del panel
      r.notifId = nid;
      pendingDownloads.set(nid, downloadId);
    });
  };
  // Orden: la pestaña de donde salió la descarga, la activa de la ventana en uso,
  // y las activas del resto de ventanas. Solo si ninguna página lo admite, aviso del sistema.
  chrome.tabs.query({}, (todas) => {
    void chrome.runtime.lastError;
    todas = todas || [];
    chrome.windows.getLastFocused({}, (win) => {
      void chrome.runtime.lastError;
      const winId = win && win.id;
      const web = (t) => t && t.id !== undefined && /^(https?|file):/i.test(t.url || '');
      const orden = [];
      const meter = (t) => { if (web(t) && !orden.some(x => x.id === t.id)) orden.push(t); };
      todas.filter(t => r.origen && originOf(t.url || '') === r.origen).sort((x, y) => (y.active - x.active)).forEach(meter);
      todas.filter(t => t.active && t.windowId === winId).forEach(meter);
      todas.filter(t => t.active).forEach(meter);
      if (intento >= 3) todas.forEach(meter);   // ya en los últimos intentos: cualquier pestaña web
      // Chrome no dice de qué pestaña salió una descarga por navegación: se muestra
      // en TODAS las del mismo sitio y en la que estás mirando. Al decidir en una,
      // se cierra en todas (DL_CLOSE a r.tabs).
      let pendientes = orden.length;
      const fin = () => {
        if (--pendientes > 0) return;
        if (r.tabs.size || r.decidida || !retenidas.has(downloadId)) return;
        // Nadie lo admitió (pestaña a mitad de navegación, páginas de Chrome…): reintento.
        if (intento < 5) setTimeout(() => mostrarAviso(downloadId, intento + 1), 600);
        else caer();
      };
      if (!orden.length) { pendientes = 1; fin(); return; }
      for (const tab of orden) {
        chrome.tabs.sendMessage(tab.id, { type: 'DL_PROMPT', id: downloadId, nombre: r.nombre, detalle: r.detalle, origen: r.origen || '' }, (resp) => {
          if (!chrome.runtime.lastError && resp && resp.ok) r.tabs.add(tab.id);
          void chrome.runtime.lastError;
          fin();
        });
      }
    });
  });
}

chrome.tabs.onActivated.addListener(({ tabId }) => {
  for (const [id, r] of retenidas) {
    if (r.tabs.has(tabId) || r.notifId) continue;
    chrome.tabs.sendMessage(tabId, { type: 'DL_PROMPT', id, nombre: r.nombre, detalle: r.detalle, origen: r.origen || '' }, (resp) => {
      if (chrome.runtime.lastError || !resp || !resp.ok) return;
      r.tabs.add(tabId);
    });
  }
});

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  chrome.storage.local.get(['enabled', 'downloadGuard'], (data) => {
    if (data.enabled === false || data.downloadGuard === false) {
      const propia = nombreEntrega(item);
      if (propia) suggest({ filename: propia, conflictAction: 'uniquify' }); else suggest();
      return;
    }
    chrome.tabs.query({}, (tabs) => {
      void chrome.runtime.lastError;
      try {
        decidirDescarga(item, suggest, tabs);
      } catch (e) {
        // Un fallo interno nunca debe dejar pasar la descarga: a la carpeta virtual.
        registrar(item, 'ERROR del guardián: ' + String(e && e.stack || e).slice(0, 300));
        try { suggest({ filename: CUARENTENA + '/' + describe(item).nombre.replace(/[\\/:*?"<>|]/g, '_'), conflictAction: 'uniquify' }); } catch (_) {}
      }
    });
  });
  return true;   // respuesta asíncrona: suggest() se llama arriba
});

function decidirDescarga(item, suggest, tabs) {
  {
    {
      const pedida = askedByUser(item, tabs);
      const edades = [...lastGesture.entries()].map(([t, ts]) => t + ':' + Math.round((Date.now() - ts) / 1000) + 's').join(',');
      registrar(item, 'entrada: pedidaPorUsuario=' + pedida + ' gestos=[' + edades + ']');
      const propia = nombreEntrega(item);
      if (propia) registrar(item, 'entrega propia: ' + propia);
      if (propia) { uiMostrarUnRato(); suggest({ filename: propia, conflictAction: 'uniquify' }); return; }
      if (pedida) { uiMostrarUnRato(); suggest(); return; }
      clearTimeout(uiTimer); uiDescargas(false);   // por si estaba visible: que esta no se anime

      // No la pidió el usuario: baja una sola vez, a cuarentena y con nombre inerte;
      // el auxiliar empieza a vigilar la carpeta ANTES de que Chrome escriba nada.
      const d = describe(item);
      const seguro = d.nombre.replace(/[\\/:*?"<>|]/g, '_');
      guardia({ cmd: 'vigilar' }, () => {});   // el auxiliar sabe cuál es la carpeta Descargas
      // Chrome cambiaría una extensión inventada por la del tipo real: el nombre se deja tal cual,
      // lo inutilizable es el contenido (lo desordena el auxiliar mientras baja).
      suggest({ filename: CUARENTENA + '/' + seguro, conflictAction: 'uniquify' });
      registrar(item, 'a cuarentena' + (uiError ? ' (burbuja: ' + uiError + ')' : ''));

      const gid = item.id + '-' + Date.now();
      const timer = setTimeout(() => soltar(gid, false), RETENCION_MAX);
      retenidas.set(gid, { gid, dlId: item.id, nombre: seguro, detalle: d.cuerpo.split('\n').slice(1).join('\n'),
        cuerpo: d.cuerpo, tabs: new Set(), notifId: null, timer, estado: 'bajando', pendiente: null,
        origen: originOf(item.referrer || '') || originOf((item.finalUrl || item.url || '').replace(/^blob:/, '')) });
      porDescarga.set(item.id, gid);
      mantenerVivo();
      mostrarAviso(gid);
    }
  }
}

chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
  const downloadId = pendingDownloads.get(notificationId);
  if (downloadId === undefined) return;
  pendingDownloads.delete(notificationId);
  soltar(downloadId, buttonIndex === 0);
  chrome.notifications.clear(notificationId);
});

// Cerrar la notificación sin elegir deja la descarga cancelada: es la opción
// segura para algo que no se pidió.
chrome.notifications.onClosed.addListener((notificationId) => {
  const downloadId = pendingDownloads.get(notificationId);
  if (downloadId === undefined) return;
  pendingDownloads.delete(notificationId);
  soltar(downloadId, false);
});

// ── Ciclo de vida de las pestañas ────────────────────────────────────────────
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // Nueva navegación: el contador "esta página" empieza de cero.
  if (changeInfo.status === 'loading' && changeInfo.url !== undefined) {
    pageCounts.set(tabId, 0);
    paintBadge(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  pageCounts.delete(tabId);
});
