// ShieldX – YouTube Ad Skipper v13
// Cambios respecto a v12, verificados contra el YouTube real (2026-07):
//  - Poda de anuncios en las respuestas del reproductor. La limpieza de
//    ytInitialPlayerResponse solo cubre el PRIMER video; al navegar dentro de
//    YouTube (SPA) los datos llegan por fetch. Medido en vivo: el endpoint
//    actual es /youtubei/v1/get_watch (con el playerResponse incrustado), no
//    /player, asi que la poda es PROFUNDA: borra las claves de anuncio esten
//    donde esten del arbol (1.4 ms sobre una respuesta real de 82 KB).
//    NUNCA se bloquea la peticion (eso fue lo que rompio el player en v10):
//    ante cualquier duda o error se devuelve la respuesta original. Tampoco se
//    toca /player/ad_break: su esquema es otro y bloquearlo es detectable.
//  - Deteccion de anuncio SOLO por la clase del #movie_player (ad-showing /
//    ad-interrupting). La deteccion por presencia de .ytp-ad-preview-container
//    y compania se quedaba pegada (los nodos persisten ocultos al acabar el
//    anuncio) y el 16x se aplicaba al video de verdad: cazado en vivo con un
//    video entero reproducido a 16x.
//  - Al capturar la velocidad del usuario se descarta si es >2: si el estado
//    se resetea a mitad de anuncio (cambio de URL), el siguiente tick
//    capturaba 16 como "velocidad del usuario" y la restauracion la
//    reimplantaba.
//  - Selectores de salto ampliados a la UI 2024+ (#ytp-skip-ad button).
'use strict';

(function YouTubeBlocker() {
  if (!location.hostname.includes('youtube.com')) return;
  if (window.__shieldxYTv13) return;   // idempotente (recargas del content script)
  window.__shieldxYTv13 = true;

  // ── Estado ────────────────────────────────────────────────────────────────
  function readAttr() {
    const v = document.documentElement.getAttribute('data-shieldx-yt');
    return v === null ? true : v !== '0';
  }

  let ytEnabled = readAttr();

  window.addEventListener('__shieldx_yt_toggle', (e) => {
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
    'ytd-merch-shelf-renderer', 'ytm-companion-ad-renderer',
  ];

  const AD_TAG_SELECTOR = AD_TAG_SELECTOR_BUILD();
  function AD_TAG_SELECTOR_BUILD() { return AD_TAGS.join(','); }
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

  // ── Poda de claves de anuncio en los datos del reproductor ────────────────
  // Profunda: get_watch incrusta el playerResponse en niveles que cambian, asi
  // que se borran las claves alla donde aparezcan. Son lo bastante especificas
  // como para no existir con otro significado.
  const AD_KEYS = ['adPlacements', 'adSlots', 'playerAds', 'adBreakHeartbeatParams'];

  function stripAds(node, depth) {
    depth = depth || 0;
    if (!node || typeof node !== 'object' || depth > 12) return false;
    let changed = false;
    try {
      if (!Array.isArray(node)) {
        for (const k of AD_KEYS) {
          if (k in node) { delete node[k]; changed = true; }
        }
      }
      for (const key in node) {
        const v = node[key];
        if (v && typeof v === 'object' && stripAds(v, depth + 1)) changed = true;
      }
    } catch (_) { /* objeto sellado: se deja tal cual */ }
    return changed;
  }

  // 1) El primer video: ytInitialPlayerResponse lo asigna un script inline.
  try {
    let stored = window.ytInitialPlayerResponse;
    Object.defineProperty(window, 'ytInitialPlayerResponse', {
      configurable: true,
      get() { return stored; },
      set(v) { if (ytEnabled) stripAds(v); stored = v; }
    });
    if (stored) stripAds(stored);
  } catch (_) { /* si no se puede, queda el salto activo como respaldo */ }

  // 2) Los siguientes: llegan por fetch. Medido en vivo: la navegacion SPA usa
  //    /youtubei/v1/get_watch; /player sigue existiendo en otros flujos y los
  //    shorts usan los endpoints reel. Se poda el JSON de la respuesta.
  //    Cualquier fallo -> respuesta original intacta; jamas se bloquea ni se
  //    retiene la peticion (leccion de v10). /player/ad_break NO casa con este
  //    patron y se deja pasar a proposito.
  const PLAYER_ENDPOINT =
    /\/youtubei\/v1\/(player(\?|$)|get_watch(\?|$)|reel\/reel_watch_sequence(\?|$)|reel\/reel_item_watch(\?|$))/;
  const nativeFetch = window.fetch;

  window.fetch = function fetch(input, init) {
    const p = nativeFetch.apply(this, arguments);
    if (!ytEnabled) return p;

    let url = '';
    try {
      url = typeof input === 'string' ? input
          : (input instanceof Request ? input.url : String(input || ''));
    } catch (_) { return p; }
    if (!PLAYER_ENDPOINT.test(url)) return p;

    return p.then((resp) => {
      if (!resp || !resp.ok) return resp;
      return resp.clone().text().then((text) => {
        try {
          const data = JSON.parse(text);
          if (!stripAds(data)) return resp;
          return new Response(JSON.stringify(data), {
            status: resp.status,
            statusText: resp.statusText,
            headers: resp.headers
          });
        } catch (_) { return resp; }
      }).catch(() => resp);
    });
  };

  // ── Salto activo (respaldo, y unico recurso contra anuncios cosidos) ──────
  let savedMuted = false;
  let savedRate  = 1;
  let wasInAd    = false;

  const SKIP_SELECTOR = [
    '#ytp-skip-ad button',
    '.ytp-skip-ad-button',
    '.ytp-ad-skip-button-modern .ytp-ad-skip-button-slot',
    '.ytp-ad-skip-button',
    'button.ytp-ad-skip-button-modern',
    '.ytp-ad-skip-button-text',
    '[class*="ytp-ad-skip"]',
    '[class*="ytp-skip-ad"]',
  ].join(',');

  function visible(el) {
    return !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  }

  // La UNICA fuente fiable de "hay anuncio" es la clase del propio reproductor.
  // Detectar por presencia de nodos .ytp-ad-* se quedaba pegado: esos nodos
  // persisten ocultos al acabar el anuncio, inAd nunca volvia a false y el 16x
  // se aplicaba al video de verdad.
  function adIsShowing() {
    const p = document.getElementById('movie_player');
    return !!p && (p.classList.contains('ad-showing') ||
                   p.classList.contains('ad-interrupting'));
  }

  function skipAd() {
    if (!ytEnabled) return;

    const inAd = adIsShowing();
    const video = inAd || wasInAd
      ? document.querySelector('video.html5-main-video')
      : null;

    if (inAd && video) {
      if (!wasInAd) {
        savedMuted = video.muted;
        // Si el estado se reseteo a mitad de anuncio (cambio de URL), aqui se
        // capturaria el 16 de nuestro propio acelerado como "velocidad del
        // usuario". Ninguna velocidad legitima pasa de 2.
        const r = video.playbackRate || 1;
        savedRate  = r > 2 ? 1 : r;
        wasInAd    = true;
      }

      const skipBtn = document.querySelector(SKIP_SELECTOR);
      if (visible(skipBtn)) { skipBtn.click(); return; }

      // Sin boton: acelerar en silencio. No se toca currentTime, que es lo que
      // dejaba el reproductor en "cargando" indefinido.
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

  // ── Aviso "el reproductor se bloqueará" ───────────────────────────────────
  // YouTube detecta el bloqueo y planta un diálogo modal que pausa el vídeo
  // (medido en vivo 2026-07: ytd-enforcement-message-view-model dentro de un
  // tp-yt-paper-dialog, con backdrop; el <video> conserva su src y readyState 4,
  // así que solo está pausado).
  //
  // Se retira el diálogo y se reanuda lo que el usuario había puesto. NO se
  // pulsa ninguno de sus botones —ni "Permitir anuncios" ni "Probar Premium"—:
  // esas son decisiones suyas, igual que con los banners de cookies.
  const ENFORCE_SELECTOR = 'ytd-enforcement-message-view-model,yt-playability-error-supported-renderers';

  // Quitar el diálogo no basta: YouTube deja el vídeo pausado (verificado en
  // vivo: readyState 4 y 36 s ya en buffer, pero paused). Hay que reanudarlo
  // durante unos segundos — y dejar de insistir en cuanto el usuario toque
  // algo, para no pelearse con su propia pausa.
  let avisoRetiradoEn = 0;
  let ultimoGestoUsuario = 0;

  for (const t of ['pointerdown', 'keydown']) {
    window.addEventListener(t, (e) => {
      if (e.isTrusted) ultimoGestoUsuario = Date.now();
    }, true);
  }

  function clearEnforcement() {
    if (!ytEnabled) return;

    let aviso = null;
    try { aviso = document.querySelector(ENFORCE_SELECTOR); } catch (_) {}

    if (aviso) {
      const dialogo = aviso.closest('tp-yt-paper-dialog,ytd-popup-container') || aviso;
      try { dialogo.remove(); } catch (_) {}
      for (const b of document.querySelectorAll('tp-yt-iron-overlay-backdrop')) {
        try { b.remove(); } catch (_) {}
      }
      // El modal deja el scroll bloqueado en <html>.
      try {
        document.documentElement.style.removeProperty('overflow');
        if (document.body) document.body.style.removeProperty('overflow');
      } catch (_) {}
      avisoRetiradoEn = Date.now();
    }

    if (!avisoRetiradoEn) return;
    const desde = Date.now() - avisoRetiradoEn;
    if (desde > 10000) { avisoRetiradoEn = 0; return; }
    // Si el usuario ha tocado algo después del aviso, manda él. El >= importa:
    // con gesto y aviso en el mismo milisegundo, gana el usuario.
    if (ultimoGestoUsuario >= avisoRetiradoEn) { avisoRetiradoEn = 0; return; }

    const video = document.querySelector('video.html5-main-video') ||
                  document.querySelector('video');
    if (video && video.paused && video.readyState >= 2 && !adIsShowing()) {
      video.play().catch(() => {});
    }
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

  // Las mutaciones se agrupan en un solo barrido por frame, y solo sobre los
  // subarboles que acaban de aparecer.
  let pending = false;
  let dirty   = [];

  function schedule(root) {
    if (!ytEnabled) return;
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
    setInterval(() => { skipAd(); clearEnforcement(); }, 200);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

  // YouTube navega sin recargar: reiniciar el estado en cada video.
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
