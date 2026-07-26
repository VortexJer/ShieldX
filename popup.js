// ShieldX Popup Script v4
// Cambios respecto a v3:
//  - Ya no escribe contadores: los llevaba también el content script y las
//    cookies rechazadas se contaban dos veces cuando el popup estaba abierto.
//  - animateNumber cancela la animación anterior del mismo número; con el
//    sondeo cada 1,5 s se solapaban varias y los dígitos parpadeaban.
//  - Los interruptores se propagan por storage.onChanged, así que afectan a
//    todas las pestañas y no sólo a la activa.
//  - Nuevo interruptor por sitio.

'use strict';

const el = (id) => document.getElementById(id);

const toggle       = el('masterToggle');
const statusText   = el('stText');
const statusDot    = el('stDot');
const statusSub    = el('stSub');
const sessionCount = el('sessionCount');
const totalCount   = el('totalCount');
const cookieCount  = el('cookieCount');
const resetBtn     = el('resetBtn');
const ytToggle     = el('ytToggle');
const ytStatus     = el('ytStatus');
const siteToggle   = el('siteToggle');
const siteStatus   = el('siteStatus');
const siteHostEl   = el('siteHost');
const guardToggle  = el('guardToggle');
const guardStatus  = el('guardStatus');
const dlToggle     = el('dlToggle');
const dlStatus     = el('dlStatus');
const redirectCount = el('redirectCount');

let currentTabId = null;
let currentHost  = '';

function normalizeHost(host) {
  return String(host || '').toLowerCase().replace(/^www\./, '').trim();
}

function updateUI(enabled) {
  statusText.textContent = enabled ? 'ACTIVO' : 'PAUSADO';
  statusText.className   = enabled ? 'st-text on' : 'st-text off';
  statusDot.className    = enabled ? 'st-dot on'  : 'st-dot off';
  statusSub.textContent  = enabled ? 'Protección completa' : 'Haz clic para reactivar';
}

function updateYTUI(enabled) {
  ytToggle.checked     = enabled;
  ytStatus.textContent = enabled ? 'ACTIVO' : 'PAUSADO';
  ytStatus.className   = enabled ? 'yt-status on' : 'yt-status off';
}

function updateSwitchUI(input, label, on) {
  input.checked     = on;
  label.textContent = on ? 'ACTIVO' : 'PAUSADO';
  label.className   = on ? 'yt-status on' : 'yt-status off';
}

function updateSiteUI(active) {
  siteToggle.checked     = active;
  siteStatus.textContent = active ? 'ACTIVO' : 'EXCLUIDO';
  siteStatus.className   = active ? 'yt-status on' : 'yt-status off';
}

// ── Contadores animados ──────────────────────────────────────────────────────
const timers = new WeakMap();

function animateNumber(node, target) {
  const previous = timers.get(node);
  if (previous) clearInterval(previous);   // sin esto se solapaban animaciones

  const current = parseInt(node.textContent, 10) || 0;
  if (current === target) return;

  const diff = target - current;
  const step = Math.max(1, Math.floor(Math.abs(diff) / 10));
  let val = current;

  const id = setInterval(() => {
    val = diff > 0 ? Math.min(val + step, target) : Math.max(val - step, target);
    node.textContent = val;
    if (val === target) { clearInterval(id); timers.delete(node); }
  }, 30);

  timers.set(node, id);
}

// ── Carga de estado ──────────────────────────────────────────────────────────
function refresh() {
  chrome.runtime.sendMessage({ type: 'GET_STATS', tabId: currentTabId }, (res) => {
    if (chrome.runtime.lastError || !res) return;
    toggle.checked = res.enabled;
    updateUI(res.enabled);
    updateYTUI(res.ytAdBlock);
    updateSwitchUI(guardToggle, guardStatus, res.guardEnabled);
    updateSwitchUI(dlToggle,    dlStatus,    res.downloadGuard);
    animateNumber(totalCount,    res.blockedTotal);
    animateNumber(sessionCount,  res.pageCount);
    animateNumber(cookieCount,   res.cookiesBlocked);
    animateNumber(redirectCount, res.redirectsBlocked);

    if (currentHost) {
      const excluded = (res.siteExcluded || []).some(d => {
        const p = normalizeHost(d);
        return currentHost === p || currentHost.endsWith('.' + p);
      });
      updateSiteUI(!excluded);
    }
  });
}

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const tab = tabs && tabs[0];
  if (tab) {
    currentTabId = tab.id;
    try {
      const url = new URL(tab.url || '');
      // En páginas internas de Chrome no hay nada que excluir.
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        currentHost = normalizeHost(url.hostname);
      }
    } catch (_) {}
  }

  if (currentHost) {
    siteHostEl.textContent = currentHost;
  } else {
    siteHostEl.textContent = 'no aplicable aquí';
    siteToggle.disabled = true;
    siteStatus.textContent = '—';
    siteStatus.className = 'yt-status';
  }

  refresh();
});

// ── Interruptores ────────────────────────────────────────────────────────────
// Los content scripts escuchan storage.onChanged, así que basta con escribir.
toggle.addEventListener('change', () => {
  const enabled = toggle.checked;
  chrome.storage.local.set({ enabled });
  updateUI(enabled);
});

ytToggle.addEventListener('change', () => {
  const ytAdBlock = ytToggle.checked;
  chrome.storage.local.set({ ytAdBlock });
  updateYTUI(ytAdBlock);
});

siteToggle.addEventListener('change', () => {
  if (!currentHost) return;
  const active = siteToggle.checked;
  updateSiteUI(active);
  chrome.runtime.sendMessage(
    { type: 'SET_SITE', host: currentHost, excluded: !active },
    () => {
      void chrome.runtime.lastError;
      // La capa de red actúa sobre peticiones ya resueltas: sin recargar, el
      // cambio no se nota hasta la siguiente navegación.
      if (currentTabId !== null) chrome.tabs.reload(currentTabId);
    }
  );
});

guardToggle.addEventListener('change', () => {
  const on = guardToggle.checked;
  chrome.storage.local.set({ guardEnabled: on });
  updateSwitchUI(guardToggle, guardStatus, on);
});

dlToggle.addEventListener('change', () => {
  const on = dlToggle.checked;
  chrome.storage.local.set({ downloadGuard: on });
  updateSwitchUI(dlToggle, dlStatus, on);
});

resetBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'RESET_STATS' }, () => {
    void chrome.runtime.lastError;
    animateNumber(totalCount,    0);
    animateNumber(sessionCount,  0);
    animateNumber(cookieCount,   0);
    animateNumber(redirectCount, 0);
  });
});

// Sondeo mientras el popup está abierto
setInterval(refresh, 1500);
