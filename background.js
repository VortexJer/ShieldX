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
  'BLOCKED', 'COOKIE_BLOCKED', 'GET_STATS', 'SET_SITE', 'RESET_STATS'
]);

const DEFAULTS = {
  enabled: true,
  ytAdBlock: true,
  blockedTotal: 0,
  cookiesBlocked: 0,
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
  try { return normalizeHost(new URL(url).hostname); } catch (_) { return ''; }
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

  if (msg.type === 'GET_STATS') {
    const wanted = typeof msg.tabId === 'number' ? msg.tabId : null;
    chrome.storage.local.get(
      ['blockedTotal', 'cookiesBlocked', 'enabled', 'ytAdBlock', 'siteExcluded'],
      (data) => {
        const excluded = Array.isArray(data.siteExcluded) ? data.siteExcluded : [];
        sendResponse({
          blockedTotal:   data.blockedTotal   || 0,
          cookiesBlocked: data.cookiesBlocked || 0,
          enabled:        data.enabled  !== false,
          ytAdBlock:      data.ytAdBlock !== false,
          pageCount:      wanted !== null ? (pageCounts.get(wanted) || 0) : 0,
          siteExcluded:   excluded
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
    chrome.storage.local.set({ blockedTotal: 0, cookiesBlocked: 0 }, () => {
      sendResponse({ ok: true });
    });
    return true;
  }
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
