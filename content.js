// ShieldX Content Script v7
// Cambios respecto a v6:
//  - Un único MutationObserver con coalescing: antes eran tres observers
//    globales y cada mutación relanzaba ~250 querySelectorAll.
//  - Los selectores se compilan en dos consultas (fuertes / ambiguos) en lugar
//    de una por selector.
//  - Los selectores ambiguos (.ad, #ads, .sponsored…) pasan por una guardia que
//    impide ocultar contenido legítimo, y sólo actúan con el DOM ya parseado.
//  - Pausar revierte de verdad: se retira el CSS y se restauran los elementos.
//  - Lista de sitios excluidos: ShieldX no hace nada en ese dominio.
//  - El estado de YouTube viaja por atributo en <html>, no por script inline
//    (la CSP de la página bloqueaba el inline y el toggle nunca se aplicaba).
//  - Los contadores los escribe el service worker; aquí sólo se envían deltas.
//  - Detección de visibilidad sin offsetParent, que es null en position:fixed
//    y descartaba justo los banners de cookies.

'use strict';

const HOST = location.hostname.toLowerCase().replace(/^www\./, '');

let globalEnabled = true;   // interruptor maestro
let siteExcluded  = false;  // este dominio está en la lista de excluidos
let started       = false;  // ya se inyectó CSS / arrancó el observer

function isActive() { return globalEnabled && !siteExcluded; }

function hostMatches(pattern) {
  const p = String(pattern || '').toLowerCase().replace(/^www\./, '');
  return !!p && (HOST === p || HOST.endsWith('.' + p));
}

// ── Estado de YouTube hacia la MAIN world ────────────────────────────────────
// youtube.js corre en world MAIN y no ve chrome.storage. No se puede usar un
// <script> inline para pasarle el estado: la CSP del sitio lo bloquea. Se usa
// un atributo en <html> (lectura inicial) + un CustomEvent (cambios en vivo).
function propagateYTState(ytEnabled) {
  try {
    document.documentElement.setAttribute('data-shieldx-yt', ytEnabled ? '1' : '0');
  } catch (_) {}
  window.dispatchEvent(new CustomEvent('__shieldx_yt_toggle', {
    detail: { enabled: ytEnabled }
  }));
}

// guard.js corre en world MAIN y lee su estado del mismo modo.
function propagateGuardState(on) {
  try {
    document.documentElement.setAttribute('data-shieldx-guard', on ? '1' : '0');
  } catch (_) {}
}

const STATE_KEYS = ['enabled', 'ytAdBlock', 'guardEnabled', 'siteExcluded'];

function applyState(data) {
  globalEnabled = data.enabled !== false;
  const list = Array.isArray(data.siteExcluded) ? data.siteExcluded : [];
  siteExcluded = list.some(hostMatches);

  const ytEnabled = data.ytAdBlock !== false && isActive();
  propagateYTState(ytEnabled);
  propagateGuardState(data.guardEnabled !== false && isActive());

  if (isActive()) start(); else stop();
}

chrome.storage.local.get(STATE_KEYS, applyState);

// Reaccionar en TODAS las pestañas, no sólo en la activa.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (!STATE_KEYS.some(k => k in changes)) return;
  chrome.storage.local.get(STATE_KEYS, applyState);
});

// ── Puente con guard.js ──────────────────────────────────────────────────────
// El service worker necesita saber cuándo has hecho clic de verdad para poder
// distinguir la descarga que pides tú de la que arranca sola.
let lastGestureSent = 0;
function noteGesture() {
  const now = Date.now();
  if (now - lastGestureSent < 1000) return;   // un aviso por segundo basta
  lastGestureSent = now;
  try {
    chrome.runtime.sendMessage({ type: 'GESTURE' }, () => void chrome.runtime.lastError);
  } catch (_) {}
}

for (const type of ['pointerdown', 'keydown']) {
  window.addEventListener(type, (e) => { if (e.isTrusted) noteGesture(); }, true);
}

window.addEventListener('__shieldx_guard_block', () => {
  killOverlays();   // el que intentó abrir la ventana suele ser un overlay
  try {
    chrome.runtime.sendMessage({ type: 'GUARD_BLOCKED' }, () => void chrome.runtime.lastError);
  } catch (_) {}
});

// ── Selectores inequívocos: se ocultan siempre, también por CSS ──────────────
const STRONG_SELECTORS = [
  // Los cuatro que comprueban los tests de adblock
  '.adbox', '.banner_ads', '.adsbox', '.textads',
  // Google AdSense / GPT
  'ins.adsbygoogle', 'ins[data-ad-client]', 'ins[data-ad-slot]',
  'div[id*="google_ads"]', 'div[id*="google-ads"]',
  '#adsense', '#adsense-top', '#adsense-bottom',
  '[data-ad-slot]', '[data-ad-client]', '[data-gpt-ad]', '[data-dfp]',
  '.dfp-ad', '.dfp-slot', '.dfp-unit',
  // iframes de redes publicitarias
  'iframe[src*="doubleclick"]', 'iframe[src*="googlesyndication"]',
  'iframe[src*="adnxs"]', 'iframe[src*="taboola"]', 'iframe[src*="outbrain"]',
  'iframe[src*="criteo"]', 'iframe[src*="media.net"]',
  'iframe[id*="google_ads"]',
  // Redes de contenido patrocinado
  '[id*="taboola"]', '[class*="taboola"]', '.trc_rbox',
  '[id*="outbrain"]', '[class*="outbrain"]', '.OUTBRAIN',
  '[id*="criteo"]', '[class*="criteo"]',
  '[id*="revcontent"]', '[class*="rc-widget"]',
  // Etiquetas accesibles explícitas
  'div[aria-label="Ads"]', 'div[aria-label="Anuncios"]',
  'div[aria-label="Sponsored"]', 'div[aria-label="Patrocinados"]',
];

// ── Selectores ambiguos: sólo tras pasar la guardia isSafeToHide() ───────────
// Nombres como .ad, #ads o .sponsored aparecen también en contenido legítimo
// (direcciones, secciones de tienda, artículos), así que aquí no se ocultan a
// ciegas y nunca se meten en la hoja de estilo.
const WEAK_SELECTORS = [
  '#ad', '#ads', '#ad-top', '#ad-bottom', '#ad-left', '#ad-right',
  '#ad-wrap', '#ad-wrapper', '#ad-container', '#ad-header', '#ad-footer',
  '#ads-top', '#ads-bottom', '#top-ad', '#bottom-ad', '#right-ad', '#left-ad',
  '#sidebar-ad', '#banner-ad', '#leaderboard-ad', '#rectangle-ad',
  '#ad_top', '#ad_bottom', '#ad_left', '#ad_right', '#ad_banner', '#ad_box',
  '#ad_container', '#ad_wrapper', '#ad_unit', '#ad_slot', '#ad_frame',
  '#advertisement', '#advertisement-top', '#advertisement-bottom',
  '#sponsored-links',
  '.ad', '.ads', '.ad-unit', '.ad-slot', '.ad-container', '.ad-wrapper',
  '.ad-block', '.ad-box', '.ad-banner', '.ad-top', '.ad-bottom',
  '.ad-left', '.ad-right', '.ad-sidebar', '.ad-header', '.ad-footer',
  '.ad-zone', '.ad-space', '.ad-area', '.ad-frame', '.ad-inner',
  '.advertisement', '.advertisement-top', '.advertisement-bottom',
  '.advertising', '.advertorial',
  '.banner-ad', '.banner-ads', '.banner-advertisement',
  '.leaderboard-ad', '.billboard-ad', '.sidebar-ad', '.sidebar-ads',
  '.sponsored-content', '.sponsored-links', '.sponsored-post',
  '.promo-ad', '.promo-banner',
  '.native-ad', '.native-ads', '.native-advertisement',
  '.text-ad', '.text-ads', '.display-ad', '.display-ads',
  '.adsense-ad', '.adsense-wrapper',
  '.advert', '.adverts', '.advert-banner', '.advert-block',
  '.sticky-ad', '.sticky-ads', '.fixed-ad', '.floating-ad', '.adhesion',
  'iframe[id*="ad_"]',
  '[data-ad]', '[data-ads]', '[data-ad-unit]', '[data-ad-type]',
  '[data-ad-size]', '[data-ad-id]', '[data-advertisement]',
  '[data-sponsored]', '[data-sponsor]', '[data-native-ad]',
];

// Resultados patrocinados de buscadores: inequívocos dentro de su dominio.
const GOOGLE_SELECTORS = [
  '[data-text-ad]', '.uEierd', '#tads', '#tadsb', '#bottomads', '#tvcap',
  '.commercial-unit-desktop-top', '.commercial-unit-desktop-rhs',
  '.commercial-unit-mobile-top', '.commercial-unit-mobile-bottom',
  '.cu-container', '.pla-unit', '.mnr-c.pla-unit', '.V3FYCf', '.ads-ad',
  '.shopping-carousel-container', '#shop-carousel',
];

const BING_SELECTORS = [
  '.sb_add', '.b_adLastChild', '#b_results .b_ad',
  '.b_adBottom', '.b_adSlug', '.product-ad',
  '.b_adcaret', '.b_adlabel', '[data-bm="20"]',
  '.ad_sc', '.sb_adsN', '.sb_adsNv2', '#b_adsa', '#b_adsb',
];

const DDG_SELECTORS = [
  '[data-testid="ad"]', '.badge--ad', '.result--ad',
  '.result__sponsored', '.result--sponsored',
];

const YAHOO_SELECTORS = [
  '.dd.ads', '.layoutMiddle .ads', '#rhs_ads', '.sp-i',
  '#ysm_ad', '#ystAboveResultsAdBlock',
];

const YOUTUBE_SELECTORS = [
  '.ytp-ad-module', '#player-ads', '#masthead-ad',
  '.ytd-banner-promo-renderer', 'ytd-promoted-sparkles-web-renderer',
  'ytd-display-ad-renderer', 'ytd-promoted-video-renderer',
  '.video-ads', 'ytd-ad-slot-renderer', '.ytd-companion-slot-renderer',
  'ytd-promoted-sparkles-text-search-renderer',
  'ytd-search-pyv-renderer', 'ytd-in-feed-ad-layout-renderer',
  'ytd-action-companion-ad-renderer', '#offer-module',
  'ytd-statement-banner-renderer', '.ytp-ad-overlay-container',
  '.ytp-ad-image-overlay', '.ytp-ad-text-overlay',
  'ytd-shopping-companion-ad-renderer',
];

// Scripts de redes publicitarias a retirar del DOM.
// 'ads.js' va como expresión regular: con includes() también casaba con
// downloads.js, uploads.js o threads.js.
const AD_SCRIPT_PATTERNS = [
  'adsbygoogle', 'googlesyndication', 'doubleclick', 'adservice.google',
  'adnxs.com', 'taboola.com', 'outbrain.com', 'criteo.com', 'media.net',
  'pubmatic.com', 'rubiconproject.com', 'openx.net', 'smartadserver.com',
  'appnexus.com', 'teads.tv', 'adform.net', 'sizmek.com', 'undertone.com',
  'mgid.com', 'revcontent.com', 'mouseflow.com', 'hotjar.com',
  'luckyorange.com', 'freshmarketer.com',
  '/widget/ads.', '/pagead.js',
  'adcolony.com', 'unityads.unity3d.com',
  // Analítica y experimentación
  'google-analytics.com/analytics.js', 'google-analytics.com/gtag',
  'google-analytics.com/ga.js',
  'googletagmanager.com/gtm.js', 'googletagmanager.com/gtag',
  'optimizely.com', 'vwo.com', 'abtasty.com', 'ab-tasty.com',
  'kameleoon.com', 'convertexperiments.com',
  'fingerprintjs.com', 'fpjscdn.net', 'imasdk.googleapis.com',
  'coinhive.com', 'crypto-loot.com', 'cryptoloot.pro',
  'skimlinks.com', 'viglink.com',
];

const AD_SCRIPT_RE = /(^|[\/._-])ads\.js(\?|$)/i;

const BANNER_IMG_PATTERNS = [
  'pr_advertising', 'ads_banner', 'ad_banner', 'banner_ad',
  '/banners/', 'advertisement', 'advert_', '_advert',
];

const AD_IFRAME_SELECTOR =
  'iframe[src*="imasdk.googleapis"],iframe[src*="fwmrm.net"],' +
  'iframe[src*="springserve"],iframe[src*="jwplayer"][src*="ad"]';

// ── Compilación de selectores ────────────────────────────────────────────────
// Un querySelectorAll con la lista unida por comas en lugar de uno por
// selector: mismo resultado, una fracción del coste.
function compile(list) {
  const valid = [];
  for (const sel of list) {
    try { document.createDocumentFragment().querySelector(sel); valid.push(sel); }
    catch (_) { /* selector no soportado por este Chrome */ }
  }
  return valid.join(',');
}

let strongQuery = '';
let weakQuery   = '';

function buildQueries() {
  const strong = [...STRONG_SELECTORS];
  const weak   = [...WEAK_SELECTORS];
  if (/(^|\.)google\.[a-z.]+$/.test(HOST)) strong.push(...GOOGLE_SELECTORS);
  if (hostMatches('bing.com'))             strong.push(...BING_SELECTORS);
  if (hostMatches('duckduckgo.com'))       strong.push(...DDG_SELECTORS);
  if (hostMatches('yahoo.com'))            strong.push(...YAHOO_SELECTORS);
  if (hostMatches('youtube.com'))          strong.push(...YOUTUBE_SELECTORS);
  strongQuery = compile(strong);
  weakQuery   = compile(weak);
}

// ── Resultados patrocinados por etiqueta ─────────────────────────────────────
// Los buscadores rotan las clases de sus anuncios (#tads, .uEierd… llevan años
// caducando), así que los selectores fijos dejan de valer. Lo que no cambia es
// la etiqueta legal visible: "Patrocinado", "Sponsored", "Anuncio". Se busca ese
// texto y se oculta el bloque de resultado que lo contiene.
const IS_SEARCH =
  /(^|\.)google\.[a-z.]+$/.test(HOST) || hostMatches('bing.com') ||
  hostMatches('duckduckgo.com')       || hostMatches('yahoo.com') ||
  hostMatches('ecosia.org')           || hostMatches('search.brave.com') ||
  hostMatches('startpage.com')        || hostMatches('qwant.com');

const SPONSOR_LABELS = new Set([
  'patrocinado', 'patrocinada', 'patrocinados', 'patrocinadas',
  'resultados patrocinados', 'resultado patrocinado',
  'sponsored', 'sponsored result', 'sponsored results',
  'anuncio', 'anuncios', 'publicidad',
  'werbung', 'gesponsert', 'annonce', 'annonces', 'sponsorisé',
  'sponsorizzato', 'ad', 'ads',
]);

// Contenedores donde puede vivir la etiqueta. Limitarlo a la zona de resultados
// evita recorrer toda la página.
const LABEL_ROOTS =
  '#center_col,#rso,#tads,#tadsb,#bottomads,#tvcap,#b_content,#b_results,' +
  '#links,#web,#main,[role="main"]';

// Ancestros que delimitan "un resultado". El orden importa: closest() devuelve
// el primero que encuentra subiendo, así que los envoltorios concretos van
// antes que [data-hveid], que en Google llega a envolver la página entera.
const RESULT_BLOCK =
  '.MjjYud,.g,[data-text-ad],li.b_ad,li.b_algo,article,' +
  '[data-testid="result"],.result,li,[data-hveid]';

// Contenedores estructurales: si el bloque resuelto es uno de estos, la
// etiqueta estaba suelta y ocultarlo se llevaría la página por delante.
const FORBIDDEN_BLOCKS = new Set([
  'rso', 'search', 'center_col', 'rcnt', 'main', 'cnt',
  'appbar', 'top_nav', 'botstuff', 'b_content', 'b_results', 'links', 'web',
]);

function hideSponsoredResults() {
  if (!IS_SEARCH) return 0;
  let n = 0;
  let roots;
  try { roots = document.querySelectorAll(LABEL_ROOTS); } catch (_) { return 0; }

  for (const root of roots) {
    let nodes;
    try {
      nodes = root.querySelectorAll(
        'span:not([data-sx-lbl]),div:not([data-sx-lbl]),' +
        'a:not([data-sx-lbl]),b:not([data-sx-lbl]),cite:not([data-sx-lbl])'
      );
    } catch (_) { continue; }

    for (const el of nodes) {
      // Sólo hojas de texto: la etiqueta nunca envuelve a otros elementos.
      if (el.children.length !== 0) continue;
      el.setAttribute('data-sx-lbl', '1');

      const t = normalizeText(el.textContent);
      if (!t || t.length > 26 || !SPONSOR_LABELS.has(t)) continue;

      const block = el.closest(RESULT_BLOCK);
      if (!block || block.hasAttribute('data-sx')) continue;

      // No tirar de todo el contenedor de resultados por una etiqueta suelta.
      if (FORBIDDEN_BLOCKS.has(block.id)) continue;
      if ((block.textContent || '').length > 4000) continue;
      if (block.querySelector('input,textarea,form')) continue;
      if (block.querySelectorAll('.MjjYud,.b_algo').length > 1) continue;

      hide(block);
      n++;
    }
  }
  return n;
}

// ── Guardia contra falsos positivos ──────────────────────────────────────────
// Evita que un `.ad` o un `#ads` legítimo se lleve por delante media página.
const STRUCTURAL = new Set([
  'HTML', 'BODY', 'MAIN', 'ARTICLE', 'HEADER', 'FOOTER', 'NAV',
  'SECTION', 'FORM', 'TABLE', 'TBODY', 'UL', 'OL', 'VIDEO', 'AUDIO'
]);

function isSafeToHide(el) {
  if (STRUCTURAL.has(el.tagName)) return false;

  // Un anuncio no lleva párrafos de texto: si los lleva, es contenido.
  // textContent no fuerza reflow, a diferencia de innerText.
  if ((el.textContent || '').length > 600) return false;

  // Ni formularios, ni reproductores, ni navegación principal.
  if (el.querySelector('video,audio,input,textarea,select,nav,main,article')) return false;

  // Ni nada que ocupe media pantalla.
  const r = el.getBoundingClientRect();
  const viewport = (window.innerWidth || 1) * (window.innerHeight || 1);
  if (r.width * r.height > viewport * 0.5) return false;

  return true;
}

// ── Ocultado / restauración ──────────────────────────────────────────────────
// El estado se marca en el propio nodo (data-sx) en lugar de guardarlo en un
// Set: así no se retienen nodos eliminados en páginas de vida larga.
//   data-sx="1" → oculto por ShieldX     data-sx="0" → visto y descartado
function hide(el) {
  el.setAttribute('data-sx', '1');
  el.style.setProperty('display', 'none', 'important');
  el.style.setProperty('visibility', 'hidden', 'important');
  el.style.setProperty('height', '0', 'important');
  el.style.setProperty('min-height', '0', 'important');
  el.style.setProperty('overflow', 'hidden', 'important');
}

function restoreAll() {
  document.querySelectorAll('[data-sx="1"]').forEach(el => {
    el.style.removeProperty('display');
    el.style.removeProperty('visibility');
    el.style.removeProperty('height');
    el.style.removeProperty('min-height');
    el.style.removeProperty('overflow');
    el.removeAttribute('data-sx');
  });
  document.querySelectorAll('[data-sx="0"]').forEach(el => el.removeAttribute('data-sx'));
}

// ── Barrido ──────────────────────────────────────────────────────────────────
let domReady = document.readyState !== 'loading';
let pendingDelta = 0;
let reportTimer = null;

function report(n) {
  pendingDelta += n;
  if (reportTimer) return;
  reportTimer = setTimeout(() => {
    const delta = pendingDelta;
    pendingDelta = 0;
    reportTimer = null;
    if (delta > 0) {
      try {
        chrome.runtime.sendMessage({ type: 'BLOCKED', delta }, () => void chrome.runtime.lastError);
      } catch (_) { /* contexto de extensión invalidado tras recargarla */ }
    }
  }, 400);
}

function sweep() {
  if (!isActive()) return;
  let removed = 0;

  if (strongQuery) {
    for (const el of document.querySelectorAll(strongQuery)) {
      if (el.hasAttribute('data-sx')) continue;
      hide(el);
      removed++;
    }
  }

  // Los ambiguos esperan al DOM parseado: en document_start un contenedor
  // legítimo aún está vacío y la guardia lo confundiría con un anuncio.
  if (domReady && weakQuery) {
    for (const el of document.querySelectorAll(weakQuery)) {
      if (el.hasAttribute('data-sx')) continue;
      if (isSafeToHide(el)) { hide(el); removed++; }
      else el.setAttribute('data-sx', '0');
    }
  }

  // Scripts de redes publicitarias
  for (const el of document.querySelectorAll('script[src]:not([data-sx])')) {
    const src = el.getAttribute('src') || '';
    if (AD_SCRIPT_PATTERNS.some(p => src.includes(p)) || AD_SCRIPT_RE.test(src)) {
      el.setAttribute('data-sx', '1');
      el.remove();
      removed++;
    } else {
      el.setAttribute('data-sx', '0');
    }
  }

  // Imágenes de banner servidas desde el propio sitio
  for (const img of document.querySelectorAll('img[src]:not([data-sx])')) {
    const src = img.getAttribute('src') || '';
    if (BANNER_IMG_PATTERNS.some(p => src.includes(p))) {
      img.setAttribute('data-sx', '1');
      img.style.setProperty('display', 'none', 'important');
      img.removeAttribute('src');
      removed++;
    } else {
      img.setAttribute('data-sx', '0');
    }
  }

  // iframes de anuncios de vídeo
  for (const el of document.querySelectorAll(AD_IFRAME_SELECTOR)) {
    if (el.hasAttribute('data-sx')) continue;
    hide(el);
    removed++;
  }

  // Resultados patrocinados de buscadores (por etiqueta, no por clase)
  if (domReady) removed += hideSponsoredResults();

  if (removed > 0) report(removed);
}

// ── Capas que roban el primer clic ───────────────────────────────────────────
// En las webs de descarga y streaming pirata hay una capa transparente encima
// de todo: pulses donde pulses, el clic se lo come ella y abre otra pestaña.
// En vez de recorrer el DOM se mira qué hay justo bajo el centro de la pantalla,
// que es donde está el botón que el usuario cree estar pulsando.
function isClickTrap(el) {
  if (!el || el === document.body || el === document.documentElement) return false;
  if (STRUCTURAL.has(el.tagName)) return false;

  const r = el.getBoundingClientRect();
  const vw = window.innerWidth || 1, vh = window.innerHeight || 1;
  if (r.width * r.height < vw * vh * 0.85) return false;      // no cubre la pantalla

  if ((el.textContent || '').trim().length > 10) return false; // tiene contenido
  if (el.querySelector('img,video,canvas,svg,input,form')) return false;

  const s = getComputedStyle(el);
  if (s.position !== 'fixed' && s.position !== 'absolute') return false;

  // Debe ser algo pulsable: un backdrop de modal legítimo no lo es.
  const pulsable = el.tagName === 'A' || s.cursor === 'pointer' ||
                   el.hasAttribute('onclick') || el.hasAttribute('href');
  return pulsable;
}

function killOverlays() {
  if (!isActive()) return 0;
  const vw = window.innerWidth || 1, vh = window.innerHeight || 1;
  let n = 0;
  // Varias pasadas: suelen venir apiladas de dos en dos.
  for (let i = 0; i < 3; i++) {
    let el;
    try { el = document.elementFromPoint(Math.round(vw / 2), Math.round(vh / 2)); }
    catch (_) { break; }
    if (!isClickTrap(el)) break;
    try { el.remove(); } catch (_) { hide(el); }
    n++;
  }
  if (n > 0) report(n);
  return n;
}

// ── CSS inyectado (sólo selectores inequívocos) ──────────────────────────────
const CSS_ID = 'shieldx-css';

function injectCSS() {
  if (document.getElementById(CSS_ID)) return;
  const style = document.createElement('style');
  style.id = CSS_ID;
  style.textContent = strongQuery
    ? strongQuery + '{display:none!important;visibility:hidden!important;' +
      'height:0!important;min-height:0!important;overflow:hidden!important;' +
      'pointer-events:none!important}'
    : '';
  (document.head || document.documentElement).appendChild(style);
}

function removeCSS() {
  const el = document.getElementById(CSS_ID);
  if (el) el.remove();
}

// ── Observador único, con coalescing ─────────────────────────────────────────
// Un solo observer para anuncios y cookies. Las mutaciones se agrupan y se
// procesan como mucho cada MIN_INTERVAL ms; antes cada mutación disparaba un
// barrido completo y en sitios con DOM vivo eso bloqueaba el hilo principal.
const MIN_INTERVAL = 250;
let observer   = null;
let scheduled  = false;
let lastRun    = 0;

function runPasses() {
  scheduled = false;
  lastRun = performance.now();
  sweep();
  skipCookies();
  if (domReady) killOverlays();
}

function schedule() {
  if (scheduled || !isActive()) return;
  scheduled = true;
  const wait = Math.max(0, MIN_INTERVAL - (performance.now() - lastRun));
  setTimeout(() => requestAnimationFrame(runPasses), wait);
}

function start() {
  if (started) return;   // idempotente: antes cada activación añadía un observer más
  started = true;
  buildQueries();
  injectCSS();
  runPasses();
  observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

function stop() {
  if (!started) return;
  started = false;
  if (observer) { observer.disconnect(); observer = null; }
  removeCSS();
  restoreAll();   // pausar ahora devuelve la página a su estado original
}

document.addEventListener('DOMContentLoaded', () => {
  domReady = true;
  if (isActive()) schedule();
});

window.addEventListener('load', () => {
  if (!isActive()) return;
  // Los CMP de cookies suelen aparecer con retraso.
  setTimeout(schedule, 400);
  setTimeout(schedule, 1500);
  setTimeout(schedule, 3500);
});

// ── Banners de cookies ───────────────────────────────────────────────────────
// Sin 'manage preferences' ni 'save preferences': esos botones abren el panel
// de configuración en lugar de rechazar, y dejaban el banner abierto.
const COOKIE_REJECT = Object.freeze([
  'rechazar todo', 'rechazar todas', 'rechazar', 'deny all', 'deny',
  'reject all', 'reject', 'decline all', 'decline',
  'refuser tout', 'refuser', 'alle ablehnen', 'ablehnen',
  'rifiuta tutto', 'rifiuta', 'rejeitar tudo', 'rejeitar',
  'no acepto', 'no, gracias', 'no thanks', 'disagree',
  'only necessary', 'only essential', 'solo esenciales', 'solo necesarias',
  'use necessary cookies only', 'continue without accepting',
  'continuar sin aceptar',
]);

const COOKIE_SELECTORS = Object.freeze([
  '#onetrust-banner-sdk', '#cookiebanner', '#cookie-banner', '#cookie-notice',
  '#cookie-consent', '#gdpr-banner', '#gdpr-cookie-notice', '#consent-banner',
  '#consent-popup', '#consent-manager', '#cookie-law-info-bar',
  '.cookie-banner', '.cookie-notice', '.cookie-consent', '.cookie-bar',
  '.cookie-popup', '.cookie-alert', '.gdpr-banner', '.consent-banner',
  '#didomi-popup', '.didomi-popup-container',
  '#CybotCookiebotDialog', '.qc-cmp2-container',
  '#axeptio_overlay', '.axeptio_widget',
  '#truste-consent-content',
  '[data-testid="uc-banner"]', '#usercentrics-root',
  '#iubenda-cs-banner', '#borlabs-cookie',
  '#cmplz-cookiebanner', '.cky-consent-container',
  '.cc-window', '.cc-banner',
  '#cookieConsent', '.cookieConsent', '.cookie_consent',
]);

const COOKIE_QUERY = COOKIE_SELECTORS.join(',');
const MAX_COOKIE_CLICKS = 3;   // techo por documento: sin él, un banner que no
let cookieClicks = 0;          // se cierra provocaba clics en bucle

// offsetParent es null en position:fixed, que es justo como se posicionan los
// banners de cookies: hay que medir de otra forma.
function isVisible(el) {
  if (!el) return false;
  return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
}

function normalizeText(t) {
  return (t || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

function findBtn(container, list) {
  const nodes = container.querySelectorAll(
    'button,a[role="button"],[role="button"],input[type="button"],input[type="submit"],.btn,.button'
  );
  for (const el of nodes) {
    const t = normalizeText(el.innerText || el.textContent || el.value || '');
    if (!t || t.length > 60) continue;   // párrafos legales, no botones
    if (list.some(p => t === p || t.includes(p))) return el;
  }
  return null;
}

function skipCookies() {
  if (!isActive() || cookieClicks >= MAX_COOKIE_CLICKS) return;

  const seen = [];
  try { seen.push(...document.querySelectorAll(COOKIE_QUERY)); } catch (_) {}

  for (const node of seen) {
    if (node.hasAttribute('data-sx-cookie')) continue;   // procesado ya
    if (!isVisible(node)) continue;
    node.setAttribute('data-sx-cookie', '1');

    const btn = findBtn(node, COOKIE_REJECT);
    if (btn) { btn.click(); reportCookie(); return; }

    const close = node.querySelector(
      '[aria-label="close"],[aria-label="Close"],[aria-label="cerrar"],.btn-close,.close'
    );
    if (close) { close.click(); reportCookie(); return; }
  }

  for (const d of document.querySelectorAll('[role="dialog"],[role="alertdialog"]')) {
    if (d.hasAttribute('data-sx-cookie')) continue;
    if (!isVisible(d)) continue;
    const t = normalizeText(d.textContent || '');
    if (!t.includes('cookie') && !t.includes('gdpr') &&
        !t.includes('consent') && !t.includes('privacidad')) continue;
    d.setAttribute('data-sx-cookie', '1');
    const btn = findBtn(d, COOKIE_REJECT);
    if (btn) { btn.click(); reportCookie(); return; }
  }
}

function reportCookie() {
  cookieClicks++;
  try {
    chrome.runtime.sendMessage({ type: 'COOKIE_BLOCKED' }, () => void chrome.runtime.lastError);
  } catch (_) {}
}
