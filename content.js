// ShieldX Content Script v6 – Full Turtlecute Coverage + YT toggle
'use strict';

const OWN_ORIGIN = chrome.runtime.id;
let blockedCount = 0;
let enabled = true;

// ── Propagar estado ytAdBlock a la MAIN world (donde corre youtube.js) ────
// youtube.js vive en world: MAIN y no puede acceder a chrome.storage,
// así que lo hacemos desde aquí (isolated world) con un script inline.
function propagateYTState(ytEnabled) {
  // Setear variable global para la carga inicial
  const s = document.createElement('script');
  s.textContent = `window.__shieldxYT = ${ytEnabled};`;
  (document.head || document.documentElement).appendChild(s);
  s.remove();
  // Enviar evento para actualizaciones en caliente
  window.dispatchEvent(new CustomEvent('__shieldx_yt_toggle', {
    detail: { enabled: ytEnabled }
  }));
}

chrome.storage.local.get(['enabled', 'ytAdBlock'], (data) => {
  enabled = data.enabled !== false;
  const ytEnabled = data.ytAdBlock !== false; // habilitado por defecto
  propagateYTState(ytEnabled);
  if (enabled) init();
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!sender || sender.id !== OWN_ORIGIN) return;
  if (typeof msg !== 'object' || msg === null) return;
  if (msg.type === 'TOGGLE' && typeof msg.enabled === 'boolean') {
    enabled = msg.enabled;
    if (enabled) init();
  }
  if (msg.type === 'YT_TOGGLE' && typeof msg.enabled === 'boolean') {
    propagateYTState(msg.enabled);
  }
});

// ── Exactamente los selectores CSS que testea turtlecute ─────────────────────
// La web verifica: .adbox, .banner_ads, .adsbox, .textads
const TURTLE_CSS = [
  '.adbox', '.banner_ads', '.adsbox', '.textads',
];

// ── Selectores generales amplios ─────────────────────────────────────────────
const GENERIC_SELECTORS = [
  // Google AdSense
  'ins.adsbygoogle','ins[data-ad-client]','ins[data-ad-slot]',
  'div[id*="google_ads"]','div[id*="google-ads"]',
  // iframes publicitarios
  'iframe[src*="doubleclick"]','iframe[src*="googlesyndication"]',
  'iframe[src*="adnxs"]','iframe[src*="taboola"]','iframe[src*="outbrain"]',
  'iframe[src*="criteo"]','iframe[src*="media.net"]',
  'iframe[id*="google_ads"]','iframe[id*="ad_"]',
  // IDs genéricos
  '#ad','#ads','#ad-top','#ad-bottom','#ad-left','#ad-right',
  '#ad-wrap','#ad-wrapper','#ad-container','#ad-header','#ad-footer',
  '#ads-top','#ads-bottom','#top-ad','#bottom-ad','#right-ad','#left-ad',
  '#sidebar-ad','#banner-ad','#leaderboard-ad','#rectangle-ad',
  '#ad_top','#ad_bottom','#ad_left','#ad_right','#ad_banner','#ad_box',
  '#ad_container','#ad_wrapper','#ad_unit','#ad_slot','#ad_frame',
  '#adsense','#adsense-top','#adsense-bottom',
  '#advertisement','#advertisement-top','#advertisement-bottom',
  '#sponsor','#sponsored','#sponsored-links',
  '#promo','#promo-top','#promo-box',
  // Clases genéricas
  '.ad','.ads','.ad-unit','.ad-slot','.ad-container','.ad-wrapper',
  '.ad-block','.ad-box','.ad-banner','.ad-top','.ad-bottom',
  '.ad-left','.ad-right','.ad-sidebar','.ad-header','.ad-footer',
  '.ad-zone','.ad-space','.ad-area','.ad-frame','.ad-inner',
  '.advertisement','.advertisement-top','.advertisement-bottom',
  '.advertising','.advertise','.advertorial',
  '.banner-ad','.banner-ads','.banner-advertisement',
  '.leaderboard-ad','.billboard-ad',
  '.sidebar-ad','.sidebar-ads',
  '.sponsored','.sponsored-content','.sponsored-links','.sponsored-post',
  '.sponsor','.sponsor-content','.sponsor-link','.sponsor-block',
  '.promo','.promo-ad','.promo-banner','.promo-box','.promotional',
  '.native-ad','.native-ads','.native-advertisement',
  '.text-ad','.text-ads',
  '.display-ad','.display-ads',
  '.adsense','.adsense-ad','.adsense-wrapper',
  '.advert','.adverts','.advert-banner','.advert-block',
  '.dfp-ad','.dfp-slot','.dfp-unit',
  '.sticky-ad','.sticky-ads','.fixed-ad','.floating-ad','.adhesion',
  // Redes nativas
  '[id*="taboola"]','[class*="taboola"]','.trc_rbox',
  '[id*="outbrain"]','[class*="outbrain"]','.OUTBRAIN',
  '[id*="criteo"]','[class*="criteo"]',
  '[id*="mgid"]','[class*="mgid"]',
  '[id*="revcontent"]','[class*="rc-widget"]',
  // Atributos de anuncio
  '[data-ad]','[data-ads]','[data-ad-unit]','[data-ad-slot]',
  '[data-ad-client]','[data-ad-type]','[data-ad-size]','[data-ad-id]',
  '[data-advertisement]','[data-sponsored]','[data-sponsor]',
  '[data-native-ad]','[data-dfp]','[data-gpt-ad]',
];

const GOOGLE_SELECTORS = [
  '[data-text-ad]','.uEierd','#tads','#tadsb','#bottomads','#tvcap',
  '.commercial-unit-desktop-top','.commercial-unit-desktop-rhs',
  '.commercial-unit-mobile-top','.commercial-unit-mobile-bottom',
  '.cu-container','.pla-unit','.mnr-c.pla-unit','.V3FYCf','.ads-ad',
  'div[aria-label="Ads"]','div[aria-label="Anuncios"]',
  'div[aria-label="Sponsored"]','div[aria-label="Patrocinados"]',
  '.shopping-carousel-container','#shop-carousel',
];

const BING_SELECTORS = [
  '.sb_add','.b_adLastChild','#b_results .b_ad',
  '.b_adBottom','.b_adSlug','.product-ad',
  '.b_adcaret','.b_adlabel','[data-bm="20"]',
  '.ad_sc','.sb_adsN','.sb_adsNv2','#b_adsa','#b_adsb',
];

const DDG_SELECTORS = [
  '[data-testid="ad"]','.badge--ad','.result--ad','#ads',
  '.result__sponsored','.result--sponsored',
];

const YAHOO_SELECTORS = [
  '.dd.ads','.layoutMiddle .ads','#rhs_ads','.sp-i',
  '#ysm_ad','#ystAboveResultsAdBlock',
];

const YOUTUBE_SELECTORS = [
  '.ytp-ad-module','#player-ads','#masthead-ad',
  '.ytd-banner-promo-renderer','ytd-promoted-sparkles-web-renderer',
  'ytd-display-ad-renderer','ytd-promoted-video-renderer',
  '.video-ads','ytd-ad-slot-renderer','.ytd-companion-slot-renderer',
  'ytd-promoted-sparkles-text-search-renderer',
  'ytd-search-pyv-renderer','ytd-in-feed-ad-layout-renderer',
  'ytd-action-companion-ad-renderer','#offer-module',
  'ytd-statement-banner-renderer','.ytp-ad-overlay-container',
  '.ytp-ad-image-overlay','.ytp-ad-text-overlay',
  'ytd-shopping-companion-ad-renderer',
];

// Patrones de URL de scripts de anuncios a eliminar del DOM
// Incluye los dos que testea turtlecute: /widget/ads. y /pagead.js
const AD_SCRIPT_PATTERNS = [
  'adsbygoogle','googlesyndication','doubleclick','adservice.google',
  'adnxs.com','taboola.com','outbrain.com','criteo.com','media.net',
  'pubmatic.com','rubiconproject.com','openx.net','smartadserver.com',
  'appnexus.com','teads.tv','adform.net','sizmek.com','undertone.com',
  'mgid.com','revcontent.com','mouseflow.com','hotjar.com',
  'luckyorange.com','freshmarketer.com',
  // Los que testea específicamente turtlecute:
  '/widget/ads.','/pagead.js','ads.js',
  'adcolony.com','unityads.unity3d.com',
];

function getSelectors() {
  const h = window.location.hostname;
  let sel = [...TURTLE_CSS, ...GENERIC_SELECTORS];
  if (h.includes('google.'))        sel = sel.concat(GOOGLE_SELECTORS);
  if (h.includes('bing.com'))       sel = sel.concat(BING_SELECTORS);
  if (h.includes('duckduckgo.com')) sel = sel.concat(DDG_SELECTORS);
  if (h.includes('yahoo.com'))      sel = sel.concat(YAHOO_SELECTORS);
  if (h.includes('youtube.com'))    sel = sel.concat(YOUTUBE_SELECTORS);
  return sel;
}

function removeAds() {
  if (!enabled) return;
  let removed = 0;

  for (const sel of getSelectors()) {
    try {
      document.querySelectorAll(sel).forEach(el => {
        if (!el.dataset.sxDone) {
          el.dataset.sxDone = '1';
          el.style.setProperty('display', 'none', 'important');
          el.style.setProperty('visibility', 'hidden', 'important');
          el.style.setProperty('height', '0', 'important');
          el.style.setProperty('min-height', '0', 'important');
          el.style.setProperty('overflow', 'hidden', 'important');
          removed++;
        }
      });
    } catch (_) {}
  }

  // Bloquear scripts de redes publicitarias que se inyectan en el DOM
  document.querySelectorAll('script[src]').forEach(el => {
    if (el.dataset.sxDone) return;
    const src = el.getAttribute('src') || '';
    if (AD_SCRIPT_PATTERNS.some(p => src.includes(p))) {
      el.dataset.sxDone = '1';
      el.remove();
      removed++;
    }
  });

  if (removed > 0) {
    blockedCount += removed;
    chrome.storage.local.get(['blockedTotal'], (data) => {
      chrome.storage.local.set({
        blockedTotal: (data.blockedTotal || 0) + removed,
        blockedSession: blockedCount
      });
    });
    chrome.runtime.sendMessage({ type: 'BLOCKED', count: blockedCount });
  }
}

function injectCSS() {
  if (document.getElementById('shieldx-css')) return;
  const style = document.createElement('style');
  style.id = 'shieldx-css';
  // Incluye explícitamente los selectores del test de turtlecute
  style.textContent = `
.adbox,.banner_ads,.adsbox,.textads,
ins.adsbygoogle,[data-ad-slot],[data-ad-client],
#tads,#tadsb,#bottomads,.uEierd,[data-text-ad],
.sb_add,.b_ad,.result--ad,.result__sponsored,
iframe[src*="doubleclick"],iframe[src*="googlesyndication"],
iframe[src*="adnxs"],iframe[src*="taboola"],iframe[src*="outbrain"],
[id*="taboola"],[class*="taboola"],[id*="outbrain"],[class*="outbrain"],
ytd-ad-slot-renderer,ytd-promoted-video-renderer,.ytp-ad-module,
#player-ads,.ytd-banner-promo-renderer,ytd-display-ad-renderer,
ytd-in-feed-ad-layout-renderer,.video-ads,
.ad,.ads,.ad-unit,.ad-slot,.ad-banner,.ad-container,
.advertisement,.advertising,.sponsored,.sponsor,
[data-ad],[data-ad-unit],[data-ad-slot],[data-sponsored],
[aria-label="Ads"],[aria-label="Anuncios"],
[aria-label="Sponsored"],[aria-label="Patrocinado"],
.sticky-ad,.floating-ad,.adhesion,
.mgid,.revcontent
{display:none!important;visibility:hidden!important;height:0!important;
min-height:0!important;overflow:hidden!important;pointer-events:none!important}`;
  (document.head || document.documentElement).appendChild(style);
}

function init() {
  injectCSS();
  removeAds();
  new MutationObserver(removeAds)
    .observe(document.documentElement, { childList: true, subtree: true });
}



// ── Cookie banner skipper ────────────────────────────────────────────────────
const COOKIE_REJECT = Object.freeze([
  'rechazar todo','rechazar todas','rechazar','deny all','deny','reject all','reject',
  'decline all','decline','refuser tout','refuser','alle ablehnen','ablehnen',
  'rifiuta tutto','rifiuta','rejeitar tudo','rejeitar',
  'no acepto','no, gracias','no thanks','disagree',
  'only necessary','only essential','solo esenciales','solo necesarias',
  'use necessary cookies only','continue without accepting','continuar sin aceptar',
  'save preferences','guardar preferencias','manage preferences',
]);

const COOKIE_ACCEPT = Object.freeze([
  'aceptar todo','aceptar todas','accept all','agree to all',
  'i agree','acepto','accept','aceptar','ok','got it','entendido',
  'allow all','allow cookies','permitir todas',
]);

const COOKIE_SELECTORS = Object.freeze([
  '#onetrust-banner-sdk','#cookiebanner','#cookie-banner','#cookie-notice',
  '#cookie-consent','#gdpr-banner','#gdpr-cookie-notice','#consent-banner',
  '#consent-popup','#consent-manager','#cookie-law-info-bar',
  '.cookie-banner','.cookie-notice','.cookie-consent','.cookie-bar',
  '.cookie-popup','.cookie-alert','.gdpr-banner','.consent-banner',
  '#didomi-popup','.didomi-popup-container',
  '#CybotCookiebotDialog','.qc-cmp2-container',
  '#axeptio_overlay','.axeptio_widget',
  '#truste-consent-content',
  '[data-testid="uc-banner"]','#usercentrics-root',
  '#iubenda-cs-banner','#borlabs-cookie',
  '#cmplz-cookiebanner','.cky-consent-container',
  '.cc-window','.cc-banner',
  '#cookieConsent','.cookieConsent','.cookie_consent',
  '[aria-label*="cookie"],[aria-label*="Cookie"]',
]);

function normalizeText(t) {
  return (t || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

function findBtn(container, list) {
  for (const el of container.querySelectorAll(
    'button,a[role="button"],[role="button"],input[type="button"],input[type="submit"],.btn,.button'
  )) {
    const t = normalizeText(el.innerText || el.textContent || el.value || '');
    if (list.some(p => t === p || t.includes(p))) return el;
  }
  return null;
}

function skipCookies() {
  if (!enabled) return;
  for (const sel of COOKIE_SELECTORS) {
    let nodes;
    try { nodes = document.querySelectorAll(sel); } catch(_) { continue; }
    for (const node of nodes) {
      if (!node || !node.offsetParent) continue;
      const btn = findBtn(node, COOKIE_REJECT);
      if (btn) { btn.click(); reportCookie(); return; }
      const close = node.querySelector(
        '[aria-label="close"],[aria-label="Close"],[aria-label="cerrar"],.btn-close,.close'
      );
      if (close) { close.click(); reportCookie(); return; }
    }
  }
  for (const d of document.querySelectorAll('[role="dialog"],[role="alertdialog"]')) {
    const t = normalizeText(d.innerText || '');
    if (!d.offsetParent) continue;
    if (!t.includes('cookie') && !t.includes('gdpr') && !t.includes('consent') && !t.includes('privacidad')) continue;
    const btn = findBtn(d, COOKIE_REJECT);
    if (btn) { btn.click(); reportCookie(); return; }
  }
}

function reportCookie() {
  chrome.storage.local.get(['blockedTotal','cookiesBlocked'], (data) => {
    chrome.storage.local.set({
      blockedTotal: (data.blockedTotal || 0) + 1,
      cookiesBlocked: (data.cookiesBlocked || 0) + 1,
    });
  });
  chrome.runtime.sendMessage({ type: 'COOKIE_BLOCKED' });
}

function startCookieSkipper() {
  skipCookies();
  window.addEventListener('load', () => {
    setTimeout(skipCookies, 400);
    setTimeout(skipCookies, 1200);
    setTimeout(skipCookies, 3000);
  });
  new MutationObserver(skipCookies)
    .observe(document.documentElement, { childList: true, subtree: true });
}

startCookieSkipper();

// ── Bloqueo extra v7: banners por src, GA inline, fingerprinters ──────────────
(function extraV7() {
  if (!enabled) return;

  // Patrones de src de imágenes publicitarias (adblock-tester sirve banners locales)
  const BANNER_IMG_PATTERNS = [
    'pr_advertising', 'ads_banner', 'ad_banner', 'banner_ad',
    '/banners/', 'advertisement', 'advert_', '_advert',
  ];

  // Scripts adicionales a bloquear por src
  const EXTRA_SCRIPT_PATTERNS = [
    'google-analytics.com/analytics.js',
    'google-analytics.com/gtag',
    'google-analytics.com/ga.js',
    'googletagmanager.com/gtm.js',
    'googletagmanager.com/gtag',
    'sentry.io', 'sentry-cdn.com', 'ingest.sentry.io',
    'optimizely.com', 'vwo.com', 'abtasty.com', 'ab-tasty.com',
    'kameleoon.com', 'convertexperiments.com',
    'fingerprintjs.com', 'fpjscdn.net',
    'imasdk.googleapis.com',
    'coinhive.com', 'crypto-loot.com', 'cryptoloot.pro',
    'skimlinks.com', 'viglink.com',
    'onetrust.com', 'cookielaw.org', 'trustarc.com',
    'sourcepoint.com',
  ];

  function blockExtraElements() {
    if (!enabled) return;

    // Bloquear imágenes con src sospechoso
    document.querySelectorAll('img[src]').forEach(img => {
      if (img.dataset.sxDone) return;
      const src = img.getAttribute('src') || '';
      if (BANNER_IMG_PATTERNS.some(p => src.includes(p))) {
        img.dataset.sxDone = '1';
        img.style.setProperty('display', 'none', 'important');
        img.removeAttribute('src');
      }
    });

    // Bloquear scripts extra
    document.querySelectorAll('script[src]').forEach(el => {
      if (el.dataset.sxDone) return;
      const src = el.getAttribute('src') || '';
      if (EXTRA_SCRIPT_PATTERNS.some(p => src.includes(p))) {
        el.dataset.sxDone = '1';
        el.remove();
      }
    });

    // Bloquear iframes de video ads
    document.querySelectorAll('iframe[src*="imasdk.googleapis"],' +
      'iframe[src*="fwmrm.net"],iframe[src*="springserve"],' +
      'iframe[src*="jwplayer"][src*="ad"]').forEach(el => {
      if (!el.dataset.sxDone) {
        el.dataset.sxDone = '1';
        el.style.setProperty('display', 'none', 'important');
      }
    });
  }

  blockExtraElements();
  new MutationObserver(blockExtraElements)
    .observe(document.documentElement, { childList: true, subtree: true });
})();
