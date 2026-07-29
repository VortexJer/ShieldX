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

// ¿Estamos en el marco superior o dentro de un iframe?
// Importa mucho: el banner de un CMP suele vivir en su propio iframe, y este
// script corre también ahí dentro. Ocultarlo DESDE DENTRO deja el iframe
// vacío pero presente — a pantalla completa, con el velo del sitio puesto y el
// scroll bloqueado. La página queda peor que sin tocar nada: no se puede ni
// leer ni responder al aviso. Verificado en vivo en as.com.
// Los banners solo se ocultan desde el marco superior, escondiendo el iframe
// entero; si desde ahí no se reconoce, se deja intacto a propósito.
const IS_TOP_FRAME = (() => {
  try { return window === window.top; } catch (_) { return false; }
})();

let globalEnabled = true;   // interruptor maestro
let siteExcluded  = false;  // este dominio está en la lista de excluidos
let started       = false;  // ya se inyectó CSS / arrancó el observer

function isActive() { return globalEnabled && !siteExcluded; }

function hostMatches(pattern) {
  const p = String(pattern || '').toLowerCase().replace(/^www\./, '');
  return !!p && (HOST === p || HOST.endsWith('.' + p));
}

// ── Clientes de correo web ───────────────────────────────────────────────────
// Aquí la capa de ocultado no entra nunca. El cuerpo de un correo es HTML
// ajeno y arbitrario: puede traer cualquier clase o cualquier imagen con
// "banner" en la ruta, y ocultarlo significa esconderle correo al usuario.
// El resto de ShieldX (anti-redirección, descargas vigiladas y la capa de red)
// sigue funcionando con normalidad.
const MAIL_HOSTS = [
  'mail.google.com', 'inbox.google.com',
  'outlook.live.com', 'outlook.office.com', 'outlook.office365.com', 'outlook.com',
  'mail.yahoo.com', 'mail.proton.me', 'protonmail.com', 'mail.zoho.com',
  'mail.aol.com', 'icloud.com', 'mail.ru', 'gmx.com', 'gmx.net', 'web.de',
  'fastmail.com', 'zimbra.com', 'hey.com', 'tutanota.com', 'tuta.com',
];
const MAIL_PREFIX = /^(mail|webmail|correo|email|mbox|zimbra|roundcube|owa|imap)\./;

const IS_MAIL_APP = MAIL_HOSTS.some(hostMatches) || MAIL_PREFIX.test(HOST);

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

const STATE_KEYS = ['enabled', 'ytAdBlock', 'guardEnabled', 'siteExcluded',
                    'customHidden', 'antiAdblockWalls'];

let antiAdblockWalls = true;   // retirar los muros de "desactiva el bloqueador"

function applyState(data) {
  globalEnabled = data.enabled !== false;
  antiAdblockWalls = data.antiAdblockWalls !== false;
  const list = Array.isArray(data.siteExcluded) ? data.siteExcluded : [];
  siteExcluded = list.some(hostMatches);

  const ytEnabled = data.ytAdBlock !== false && isActive();
  propagateYTState(ytEnabled);

  // El anti-redirección no depende de la capa de ocultado: sigue activo en el
  // correo, donde además hace falta (enlaces de phishing que abren ventanas).
  propagateGuardState(data.guardEnabled !== false && isActive());

  // Selectores elegidos a mano por el usuario con el picker. Se aplican
  // incluso en clientes de correo: ocultar algo que TÚ señalaste es distinto
  // de que un patrón genérico te esconda un correo.
  applyCustomCSS(data.customHidden);

  if (isActive() && !IS_MAIL_APP) start(); else stop();
}

// El callback puede llegar en el MISMO tick, con el fichero todavía a medio
// evaluar: las constantes declaradas más abajo (CUSTOM_CSS_ID, los selectores
// de cookies…) estarían en zona muerta y applyState lanzaría, dejando la página
// con el CSS puesto pero sin observer — bloqueador mudo el resto de la sesión.
// Un microtask basta: se procesa cuando la evaluación del script ha terminado.
function aplicarEstadoCuandoTodoExista(data) {
  Promise.resolve().then(() => applyState(data));
}

chrome.storage.local.get(STATE_KEYS, aplicarEstadoCuandoTodoExista);

// Reaccionar en TODAS las pestañas, no sólo en la activa.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (!STATE_KEYS.some(k => k in changes)) return;
  chrome.storage.local.get(STATE_KEYS, aplicarEstadoCuandoTodoExista);
});

// ── Puente con guard.js ──────────────────────────────────────────────────────
// El service worker necesita saber cuándo has hecho clic de verdad para poder
// distinguir la descarga que pides tú de la que arranca sola.
let lastGestureSent = 0;
let lastUserGesture = 0;   // sin throttle: lo usan las guardias anti-falso-positivo

// Todo el estado que consultan las pasadas se declara AQUÍ, antes de nada más.
// chrome.storage puede responder en el mismo tick, y entonces la primera pasada
// corre mientras el resto del fichero aún se está evaluando: una variable `let`
// declarada más abajo estaría en zona muerta y lanzaría ReferenceError. Eso
// mataba start() justo antes de crear el observer — el CSS entraba y el barrido
// no arrancaba nunca.
let cookieSettingsUntil = 0;

function recentGesture(ms) { return Date.now() - lastUserGesture < ms; }

function noteGesture() {
  const now = Date.now();
  if (now - lastGestureSent < 1000) return;   // un aviso por segundo basta
  lastGestureSent = now;
  try {
    chrome.runtime.sendMessage({ type: 'GESTURE' }, () => void chrome.runtime.lastError);
  } catch (_) {}
}

for (const type of ['pointerdown', 'keydown']) {
  window.addEventListener(type, (e) => {
    if (!e.isTrusted) return;
    lastUserGesture = Date.now();
    // composedPath()[0] atraviesa el shadow DOM; e.target se queda en el host.
    const objetivo = (typeof e.composedPath === 'function' && e.composedPath()[0]) || e.target;
    if (objetivo && clickWantsCookieUI(objetivo)) restoreCookieUI();
    noteGesture();
  }, true);
}

window.addEventListener('__shieldx_guard_block', () => {
  killOverlays(true);   // el que intentó abrir la ventana suele ser un overlay
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
  if (IS_GOOGLE_SEARCH)                    strong.push(...GOOGLE_SELECTORS);
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
// Sólo el buscador: con /(^|\.)google\./ entraban también mail.google.com,
// drive.google.com y docs.google.com, que no tienen resultados que filtrar y
// sí clases ofuscadas que pueden coincidir por casualidad.
const IS_GOOGLE_SEARCH = /^google\.[a-z.]+$/.test(HOST);

const IS_SEARCH =
  IS_GOOGLE_SEARCH || hostMatches('bing.com') ||
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

// Formatos publicitarios estándar (IAB). Un hueco con estas medidas es un
// anuncio aunque esté vacío; una caja de cualquier otro tamaño, no tanto.
const AD_SIZES = [
  [300, 250], [336, 280], [728, 90], [970, 90], [970, 250], [320, 50], [320, 100],
  [300, 600], [160, 600], [120, 600], [300, 100], [468, 60], [250, 250], [200, 200],
];

function tieneMedidaDeAnuncio(r) {
  return AD_SIZES.some(([w, h]) =>
    Math.abs(r.width - w) <= 2 && Math.abs(r.height - h) <= 2);
}

function isSafeToHide(el) {
  if (STRUCTURAL.has(el.tagName)) return false;

  // Un anuncio no lleva párrafos de texto: si los lleva, es contenido.
  // textContent no fuerza reflow, a diferencia de innerText.
  const texto = (el.textContent || '').trim();
  if (texto.length > 600) return false;

  // Ni formularios, ni reproductores, ni navegación principal.
  if (el.querySelector('video,audio,input,textarea,select,nav,main,article')) return false;

  // Ni nada que ocupe media pantalla.
  const r = el.getBoundingClientRect();
  const viewport = (window.innerWidth || 1) * (window.innerHeight || 1);
  if (r.width * r.height > viewport * 0.5) return false;

  // Y una frase suelta no es un anuncio. Los nombres de esta lista (.promo-banner,
  // .ad-box…) los usan también los avisos de la propia web —«tu pedido se ha
  // guardado»— y ocultarlos deja al usuario sin enterarse de nada. Un anuncio de
  // verdad trae algo que enseñar (imagen, iframe, enlace), tiene medidas de
  // formato publicitario, o está vacío del todo.
  const tieneCarga = !!el.querySelector('img,iframe,picture,canvas,svg,a[href],ins');
  if (!tieneCarga && !tieneMedidaDeAnuncio(r) && texto.length > 25) return false;

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
  // Nunca dentro de un diálogo: eso es un modal que alguien quiere ver.
  try { if (el.closest && el.closest('dialog,[role="dialog"],[role="alertdialog"]')) return false; }
  catch (_) {}

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

function killOverlays(force) {
  // Igual que con las cookies: dentro de un iframe, la "capa a pantalla
  // completa" es el propio contenido del iframe, no una trampa.
  if (!isActive() || !IS_TOP_FRAME) return 0;
  // Tras un clic del usuario, la capa que acaba de aparecer suele ser el
  // backdrop de SU modal (un pop-up de configuración, un lightbox). Solo se
  // actúa en caliente cuando viene del guard, que sí tiene la prueba del
  // delito: la trampa acaba de intentar abrir una ventana.
  if (!force && recentGesture(1500)) return 0;
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

// ── Muros de "desactiva tu bloqueador" ───────────────────────────────────────
// Distinto de un muro de pago: aquí no se pide dinero ni una cuenta, se tapa el
// contenido hasta que apagues el bloqueador. Se retira la capa y se devuelve el
// scroll, que es lo único que hace falta; NO se pulsa ningún botón suyo ni se
// finge que no hay bloqueador.
//
// El listón es alto a propósito: tiene que hablar de bloqueadores de anuncios
// (un artículo SOBRE adblockers no vale: lo que cuenta es un aviso corto) y
// además estar tapando la página o haber dejado el scroll bloqueado.
const ANTIADBLOCK_RE =
  /(ad\s?-?block|adblocker|bloqueador\s+de\s+anuncios|bloqueadores\s+de\s+anuncios|desactiva\w*\s+(tu|el)\s+bloqueador|werbeblocker|bloqueur\s+de\s+publicit)/i;
const ANTIADBLOCK_PEDIDO_RE =
  /(desactiv|desactív|deshabilit|desconect|apag|disable|turn\s+off|whitelist|lista\s+blanca|permitir\s+anuncios|allow\s+ads|pause\s+it|desbloquea)/i;

function scrollBloqueado() {
  try {
    for (const el of [document.documentElement, document.body]) {
      if (!el) continue;
      const s = getComputedStyle(el);
      if (s.overflow === 'hidden' || s.position === 'fixed') return true;
    }
  } catch (_) {}
  return false;
}

function killAntiAdblock() {
  if (!isActive() || !IS_TOP_FRAME || !domReady || !antiAdblockWalls) return 0;

  let candidatos;
  try {
    candidatos = document.querySelectorAll(
      'div:not([data-sx-aab]),section:not([data-sx-aab]),' +
      'aside:not([data-sx-aab]),dialog:not([data-sx-aab])');
  } catch (_) { return 0; }

  const vw = window.innerWidth || 1, vh = window.innerHeight || 1;
  let n = 0;

  for (const el of candidatos) {
    if (el.hasAttribute('data-sx')) continue;
    const texto = (el.textContent || '').trim();
    // Un aviso es corto. Un artículo sobre bloqueadores, no.
    if (texto.length < 15 || texto.length > 700) continue;
    if (!ANTIADBLOCK_RE.test(texto) || !ANTIADBLOCK_PEDIDO_RE.test(texto)) continue;

    el.setAttribute('data-sx-aab', '1');   // visto: no volver a mirarlo

    let s;
    try { s = getComputedStyle(el); } catch (_) { continue; }
    const flotante = s.position === 'fixed' || s.position === 'absolute' || s.position === 'sticky';
    if (!flotante) continue;

    const r = el.getBoundingClientRect();
    const tapaLaPagina = r.width * r.height > vw * vh * 0.35;

    // El fondo oscuro suele ser el padre inmediato: a pantalla completa,
    // flotante y sin más contenido que el propio aviso. Un muro modal centrado
    // no tapa la pantalla por sí mismo, pero su fondo sí — y sin mirarlo, el
    // caso más común de todos se escapaba.
    let backdrop = null;
    const padre = el.parentElement;
    if (padre && padre !== document.body && padre !== document.documentElement) {
      try {
        const rp = padre.getBoundingClientRect();
        const sp = getComputedStyle(padre);
        if (rp.width * rp.height > vw * vh * 0.8 &&
            (sp.position === 'fixed' || sp.position === 'absolute') &&
            (padre.textContent || '').trim().length <= texto.length + 40) {
          backdrop = padre;
        }
      } catch (_) {}
    }

    // Te tapa la pantalla, tiene fondo que la tapa, o te ha dejado sin scroll.
    // Si no hace ninguna de las tres, es un aviso discreto y se queda.
    if (!tapaLaPagina && !backdrop && !scrollBloqueado()) continue;

    if (backdrop) hide(backdrop);
    hide(el);
    unlockScroll();
    n++;
  }

  if (n > 0) report(n);
  return n;
}

// ── Meta refresh hacia otro dominio ──────────────────────────────────────────
// El <meta http-equiv="refresh"> que te lleva solo a otra web es un vector
// clásico de redirección forzada, y location es inparcheable desde script.
// Dentro del mismo sitio se respeta (hay webs legítimas que lo usan para
// recargarse); hacia otro dominio se retira antes de que dispare.
function baseDomain(h) {
  return String(h || '').toLowerCase().replace(/^www\./, '').split('.').slice(-2).join('.');
}

function stripMetaRefresh() {
  if (!isActive()) return;
  let nodes;
  try { nodes = document.querySelectorAll('meta[http-equiv="refresh" i]:not([data-sx])'); }
  catch (_) { return; }
  for (const m of nodes) {
    m.setAttribute('data-sx', '0');
    const c = m.getAttribute('content') || '';
    const match = c.match(/url\s*=\s*['"]?([^'";]+)/i);
    if (!match) continue;   // refresh sin URL: recarga de la propia página
    try {
      const dest = new URL(match[1].trim(), location.href);
      if (dest.protocol !== 'http:' && dest.protocol !== 'https:') continue;
      if (baseDomain(dest.hostname) === baseDomain(location.hostname)) continue;
      m.setAttribute('data-sx', '1');
      m.remove();
      report(1);
    } catch (_) {}
  }
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

// Cada pasada va aislada: si una falla, las demás siguen. Antes, un fallo en
// cualquier punto se llevaba por delante el resto de la pasada Y —cuando
// ocurría en la primera, la de start()— impedía crear el observer, dejando el
// bloqueador mudo el resto de la vida de la página.
function paso(fn) {
  try { fn(); } catch (_) { /* una pasada rota no puede tumbar a las demás */ }
}

function runPasses() {
  scheduled = false;
  lastRun = performance.now();
  // Una web puede reemplazar el documento entero con document.write (las de
  // descarga y streaming lo hacen a menudo): se lleva por delante la hoja de
  // estilo inyectada. Reponerla cuesta un getElementById por pasada.
  paso(injectCSS);
  paso(reponerCustomCSS);
  paso(sweep);
  paso(stripMetaRefresh);
  paso(skipCookies);
  paso(killAntiAdblock);
  if (domReady) paso(killOverlays);
}

function schedule() {
  if (scheduled || !isActive()) return;
  scheduled = true;
  const wait = Math.max(0, MIN_INTERVAL - (performance.now() - lastRun));
  setTimeout(() => {
    // requestAnimationFrame NO dispara en una pestaña oculta: si se abre un
    // enlace en segundo plano (Ctrl+clic) el barrido se quedaba esperando un
    // frame que no llega, y la pestaña seguía sin limpiar. Con la página
    // oculta no hay que sincronizarse con nada: se corre y punto.
    if (document.visibilityState === 'hidden') runPasses();
    else requestAnimationFrame(runPasses);
  }, wait);
}

// Y al volver a ella, un repaso inmediato.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && isActive()) schedule();
});

function start() {
  if (started) return;   // idempotente: antes cada activación añadía un observer más
  started = true;
  paso(buildQueries);
  paso(injectCSS);
  // El observer PRIMERO: es lo que mantiene vivo el bloqueo durante toda la
  // vida de la página. Si se crea después de la primera pasada, cualquier
  // tropiezo en esa pasada deja la página sin vigilancia.
  observer = new MutationObserver(schedule);
  // Se observa `document`, no `document.documentElement`: si la página se
  // reescribe con document.write, el <html> es OTRO nodo y un observer atado al
  // antiguo se queda ciego para siempre. `document` no cambia nunca.
  observer.observe(document, { childList: true, subtree: true });
  runPasses();
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
// Política (decisión del usuario): ShieldX NO pulsa botones en su nombre.
// El banner se oculta y se libera el scroll, exactamente como borrar el nodo
// a mano en las herramientas de desarrollo. La web queda sin respuesta de
// consentimiento, así que el banner puede volver en la próxima visita — y se
// volverá a ocultar antes de que se vea.

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

// Detección genérica: verificado en vivo que los selectores fijos no bastan
// (Marca usa .popup-cookies__container, ninguno casaba). Cualquier elemento
// flotante con cookie/consent en id o clase y texto de consentimiento cuenta.
const COOKIE_HINT_QUERY =
  '[id*="ookie"],[class*="ookie"],[id*="onsent"],[class*="onsent"],' +
  '[id*="gdpr"],[class*="gdpr"],[id*="cmpbox"],[class*="cmp-container"]';

const COOKIE_TEXT = /cookie|consent|gdpr|rgpd|privacidad|privacy/;

// Los diálogos genéricos exigen evidencia fuerte: mención explícita a cookies
// Y vocabulario de consentimiento. "Privacy" a secas no vale — cualquier modal
// de login o de registro enlaza la política de privacidad, y con la regla laxa
// esos modales desaparecían (verificado: era la causa de "me bloquea pop-ups").
const DIALOG_COOKIE_RE = /\bcookies?\b|\bgdpr\b|\brgpd\b|consentimiento/;
const DIALOG_ACTION_RE = /aceptar|acepto|accept|agree|consent|rechazar|reject|configurar|preferencias|preferences|manage/;

// Iframes de CMP (Sourcepoint, Quantcast, TrustArc…): el banner vive en un
// iframe y desde el marco superior se oculta el iframe entero.
const CMP_IFRAME_QUERY =
  'iframe[id^="sp_message_iframe"],iframe[src*="privacy-mgmt"],' +
  'iframe[src*="consensu.org"],iframe[src*="trustarc"],iframe[src*="consentmanager"]';

// offsetParent es null en position:fixed, que es justo como se posicionan los
// banners de cookies: hay que medir de otra forma.
function isVisible(el) {
  if (!el) return false;
  return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
}

function normalizeText(t) {
  return (t || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

// El envoltorio más alto que también sea "de cookies": ahí suele estar el
// backdrop que oscurece la página entera.
const COOKIE_WRAP_RE = /ookie|onsent|gdpr|cmpbox/i;

function cookieTopContainer(node) {
  let top = node;
  let p = node.parentElement;
  while (p && p !== document.body && p !== document.documentElement) {
    const cls = typeof p.className === 'string' ? p.className : (p.getAttribute('class') || '');
    if (COOKIE_WRAP_RE.test(cls) || COOKIE_WRAP_RE.test(p.id || '')) top = p;
    p = p.parentElement;
  }
  return top;
}

// Cerrar sin botón: ocultar el banner y devolver el scroll que suelen dejar
// bloqueado. Solo se toca overflow, y solo cuando hemos actuado sobre un CMP.
function unlockScroll() {
  for (const el of [document.documentElement, document.body]) {
    if (!el) continue;
    try {
      if (getComputedStyle(el).overflow === 'hidden') {
        el.style.setProperty('overflow', 'visible', 'important');
      }
    } catch (_) {}
  }
}

// Oculta el banner y su backdrop, sin pulsar nada. Y no solo el nodo: muchos
// banners tienen un envoltorio a página completa con clase de cookies (Marca:
// .popup-disagreed-cookies, z-index 99999, 1009px) que no pasa los filtros por
// sí mismo — se sube al ancestro cookie-ish más alto.
function handleCookieContainer(node) {
  if (node.hasAttribute('data-sx-cookie')) return false;
  node.setAttribute('data-sx-cookie', '1');
  const top = cookieTopContainer(node);
  top.setAttribute('data-sx-cookie', '1');   // para poder restaurarlo a petición
  hide(top);
  hide(node);
  unlockScroll();
  reportCookie();
  return true;
}

// ── El usuario PIDE ver el CMP ───────────────────────────────────────────────
// Verificado en Marca: el botón "Configuración de Cookies" del footer
// re-muestra el MISMO nodo que se ocultó al cargar, y con los estilos inline
// puestos el panel no aparecía jamás. Si el clic cae en un control que habla
// de cookies, se restaura lo oculto ANTES de que corra el handler del sitio
// (vamos en captura de pointerdown) y el ocultador se aparta 30 segundos.
// (cookieSettingsUntil se declara arriba del todo, con el resto del estado.)

const COOKIE_CLICK_RE = /cookie|consent|consentimiento|privacidad|privacy|rgpd|gdpr|cmp/i;

function clickWantsCookieUI(target) {
  let n = target;
  for (let i = 0; n && n.nodeType === 1 && i < 5; i++, n = n.parentElement) {
    const texto = (n.textContent || '').trim();
    if (texto.length <= 80 && COOKIE_CLICK_RE.test(texto)) return true;
    const cls = typeof n.className === 'string' ? n.className : '';
    if (COOKIE_CLICK_RE.test(n.id || '') || COOKIE_CLICK_RE.test(cls)) return true;
  }
  return false;
}

function restoreCookieUI() {
  cookieSettingsUntil = Date.now() + 30000;
  let nodes;
  try { nodes = document.querySelectorAll('[data-sx-cookie="1"]'); } catch (_) { return 0; }
  let n = 0;
  for (const el of nodes) {
    n++;
    el.style.removeProperty('display');
    el.style.removeProperty('visibility');
    el.style.removeProperty('height');
    el.style.removeProperty('min-height');
    el.style.removeProperty('overflow');
    el.removeAttribute('data-sx');
    el.setAttribute('data-sx-cookie', '0');   // elección del usuario: no volver a tocarlo
  }
  return n;
}

// Lo que aparece justo después de un clic lo ha abierto el usuario: el panel
// de "Configurar cookies" del footer, un modal de ajustes… Un banner de verdad
// aparece solo, sin gesto de por medio. Si además trae interruptores por
// finalidad es un panel de preferencias y se respeta PARA SIEMPRE; un banner
// llano que solo coincidió en el tiempo con un clic (navegación SPA) se deja
// sin marcar y cae en la siguiente pasada.
function skipUserInvoked(n) {
  try {
    if (n.querySelector('input[type="checkbox"],input[type="radio"],[role="switch"]')) {
      n.setAttribute('data-sx-cookie', '0');
    }
  } catch (_) {}
}

function skipCookies() {
  if (!isActive() || !IS_TOP_FRAME) return;

  const gestoReciente = recentGesture(1500) || Date.now() < cookieSettingsUntil;

  // 1) Contenedores conocidos e iframes de CMP
  const seen = new Set();
  try {
    for (const n of document.querySelectorAll(COOKIE_QUERY + ',' + CMP_IFRAME_QUERY)) {
      if (n.hasAttribute('data-sx-cookie') || !isVisible(n)) continue;
      if (gestoReciente) { skipUserInvoked(n); continue; }
      seen.add(n);
    }
  } catch (_) {}

  // 2) Genéricos: flotantes con pinta de banner de consentimiento
  try {
    for (const el of document.querySelectorAll(COOKIE_HINT_QUERY)) {
      if (el.hasAttribute('data-sx-cookie') || seen.has(el) || !isVisible(el)) continue;
      const s = getComputedStyle(el);
      if (s.position !== 'fixed' && s.position !== 'sticky' && s.position !== 'absolute') continue;
      const t = normalizeText(el.textContent);
      if (!COOKIE_TEXT.test(t) || t.length > 4000) continue;
      if (gestoReciente) { skipUserInvoked(el); continue; }
      seen.add(el);
    }
  } catch (_) {}

  // 3) Diálogos: solo con evidencia fuerte de cookies, y NUNCA los que el
  //    usuario acaba de abrir — un diálogo tras un gesto es asunto suyo.
  try {
    for (const d of document.querySelectorAll('[role="dialog"],[role="alertdialog"],dialog')) {
      if (d.hasAttribute('data-sx-cookie') || seen.has(d) || !isVisible(d)) continue;
      if (gestoReciente) { d.setAttribute('data-sx-cookie', '0'); continue; }
      const t = normalizeText(d.textContent || '');
      if (t.length > 6000) continue;
      if (!DIALOG_COOKIE_RE.test(t) || !DIALOG_ACTION_RE.test(t)) continue;
      seen.add(d);
    }
  } catch (_) {}

  for (const node of seen) {
    handleCookieContainer(node);   // solo oculta: puede procesar varios de golpe
  }
}

function reportCookie() {
  try {
    chrome.runtime.sendMessage({ type: 'COOKIE_BLOCKED' }, () => void chrome.runtime.lastError);
  } catch (_) {}
}

// ── Selectores personales (picker) ───────────────────────────────────────────
// Lo que el usuario señaló con "Ocultar elemento". Viven en storage por host y
// se aplican por hoja de estilo, así que retirar la hoja lo restaura todo.
const CUSTOM_CSS_ID = 'shieldx-custom-css';

// Lo último que pidió el usuario, para poder reponerlo si la página se
// reescribe entera y se lleva la hoja por delante.
let ultimoCustomHidden = null;

function reponerCustomCSS() {
  if (!ultimoCustomHidden) return;
  if (document.getElementById(CUSTOM_CSS_ID)) return;
  applyCustomCSS(ultimoCustomHidden);
}

function applyCustomCSS(customHidden) {
  const old = document.getElementById(CUSTOM_CSS_ID);
  if (old) old.remove();
  ultimoCustomHidden = customHidden || null;
  if (!globalEnabled || siteExcluded) return;
  const map = customHidden && typeof customHidden === 'object' ? customHidden : {};
  const sels = Array.isArray(map[HOST]) ? map[HOST].filter(s => typeof s === 'string') : [];
  if (!sels.length) return;
  const valid = sels.filter(s => {
    try { document.createDocumentFragment().querySelector(s); return true; }
    catch (_) { return false; }
  });
  if (!valid.length) return;
  const style = document.createElement('style');
  style.id = CUSTOM_CSS_ID;
  style.textContent = valid.join(',') + '{display:none!important}';
  (document.head || document.documentElement).appendChild(style);
}

// ── Picker: señalar y ocultar ────────────────────────────────────────────────
function cssEscapeSafe(s) {
  try { return CSS.escape(s); }
  catch (_) { return String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&'); }
}

// Un selector estable para el elemento: id único > tag+clases estables únicas >
// ruta con nth-of-type. Las clases con pinta autogenerada (hashes, css-in-js)
// se descartan: cambian en cada build y el selector moriría mañana.
function selectorFor(el) {
  if (el.id && document.querySelectorAll('#' + cssEscapeSafe(el.id)).length === 1) {
    return '#' + cssEscapeSafe(el.id);
  }
  const stable = [...el.classList]
    .filter(c => c.length < 30 && !/\d{3,}|^js-|^css-|^sc-|^_/.test(c))
    .slice(0, 3);
  if (stable.length) {
    const s = el.tagName.toLowerCase() + stable.map(c => '.' + cssEscapeSafe(c)).join('');
    try { if (document.querySelectorAll(s).length === 1) return s; } catch (_) {}
  }
  // Ruta anclada con :nth-child en CADA nivel hasta un id único o el body:
  // única por construcción. Una ruta laxa (nth-of-type solo a veces, 5 niveles)
  // llegó a empatar con 91 artículos de una portada — habría ocultado todos.
  const parts = [];
  let n = el;
  while (n && n !== document.documentElement && parts.length < 20) {
    if (n.id && document.querySelectorAll('#' + cssEscapeSafe(n.id)).length === 1) {
      parts.unshift('#' + cssEscapeSafe(n.id));
      return parts.join(' > ');
    }
    const par = n.parentElement;
    if (!par) break;
    const idx = [...par.children].indexOf(n) + 1;
    parts.unshift(n.tagName.toLowerCase() + ':nth-child(' + idx + ')');
    if (par === document.body) { parts.unshift('body'); break; }
    n = par;
  }
  return parts.join(' > ');
}

let picking = false;

function startPick() {
  if (picking || window !== window.top) return;
  picking = true;

  const box = document.createElement('div');
  box.style.cssText =
    'position:fixed;z-index:2147483647;pointer-events:none;' +
    'outline:2px solid #00FF88;background:rgba(0,255,136,.14);' +
    'transition:all .06s linear;left:0;top:0;width:0;height:0';
  const tip = document.createElement('div');
  tip.style.cssText =
    'position:fixed;z-index:2147483647;left:50%;top:12px;' +
    'transform:translateX(-50%);background:#080B0F;color:#00FF88;' +
    'border:1px solid rgba(0,255,136,.35);border-radius:4px;padding:5px 8px 5px 12px;' +
    'font:600 11px/1.4 Consolas,monospace;letter-spacing:.08em;' +
    'display:flex;align-items:center;gap:10px';

  const texto = document.createElement('span');
  texto.textContent = 'SHIELDX — CLIC: OCULTAR · ESC O CLIC DERECHO: SALIR';
  texto.style.pointerEvents = 'none';

  // Botón de salida de verdad. El ESC dependía de que la página tuviera el
  // foco del teclado, y al abrir el picker desde el popup el foco se queda en
  // la interfaz del navegador: el usuario pulsaba ESC y no pasaba nada.
  const salir = document.createElement('button');
  salir.textContent = 'SALIR';
  salir.style.cssText =
    'all:unset;cursor:pointer;padding:2px 8px;border:1px solid rgba(0,255,136,.5);' +
    'border-radius:3px;color:#00FF88;font:600 11px/1.4 Consolas,monospace';

  tip.append(texto, salir);
  document.documentElement.append(box, tip);

  // Y además se recupera el foco, que es la causa de raíz.
  try { window.focus(); } catch (_) {}
  try {
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    document.documentElement.setAttribute('tabindex', '-1');
    document.documentElement.focus({ preventScroll: true });
    document.documentElement.removeAttribute('tabindex');
  } catch (_) {}

  let target = null;

  function onMove(e) {
    const el = e.target;
    if (!el || el === box || el === tip || el === document.body ||
        el === document.documentElement) { target = null; return; }
    target = el;
    const r = el.getBoundingClientRect();
    box.style.left = r.left + 'px';
    box.style.top = r.top + 'px';
    box.style.width = r.width + 'px';
    box.style.height = r.height + 'px';
  }

  function stopPick() {
    if (!picking) return;
    picking = false;
    box.remove(); tip.remove();
    for (const [t, f] of pares) window.removeEventListener(t, f, true);
    document.removeEventListener('keydown', onKey, true);
  }

  function onClick(e) {
    e.preventDefault(); e.stopPropagation();
    // El botón SALIR del propio cartel no selecciona nada.
    if (e.target === salir || (e.composedPath && e.composedPath().includes(salir))) {
      stopPick();
      return;
    }
    const chosen = target;
    stopPick();
    if (!chosen) return;
    const sel = selectorFor(chosen);
    chrome.storage.local.get(['customHidden'], (data) => {
      const map = data.customHidden && typeof data.customHidden === 'object' ? data.customHidden : {};
      const list = Array.isArray(map[HOST]) ? map[HOST] : [];
      if (!list.includes(sel)) list.push(sel);
      map[HOST] = list;
      // storage.onChanged reconstruye la hoja de estilo y lo oculta.
      chrome.storage.local.set({ customHidden: map });
    });
  }

  // Escape, en mayúscula o minúscula, y también con la tecla Esc antigua.
  function onKey(e) {
    if (e.key === 'Escape' || e.key === 'Esc' || e.keyCode === 27) {
      e.preventDefault(); e.stopPropagation();
      stopPick();
    }
  }
  // El clic derecho también sale: es la salida que el usuario encuentra sola.
  function onContext(e) { e.preventDefault(); e.stopPropagation(); stopPick(); }
  function swallow(e) { e.preventDefault(); e.stopPropagation(); }

  const pares = [
    ['mousemove', onMove], ['click', onClick], ['keydown', onKey],
    ['keyup', onKey],
    ['mousedown', swallow], ['mouseup', swallow], ['contextmenu', onContext],
  ];
  for (const [t, f] of pares) window.addEventListener(t, f, true);
  // Doble red: si el foco acaba en el documento y no en la ventana, el
  // keydown llega por aquí. (Quitar el picker retira ambos.)
  document.addEventListener('keydown', onKey, true);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!sender || sender.id !== chrome.runtime.id) return;
  if (typeof msg !== 'object' || msg === null) return;
  if (msg.type === 'PICK_START') startPick();
  if (msg.type === 'COOKIE_SHOW' && IS_TOP_FRAME) {
    sendResponse({ restaurados: restoreCookieUI() });
  }
});
