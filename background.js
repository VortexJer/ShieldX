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
  'GESTURE', 'GUARD_BLOCKED', 'SYNC_RULES'
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
  });
});

chrome.runtime.onStartup.addListener(syncSiteRules);

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
const GESTURE_WINDOW = 4000;     // ms que se considera "lo ha pedido el usuario"
const pendingDownloads = new Map();   // notificationId -> downloadId

function askedByUser(item) {
  // Descargas iniciadas por la propia interfaz de Chrome (Guardar como…) o sin
  // pestaña asociada: no hay nada que vigilar.
  if (typeof item.tabId === 'number' && item.tabId >= 0) {
    const t = lastGesture.get(item.tabId);
    if (t && Date.now() - t < GESTURE_WINDOW) return true;
    return false;
  }
  return true;
}

function describe(item) {
  let origen = '';
  try { origen = new URL(item.finalUrl || item.url || '').hostname; } catch (_) {}
  const nombre = (item.filename || '').split(/[\\/]/).pop() || '(sin nombre)';
  const tam = item.fileSize > 0
    ? ` · ${(item.fileSize / 1048576).toFixed(1)} MB`
    : '';
  return { nombre, cuerpo: `${nombre}${tam}\nDesde: ${origen || 'origen desconocido'}` };
}

chrome.downloads.onCreated.addListener((item) => {
  chrome.storage.local.get(['enabled', 'downloadGuard'], (data) => {
    if (data.enabled === false || data.downloadGuard === false) return;
    if (item.state !== 'in_progress') return;
    if (askedByUser(item)) return;

    chrome.downloads.pause(item.id, () => {
      if (chrome.runtime.lastError) return;   // ya terminó o no se puede pausar

      const { cuerpo } = describe(item);
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: 'ShieldX ha parado una descarga que no pediste',
        message: cuerpo,
        requireInteraction: true,
        buttons: [{ title: 'Permitir' }, { title: 'Cancelar y borrar' }]
      }, (notificationId) => {
        if (chrome.runtime.lastError || !notificationId) {
          // Sin notificación no se puede preguntar: ante la duda, se cancela.
          chrome.downloads.cancel(item.id, () => void chrome.runtime.lastError);
          return;
        }
        pendingDownloads.set(notificationId, item.id);
      });
    });
  });
});

chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
  const downloadId = pendingDownloads.get(notificationId);
  if (downloadId === undefined) return;
  pendingDownloads.delete(notificationId);

  if (buttonIndex === 0) {
    chrome.downloads.resume(downloadId, () => void chrome.runtime.lastError);
  } else {
    chrome.downloads.cancel(downloadId, () => {
      void chrome.runtime.lastError;
      chrome.downloads.erase({ id: downloadId }, () => void chrome.runtime.lastError);
    });
  }
  chrome.notifications.clear(notificationId);
});

// Cerrar la notificación sin elegir deja la descarga cancelada: es la opción
// segura para algo que no se pidió.
chrome.notifications.onClosed.addListener((notificationId) => {
  const downloadId = pendingDownloads.get(notificationId);
  if (downloadId === undefined) return;
  pendingDownloads.delete(notificationId);
  chrome.downloads.cancel(downloadId, () => void chrome.runtime.lastError);
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
