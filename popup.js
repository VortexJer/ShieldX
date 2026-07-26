// ShieldX Popup Script v3 – con toggle YouTube

const toggle     = document.getElementById('masterToggle');
const statusText = document.getElementById('stText');
const statusDot  = document.getElementById('stDot');
const statusSub  = document.getElementById('stSub');
const sessionCount = document.getElementById('sessionCount');
const totalCount   = document.getElementById('totalCount');
const cookieCount  = document.getElementById('cookieCount');
const resetBtn     = document.getElementById('resetBtn');
const ytToggle     = document.getElementById('ytToggle');
const ytStatus     = document.getElementById('ytStatus');

function updateUI(enabled) {
  if (enabled) {
    statusText.textContent = 'ACTIVO';
    statusText.className   = 'st-text on';
    statusDot.className    = 'st-dot on';
    statusSub.textContent  = 'Protección completa';
  } else {
    statusText.textContent = 'PAUSADO';
    statusText.className   = 'st-text off';
    statusDot.className    = 'st-dot off';
    statusSub.textContent  = 'Haz clic para reactivar';
  }
}

function updateYTUI(enabled) {
  ytToggle.checked      = enabled;
  ytStatus.textContent  = enabled ? 'ACTIVO' : 'PAUSADO';
  ytStatus.className    = enabled ? 'yt-status on' : 'yt-status off';
}

function animateNumber(el, target) {
  const current = parseInt(el.textContent) || 0;
  if (current === target) return;
  const diff = target - current;
  const step = Math.max(1, Math.floor(Math.abs(diff) / 10));
  let val = current;
  const interval = setInterval(() => {
    val = diff > 0 ? Math.min(val + step, target) : Math.max(val - step, target);
    el.textContent = val;
    if (val === target) clearInterval(interval);
  }, 30);
}

// Cargar estado inicial
chrome.storage.local.get(['enabled', 'ytAdBlock', 'blockedTotal', 'blockedSession', 'cookiesBlocked'], (data) => {
  const enabled   = data.enabled !== false;
  const ytEnabled = data.ytAdBlock !== false;
  toggle.checked = enabled;
  updateUI(enabled);
  updateYTUI(ytEnabled);
  animateNumber(totalCount,   data.blockedTotal   || 0);
  animateNumber(sessionCount, data.blockedSession || 0);
  animateNumber(cookieCount,  data.cookiesBlocked || 0);
});

// Toggle principal
toggle.addEventListener('change', () => {
  const enabled = toggle.checked;
  chrome.storage.local.set({ enabled });
  updateUI(enabled);
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    tabs.forEach(tab => {
      chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE', enabled }).catch(() => {});
    });
  });
});

// Toggle YouTube
ytToggle.addEventListener('change', () => {
  const ytEnabled = ytToggle.checked;
  chrome.storage.local.set({ ytAdBlock: ytEnabled });
  updateYTUI(ytEnabled);
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    tabs.forEach(tab => {
      chrome.tabs.sendMessage(tab.id, { type: 'YT_TOGGLE', enabled: ytEnabled }).catch(() => {});
    });
  });
});

// Reset contador
resetBtn.addEventListener('click', () => {
  chrome.storage.local.set({ blockedTotal: 0, blockedSession: 0, cookiesBlocked: 0 });
  animateNumber(totalCount,   0);
  animateNumber(sessionCount, 0);
  animateNumber(cookieCount,  0);
});

// Actualizar en tiempo real
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'BLOCKED') animateNumber(sessionCount, msg.count);
  if (msg.type === 'COOKIE_BLOCKED') {
    chrome.storage.local.get(['cookiesBlocked'], (data) => {
      const n = (data.cookiesBlocked || 0) + 1;
      chrome.storage.local.set({ cookiesBlocked: n });
      animateNumber(cookieCount, n);
    });
  }
});

// Polling
setInterval(() => {
  chrome.storage.local.get(['blockedTotal', 'blockedSession', 'cookiesBlocked'], (data) => {
    animateNumber(totalCount,   data.blockedTotal   || 0);
    animateNumber(sessionCount, data.blockedSession || 0);
    animateNumber(cookieCount,  data.cookiesBlocked || 0);
  });
}, 1500);
