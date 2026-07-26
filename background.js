// ShieldX Background Service Worker v3 – Hardened
// - Valida tipo y estructura de cada mensaje antes de procesarlo
// - No expone datos de otras pestañas
// - Sin eval, sin fetch externo, sin almacenamiento de URLs visitadas

'use strict';

const VALID_MSG_TYPES = new Set(['BLOCKED', 'COOKIE_BLOCKED', 'GET_STATS', 'YT_TOGGLE']);

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({
    enabled: true,
    ytAdBlock: true,
    blockedTotal: 0,
    blockedSession: 0,
    cookiesBlocked: 0,
    installedAt: Date.now()
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Validación estricta: solo mensajes de content scripts de esta extensión
  if (!sender || sender.id !== chrome.runtime.id) return;
  if (typeof msg !== 'object' || msg === null) return;
  if (!VALID_MSG_TYPES.has(msg.type)) return;

  if (msg.type === 'BLOCKED') {
    if (typeof msg.count !== 'number' || msg.count < 0 || msg.count > 100000) return;
    if (sender.tab && sender.tab.id) {
      const display = msg.count > 999 ? '999+' : String(msg.count);
      chrome.action.setBadgeText({ text: display, tabId: sender.tab.id });
      chrome.action.setBadgeBackgroundColor({ color: '#00FF88' });
    }
  }

  if (msg.type === 'GET_STATS') {
    chrome.storage.local.get(['blockedTotal', 'enabled', 'cookiesBlocked'], (data) => {
      sendResponse({
        blockedTotal: data.blockedTotal || 0,
        enabled: data.enabled !== false,
        cookiesBlocked: data.cookiesBlocked || 0
      });
    });
    return true; // mantener canal abierto para respuesta async
  }
});

// Limpiar badge al cambiar de pestaña (no filtramos info entre pestañas)
chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.action.setBadgeText({ text: '', tabId });
});
