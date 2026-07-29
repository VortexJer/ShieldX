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
const pickBtn          = el('pickBtn');
const customRestoreBtn = el('customRestoreBtn');
const customCount      = el('customCount');
// Todas las referencias se cogen AQUÍ, antes de nada. refresh() se llama desde
// el callback de chrome.tabs.query, y si una const suya está declarada más
// abajo salta un ReferenceError que deja el popup en blanco al abrirlo.
const aabToggle        = el('aabToggle');
const aabStatus        = el('aabStatus');
const excludedBox      = el('excludedBox');
const excludedList     = el('excludedList');
const excludedCount    = el('excludedCount');
const exportBtn        = el('exportBtn');
const importBtn        = el('importBtn');
const importFile       = el('importFile');
const settingsDesc     = el('settingsDesc');

let currentTabId = null;
let currentHost  = '';

function normalizeHost(host) {
  return String(host || '').toLowerCase().replace(/^www\./, '').trim();
}

// Copia de la lista de content.js: los content scripts clásicos no comparten
// módulos con el popup. Si se toca una, hay que tocar la otra.
const MAIL_HOSTS = [
  'mail.google.com', 'inbox.google.com',
  'outlook.live.com', 'outlook.office.com', 'outlook.office365.com', 'outlook.com',
  'mail.yahoo.com', 'mail.proton.me', 'protonmail.com', 'mail.zoho.com',
  'mail.aol.com', 'icloud.com', 'mail.ru', 'gmx.com', 'gmx.net', 'web.de',
  'fastmail.com', 'zimbra.com', 'hey.com', 'tutanota.com', 'tuta.com',
];
const MAIL_PREFIX = /^(mail|webmail|correo|email|mbox|zimbra|roundcube|owa|imap)\./;

function isMailApp(host) {
  if (!host) return false;
  return MAIL_HOSTS.some(p => host === p || host.endsWith('.' + p)) || MAIL_PREFIX.test(host);
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
    updateSwitchUI(aabToggle,   aabStatus,   res.antiAdblockWalls);
    pintarExcluidos(res.siteExcluded || []);
    animateNumber(totalCount,    res.blockedTotal);
    animateNumber(sessionCount,  res.pageCount);
    animateNumber(cookieCount,   res.cookiesBlocked);
    animateNumber(redirectCount, res.redirectsBlocked);

    // En clientes de correo el estado lo fija la carga inicial y no se toca.
    if (currentHost && !isMailApp(currentHost)) {
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

  if (currentHost && isMailApp(currentHost)) {
    // En el correo la capa de ocultado no entra nunca, aunque el sitio no esté
    // excluido: el toggle no debe dar a entender lo contrario.
    siteHostEl.textContent = currentHost + ' · correo';
    siteToggle.disabled = true;
    siteStatus.textContent = 'SIN OCULTAR';
    siteStatus.className = 'yt-status';
  } else if (currentHost) {
    siteHostEl.textContent = currentHost;
  } else {
    siteHostEl.textContent = 'no aplicable aquí';
    siteToggle.disabled = true;
    siteStatus.textContent = '—';
    siteStatus.className = 'yt-status';
  }

  refresh();
  refreshCustom();
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

// ── Ocultar elemento (picker) ────────────────────────────────────────────────
function refreshCustom() {
  if (!currentHost) { pickBtn.disabled = true; return; }
  chrome.storage.local.get(['customHidden'], (d) => {
    const list = (d.customHidden && d.customHidden[currentHost]) || [];
    if (list.length) {
      customCount.textContent = list.length + (list.length === 1
        ? ' elemento oculto en este sitio' : ' elementos ocultos en este sitio');
      customRestoreBtn.style.display = '';
    } else {
      customCount.textContent = 'Señala en la página lo que quieras quitar';
      customRestoreBtn.style.display = 'none';
    }
  });
}

pickBtn.addEventListener('click', () => {
  if (currentTabId === null) return;
  chrome.tabs.sendMessage(currentTabId, { type: 'PICK_START' }, () => {
    void chrome.runtime.lastError;
    window.close();   // el popup estorba mientras se señala
  });
});

// ── Volver a mostrar el aviso de cookies ─────────────────────────────────────
// Hay sitios (Marca, por ejemplo) donde el único acceso a "Configuración de
// cookies" vive DENTRO del propio banner: al ocultarlo, el usuario se queda sin
// forma de responder si algún día quiere. Esto se lo devuelve, sin que ShieldX
// decida nada por él.
const cookieShowBtn = el('cookieShowBtn');
const cookieDesc    = el('cookieDesc');

cookieShowBtn.addEventListener('click', () => {
  if (currentTabId === null) return;
  chrome.tabs.sendMessage(currentTabId, { type: 'COOKIE_SHOW' }, (resp) => {
    void chrome.runtime.lastError;
    cookieDesc.textContent = (resp && resp.restaurados)
      ? 'Aviso restaurado en la página'
      : 'No había ningún aviso oculto aquí';
  });
});

customRestoreBtn.addEventListener('click', () => {
  chrome.storage.local.get(['customHidden'], (d) => {
    const map = d.customHidden && typeof d.customHidden === 'object' ? d.customHidden : {};
    delete map[currentHost];
    // storage.onChanged en el content script retira la hoja y lo restaura en vivo
    chrome.storage.local.set({ customHidden: map }, refreshCustom);
  });
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

// ── Muros de "desactiva el bloqueador" ───────────────────────────────────────
aabToggle.addEventListener('change', () => {
  const on = aabToggle.checked;
  chrome.storage.local.set({ antiAdblockWalls: on });
  updateSwitchUI(aabToggle, aabStatus, on);
});

// ── Sitios excluidos: verlos y quitarlos de uno en uno ───────────────────────
// Antes, para reactivar un sitio había que volver a visitarlo. Aquí está la
// lista entera con su botón al lado.
function pintarExcluidos(lista) {
  excludedList.textContent = '';   // sin innerHTML: la CSP del popup lo agradece
  if (!lista.length) { excludedBox.style.display = 'none'; return; }

  excludedBox.style.display = '';
  excludedCount.textContent = '(' + lista.length + ')';

  for (const host of lista.slice().sort()) {
    const fila = document.createElement('div');
    fila.className = 'cov-item';

    const izq = document.createElement('div');
    izq.className = 'cov-l';
    const nombre = document.createElement('span');
    nombre.className = 'cov-name';
    nombre.textContent = host;
    izq.appendChild(nombre);

    const quitar = document.createElement('button');
    quitar.className = 'reset-btn';
    quitar.textContent = 'REACTIVAR';
    quitar.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'SET_SITE', host, excluded: false }, (res) => {
        void chrome.runtime.lastError;
        pintarExcluidos((res && res.siteExcluded) || []);
        if (host === currentHost) updateSiteUI(true);
      });
    });

    fila.append(izq, quitar);
    excludedList.appendChild(fila);
  }
}

// ── Exportar / importar ajustes ──────────────────────────────────────────────
const CLAVES_AJUSTES = [
  'enabled', 'ytAdBlock', 'guardEnabled', 'downloadGuard', 'antiAdblockWalls',
  'siteExcluded', 'customHidden',
];

exportBtn.addEventListener('click', () => {
  chrome.storage.local.get(CLAVES_AJUSTES, (data) => {
    const texto = JSON.stringify({ shieldx: 1, ajustes: data }, null, 2);
    // Un blob local, sin salir del navegador ni pasar por ningún servidor.
    const url = URL.createObjectURL(new Blob([texto], { type: 'application/json' }));
    chrome.downloads.download({ url, filename: 'shieldx-ajustes.json', saveAs: true },
      () => {
        void chrome.runtime.lastError;
        settingsDesc.textContent = 'Ajustes guardados';
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      });
  });
});

importBtn.addEventListener('click', () => importFile.click());

importFile.addEventListener('change', () => {
  const fichero = importFile.files && importFile.files[0];
  if (!fichero) return;
  const lector = new FileReader();
  lector.onload = () => {
    let datos;
    try { datos = JSON.parse(String(lector.result)); }
    catch (_) { settingsDesc.textContent = 'Ese fichero no es de ShieldX'; return; }

    const ajustes = datos && datos.ajustes;
    if (!ajustes || typeof ajustes !== 'object') {
      settingsDesc.textContent = 'Ese fichero no es de ShieldX';
      return;
    }

    // Sólo se acepta lo conocido y con el tipo correcto: un fichero de fuera
    // no puede meter claves raras en el almacenamiento.
    const limpio = {};
    for (const k of ['enabled', 'ytAdBlock', 'guardEnabled', 'downloadGuard', 'antiAdblockWalls']) {
      if (typeof ajustes[k] === 'boolean') limpio[k] = ajustes[k];
    }
    if (Array.isArray(ajustes.siteExcluded)) {
      limpio.siteExcluded = ajustes.siteExcluded
        .filter(h => typeof h === 'string' && h.length < 254)
        .map(normalizeHost).filter(Boolean).slice(0, 500);
    }
    if (ajustes.customHidden && typeof ajustes.customHidden === 'object' &&
        !Array.isArray(ajustes.customHidden)) {
      const mapa = {};
      for (const [host, sels] of Object.entries(ajustes.customHidden)) {
        if (typeof host !== 'string' || !Array.isArray(sels)) continue;
        const validos = sels.filter(s => typeof s === 'string' && s.length < 400).slice(0, 200);
        if (validos.length) mapa[normalizeHost(host)] = validos;
      }
      limpio.customHidden = mapa;
    }

    if (!Object.keys(limpio).length) {
      settingsDesc.textContent = 'El fichero no traía nada aprovechable';
      return;
    }

    chrome.storage.local.set(limpio, () => {
      settingsDesc.textContent = 'Ajustes restaurados';
      // La capa de red se levanta desde el service worker.
      chrome.runtime.sendMessage({ type: 'SYNC_RULES' }, () => void chrome.runtime.lastError);
      refresh();
      refreshCustom();
      pintarExcluidos(limpio.siteExcluded || []);
    });
  };
  lector.readAsText(fichero);
});

// Sondeo mientras el popup está abierto
setInterval(refresh, 1500);
