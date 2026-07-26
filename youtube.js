// ShieldX – YouTube Ad Skipper v11
// Cambios respecto a v10:
//  - Eliminado el interceptor XHR/fetch: bloqueaba peticiones legítimas
//    de carga de video (googlevideo.com, etc.) dejando el player cargando.
//  - El skip ya no fuerza currentTime al final; solo acelera+mute.
//  - Restauración segura del estado: solo reanuda si readyState >= 2.
//  - Respeta el toggle ytAdBlock guardado en storage (propagado via content.js).
'use strict';

(function YouTubeBlocker() {
  if (!window.location.hostname.includes('youtube.com')) return;

  // ── Estado del toggle ─────────────────────────────────────────────────────
  // content.js (isolated world) setea window.__shieldxYT antes de que este
  // script corra (ambos van en document_start).
  let ytEnabled = window.__shieldxYT !== false;

  // Actualizaciones en tiempo real desde content.js
  window.addEventListener('__shieldx_yt_toggle', (e) => {
    ytEnabled = e.detail.enabled;
  });

  // ── CSS: ocultar UI de anuncios (NO el player) ────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
    #masthead-ad,
    ytd-ad-slot-renderer,
    ytd-in-feed-ad-layout-renderer,
    ytd-promoted-video-renderer,
    ytd-promoted-sparkles-web-renderer,
    ytd-promoted-sparkles-text-search-renderer,
    ytd-search-pyv-renderer,
    ytd-display-ad-renderer,
    ytd-action-companion-ad-renderer,
    ytd-statement-banner-renderer,
    ytd-banner-promo-renderer,
    ytd-shopping-companion-ad-renderer,
    ytd-companion-slot-renderer,
    ytd-merch-shelf-renderer,
    ytd-rich-item-renderer:has(ytd-ad-slot-renderer),
    ytd-rich-section-renderer:has(ytd-statement-banner-renderer),
    .ytp-ad-overlay-container,
    .ytp-ad-image-overlay,
    .ytp-ad-text-overlay
    { display: none !important; }
  `;
  (document.head || document.documentElement).appendChild(style);

  // ── Skip activo ───────────────────────────────────────────────────────────
  let savedMuted = false;
  let wasInAd    = false;

  function skipAd() {
    if (!ytEnabled) return;

    const video     = document.querySelector('video.html5-main-video');
    const adShowing = !!document.querySelector('.ad-showing');
    const adPreview = !!document.querySelector('.ytp-ad-preview-container, .ytp-ad-duration-remaining');
    const inAd      = adShowing || adPreview;

    if (inAd && video) {
      if (!wasInAd) {
        savedMuted = video.muted;
        wasInAd    = true;
      }

      // Paso 1: botón de saltar visible → clickar
      const skipBtn = document.querySelector(
        '.ytp-ad-skip-button-modern .ytp-ad-skip-button-slot, ' +
        '.ytp-ad-skip-button, ' +
        '.ytp-skip-ad-button, ' +
        'button.ytp-ad-skip-button-modern, ' +
        '[class*="ytp-ad-skip"], ' +
        '.ytp-ad-skip-button-text'
      );
      if (skipBtn && skipBtn.offsetParent !== null) {
        skipBtn.click();
        return;
      }

      // Paso 2: acelerar silenciosamente — NO tocar currentTime para no
      // romper el buffer ni dejar el player en estado de "cargando infinito"
      video.muted        = true;
      video.playbackRate = 16;
      return;
    }

    // Anuncio terminado → restaurar
    if (!inAd && wasInAd) {
      wasInAd = false;
      if (video) {
        video.muted        = savedMuted;
        video.playbackRate = 1;
        if (video.paused && video.readyState >= 2) {
          video.play().catch(() => {});
        }
      }
    }

    // Cerrar overlay de imagen
    const overlayClose = document.querySelector(
      '.ytp-ad-overlay-close-button, .ytp-ad-overlay-close'
    );
    if (overlayClose) overlayClose.click();
  }

  // ── Limpiar nodos de anuncio del feed/resultados ──────────────────────────
  const AD_TAGS = new Set([
    'YTD-AD-SLOT-RENDERER', 'YTD-IN-FEED-AD-LAYOUT-RENDERER',
    'YTD-PROMOTED-VIDEO-RENDERER', 'YTD-PROMOTED-SPARKLES-WEB-RENDERER',
    'YTD-PROMOTED-SPARKLES-TEXT-SEARCH-RENDERER', 'YTD-SEARCH-PYV-RENDERER',
    'YTD-DISPLAY-AD-RENDERER', 'YTD-ACTION-COMPANION-AD-RENDERER',
    'YTD-STATEMENT-BANNER-RENDERER', 'YTD-BANNER-PROMO-RENDERER',
    'YTD-SHOPPING-COMPANION-AD-RENDERER', 'YTD-COMPANION-SLOT-RENDERER',
  ]);

  function removeAdNodes(root) {
    if (!root || !root.querySelectorAll) return;
    const toRemove = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let node = walker.currentNode;
    while (node) {
      if (AD_TAGS.has(node.nodeName)) toRemove.push(node);
      else if (node.nodeName === 'YTD-RICH-ITEM-RENDERER' &&
               node.querySelector('ytd-ad-slot-renderer')) toRemove.push(node);
      node = walker.nextNode();
    }
    toRemove.forEach(n => { try { n.remove(); } catch(_) {} });
  }

  new MutationObserver(mutations => {
    if (!ytEnabled) return;
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (AD_TAGS.has(node.nodeName)) { try { node.remove(); } catch(_) {} }
        else if (node.querySelector) removeAdNodes(node);
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });

  // ── Arrancar ──────────────────────────────────────────────────────────────
  function start() {
    if (ytEnabled) removeAdNodes(document.documentElement);
    setInterval(skipAd, 150);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

  // Reiniciar estado al cambiar de video
  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      wasInAd = false;
      if (ytEnabled) setTimeout(() => removeAdNodes(document.documentElement), 500);
    }
  }).observe(document.documentElement, { childList: true, subtree: true });

})();
