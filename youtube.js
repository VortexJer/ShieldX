// ShieldX – YouTube Ad Skipper v12
// Cambios respecto a v11:
//  - El estado llega por el atributo data-shieldx-yt de <html>. La v11 lo leía
//    de window.__shieldxYT, que content.js escribía con un <script> inline: la
//    CSP de YouTube lo bloquea, así que el interruptor no se aplicaba nunca.
//  - Apagar el bloqueo retira también el CSS (antes se quedaba puesto).
//  - Se limpian adPlacements/playerAds de ytInitialPlayerResponse antes de que
//    el reproductor los lea: evita el pre-roll en origen, sin tocar la red
//    (interceptar fetch/XHR fue lo que dejó el player cargando en v10).
//  - removeAdNodes usa querySelectorAll en vez de recorrer el árbol nodo a nodo,
//    y las mutaciones se agrupan: en el feed de YouTube el TreeWalker por cada
//    nodo añadido costaba más que el propio render.
//  - Al terminar el anuncio se restaura la velocidad que tenía el usuario, no 1.
'use strict';

(function YouTubeBlocker() {
  if (!location.hostname.includes('youtube.com')) return;

  // ── Estado ────────────────────────────────────────────────────────────────
  // content.js (isolated world) escribe el atributo en cuanto resuelve el
  // storage. Si aún no está, se asume activo y el CustomEvent corrige en ms.
  function readAttr() {
    const v = document.documentElement.getAttribute('data-shieldx-yt');
    return v === null ? true : v !== '0';
  }

  let ytEnabled = readAttr();

  window.addEventListener('__shieldx_yt_toggle', (e) => {
    // Si el detail no sobrevive al salto entre mundos, mandar el atributo:
    // interpretarlo como "false" apagaría el bloqueo por error.
    const next = (e.detail && typeof e.detail.enabled === 'boolean')
      ? e.detail.enabled
      : readAttr();
    if (next === ytEnabled) return;
    ytEnabled = next;
    applyCSS();
    if (ytEnabled) removeAdNodes(document.documentElement);
  });

  // ── CSS: oculta la interfaz de anuncios, nunca el reproductor ─────────────
  const AD_TAGS = [
    'ytd-ad-slot-renderer', 'ytd-in-feed-ad-layout-renderer',
    'ytd-promoted-video-renderer', 'ytd-promoted-sparkles-web-renderer',
    'ytd-promoted-sparkles-text-search-renderer', 'ytd-search-pyv-renderer',
    'ytd-display-ad-renderer', 'ytd-action-companion-ad-renderer',
    'ytd-statement-banner-renderer', 'ytd-banner-promo-renderer',
    'ytd-shopping-companion-ad-renderer', 'ytd-companion-slot-renderer',
    'ytd-merch-shelf-renderer',
  ];

  const AD_TAG_SELECTOR = AD_TAGS.join(',');
  const AD_TAG_SET = new Set(AD_TAGS.map(t => t.toUpperCase()));

  const CSS = `
    #masthead-ad, #player-ads, #offer-module,
    ${AD_TAG_SELECTOR},
    ytd-rich-item-renderer:has(ytd-ad-slot-renderer),
    ytd-rich-section-renderer:has(ytd-statement-banner-renderer),
    .ytp-ad-overlay-container,
    .ytp-ad-image-overlay,
    .ytp-ad-text-overlay
    { display: none !important; }
  `;

  const STYLE_ID = 'shieldx-yt-css';

  function applyCSS() {
    const existing = document.getElementById(STYLE_ID);
    if (!ytEnabled) { if (existing) existing.remove(); return; }
    if (existing) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  applyCSS();

  // ── Suprimir el pre-roll en el propio objeto del reproductor ──────────────
  // YouTube asigna window.ytInitialPlayerResponse desde un script inline. Se
  // intercepta la asignación y se le quitan las claves de anuncios antes de que
  // el reproductor lo consuma. No se toca ninguna petición de red.
  const AD_KEYS = ['adPlacements', 'adSlots', 'playerAds', 'adBreakHeartbeatParams'];

  function stripAds(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    try {
      for (const k of AD_KEYS) if (k in obj) delete obj[k];
    } catch (_) { /* objeto sellado: se deja tal cual */ }
    return obj;
  }

  try {
    let stored = window.ytInitialPlayerResponse;
    Object.defineProperty(window, 'ytInitialPlayerResponse', {
      configurable: true,
      get() { return stored; },
      set(v) { stored = ytEnabled ? stripAds(v) : v; }
    });
    if (stored) stripAds(stored);
  } catch (_) { /* si no se puede, queda el salto activo como respaldo */ }

  // ── Salto activo ──────────────────────────────────────────────────────────
  let savedMuted = false;
  let savedRate  = 1;
  let wasInAd    = false;

  const SKIP_SELECTOR = [
    '.ytp-ad-skip-button-modern .ytp-ad-skip-button-slot',
    '.ytp-skip-ad-button',
    '.ytp-ad-skip-button',
    'button.ytp-ad-skip-button-modern',
    '.ytp-ad-skip-button-text',
    '[class*="ytp-ad-skip"]',
  ].join(',');

  function visible(el) {
    return !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  }

  function skipAd() {
    if (!ytEnabled) return;

    const inAd = !!document.querySelector(
      '.ad-showing, .ytp-ad-preview-container, .ytp-ad-duration-remaining'
    );
    const video = inAd || wasInAd
      ? document.querySelector('video.html5-main-video')
      : null;

    if (inAd && video) {
      if (!wasInAd) {
        savedMuted = video.muted;
        savedRate  = video.playbackRate || 1;
        wasInAd    = true;
      }

      const skipBtn = document.querySelector(SKIP_SELECTOR);
      if (visible(skipBtn)) { skipBtn.click(); return; }

      // Sin botón de saltar: acelerar en silencio. No se toca currentTime,
      // que es lo que dejaba el reproductor en "cargando" indefinido.
      video.muted = true;
      if (video.playbackRate !== 16) video.playbackRate = 16;
      return;
    }

    if (!inAd && wasInAd) {
      wasInAd = false;
      if (video) {
        video.muted        = savedMuted;
        video.playbackRate = savedRate || 1;
        if (video.paused && video.readyState >= 2) video.play().catch(() => {});
      }
    }

    const close = document.querySelector(
      '.ytp-ad-overlay-close-button, .ytp-ad-overlay-close'
    );
    if (visible(close)) close.click();
  }

  // ── Limpieza de nodos de anuncio ──────────────────────────────────────────
  function removeAdNodes(root) {
    if (!ytEnabled || !root || !root.querySelectorAll) return;
    let nodes;
    try { nodes = root.querySelectorAll(AD_TAG_SELECTOR); } catch (_) { return; }
    for (const n of nodes) {
      const holder = n.closest('ytd-rich-item-renderer') || n;
      try { holder.remove(); } catch (_) {}
    }
  }

  // Las mutaciones se agrupan en un solo barrido por frame, y sólo sobre los
  // subárboles que acaban de aparecer: barrer el documento entero en cada
  // mutación es lo que hacía pesado el feed.
  let pending = false;
  let dirty   = [];

  function schedule(root) {
    if (!ytEnabled) return;
    // dirty === null significa "barrer el documento completo" y gana sobre
    // cualquier subárbol acumulado.
    if (!root || root === document.documentElement) dirty = null;
    else if (dirty !== null) dirty.push(root);
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      const roots = dirty;
      dirty = [];
      if (roots === null) removeAdNodes(document.documentElement);
      else for (const r of roots) removeAdNodes(r);
    });
  }

  new MutationObserver(mutations => {
    if (!ytEnabled) return;
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (AD_TAG_SET.has(node.nodeName)) {
          const holder = node.closest && node.closest('ytd-rich-item-renderer');
          try { (holder || node).remove(); } catch (_) {}
        } else if (node.firstElementChild) {
          schedule(node);
        }
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });

  // ── Arranque ──────────────────────────────────────────────────────────────
  function start() {
    removeAdNodes(document.documentElement);
    setInterval(skipAd, 200);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

  // YouTube navega sin recargar: reiniciar el estado en cada vídeo.
  window.addEventListener('yt-navigate-finish', () => {
    wasInAd = false;
    schedule();
  });

  let lastUrl = location.href;
  setInterval(() => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    wasInAd = false;
    schedule();
  }, 500);
})();
