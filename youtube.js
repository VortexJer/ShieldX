// ShieldX – YouTube Ad Skipper v15 (ShieldX 11.9.1)
// Cambios v15 (formato nuevo de YouTube, medido en vivo 2026-11):
//  - Poda en los DATOS de todo lo que trae anuncios: reproductor (get_watch,
//    player, Shorts) y tambien feed, busqueda y columna lateral (browse,
//    search, next, ytInitialData). Los anuncios no llegan a pintarse.
//  - adSlots se deja como lista vacia en vez de borrarlo: de las variantes
//    medidas (12 navegaciones cada una) es la que antes arranca el video.
//  - Tras quitar el anuncio el servidor impone una espera (SABR backoff
//    firmado, ~10-15 s al navegar entre videos). Es del servidor: forzarla a 0
//    solo produce reintentos rechazados. Sin bloquear: 15-39 s con anuncios.
//  - Los anuncios que se cuelen ya no traen boton "Saltar": se llevan a su
//    final, con salvaguarda para no tocar nunca el video real.
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
    // vistos en vivo 2026-11
    'ytd-ticket-shelf-renderer', 'ytd-player-legacy-desktop-watch-ads-renderer',
    'ytd-ads-engagement-panel-content-renderer', 'ytd-brand-video-singleton-renderer',
    'ytd-brand-video-shelf-renderer', 'ytd-video-masthead-ad-v3-renderer',
    'ytd-primetime-promo-renderer', 'ytm-promoted-sparkles-web-renderer',
  ];

  const AD_TAG_SELECTOR = AD_TAG_SELECTOR_BUILD();
  function AD_TAG_SELECTOR_BUILD() { return AD_TAGS.join(','); }
  const AD_TAG_SET = new Set(AD_TAGS.map(t => t.toUpperCase()));

  const CSS = `
    #masthead-ad, #player-ads, #offer-module,
    ${AD_TAG_SELECTOR},
    ytd-rich-item-renderer:has(ytd-ad-slot-renderer),
    ytd-rich-section-renderer:has(ytd-statement-banner-renderer),
    ytd-rich-item-renderer:has(ad-badge-view-model),
    ytd-video-renderer:has(ad-badge-view-model),
    yt-lockup-view-model:has(ad-badge-view-model),
    ytd-reel-video-renderer:has(ytd-ad-slot-renderer),
    ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-ads"],
    .ytp-paid-content-overlay,
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

  // ── Poda de anuncios en los datos, antes de que se pinten ─────────────────
  // Dos tipos de poda, ambas profundas (get_watch incrusta el playerResponse a
  // niveles que cambian):
  //  a) Claves del reproductor: adPlacements, playerAds... se borran. adSlots se
  //     deja como lista VACIA: medido en vivo (2026-11, 12 navegaciones por
  //     variante) es lo que menos tarda en arrancar el video y no deja ver ni un
  //     fotograma de anuncio. Tras quitar el anuncio YouTube impone una espera
  //     desde el servidor (NextRequestPolicy.backoff en SABR, firmada): ponerla
  //     a 0 en el cliente solo provoca decenas de reintentos rechazados.
  //  b) Elementos de feed/busqueda/panel cuya unica razon de ser es un anuncio
  //     (adSlotRenderer, promotedSparkles..., ticketShelf...): se sacan de su
  //     lista, asi ni se pintan ni cuentan como impresion. El CSS de arriba
  //     sigue como red por si cambia el nombre de un renderer.
  const AD_KEYS = ['adPlacements', 'adSlots', 'playerAds', 'adBreakHeartbeatParams'];
  const AD_RENDERERS = new Set([
    'adSlotRenderer', 'promotedSparklesWebRenderer', 'promotedSparklesTextSearchRenderer',
    'promotedVideoRenderer', 'compactPromotedVideoRenderer', 'searchPyvRenderer',
    'displayAdRenderer', 'inFeedAdLayoutRenderer', 'statementBannerRenderer',
    'bannerPromoRenderer', 'actionCompanionAdRenderer', 'companionSlotRenderer',
    'merchandiseShelfRenderer', 'ticketShelfRenderer', 'brandVideoSingletonRenderer',
    'brandVideoShelfRenderer', 'adsEngagementPanelContentRenderer',
    'playerLegacyDesktopWatchAdsRenderer',
  ]);

  // ¿Este elemento de una lista es solo un envoltorio de anuncio?
  function isAdItem(item) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    for (const k in item) {
      if (AD_RENDERERS.has(k)) return true;
      const v = item[k];
      // richItemRenderer / richSectionRenderer / reelItem... -> { content: { adSlotRenderer } }
      if (v && typeof v === 'object' && v.content && typeof v.content === 'object') {
        for (const c in v.content) if (AD_RENDERERS.has(c)) return true;
      }
    }
    return false;
  }

  function stripAds(node, depth, emptySlots) {
    depth = depth || 0;
    if (!node || typeof node !== 'object' || depth > 40) return false;
    let changed = false;
    try {
      if (Array.isArray(node)) {
        for (let i = node.length - 1; i >= 0; i--) {
          if (isAdItem(node[i])) { node.splice(i, 1); changed = true; }
        }
      } else {
        for (const k of AD_KEYS) {
          if (!(k in node)) continue;
          if (k === 'adSlots' && emptySlots) {
            if (Array.isArray(node[k]) && node[k].length) { node[k] = []; changed = true; }
          } else { delete node[k]; changed = true; }
        }
      }
      for (const key in node) {
        const v = node[key];
        if (v && typeof v === 'object' && stripAds(v, depth + 1, emptySlots)) changed = true;
      }
    } catch (_) { /* objeto sellado: se deja tal cual */ }
    return changed;
  }

  // 1) Primera carga: ytInitialPlayerResponse (video) e ytInitialData (feed,
  //    busqueda, columna del video) los asigna un script inline.
  for (const name of ['ytInitialPlayerResponse', 'ytInitialData']) {
    try {
      let stored = window[name];
      Object.defineProperty(window, name, {
        configurable: true,
        get() { return stored; },
        set(v) { if (ytEnabled) stripAds(v); stored = v; }
      });
      if (stored && ytEnabled) stripAds(stored);
    } catch (_) { /* si no se puede, quedan el CSS y el salto como respaldo */ }
  }

  // 2) Lo demas llega por fetch: get_watch/player (navegacion entre videos),
  //    reel (Shorts), browse (portada, canales, continuaciones del feed),
  //    search y next (columna lateral, comentarios).
  //    Cualquier fallo -> respuesta original intacta; jamas se bloquea ni se
  //    retiene la peticion (leccion de v10). /player/ad_break NO casa con este
  //    patron y se deja pasar a proposito (bloquearlo es detectable).
  const DATA_ENDPOINT =
    /\/youtubei\/v1\/(player|get_watch|next|browse|search|reel\/reel_watch_sequence|reel\/reel_item_watch)(\?|$)/;
  const nativeFetch = window.fetch;

  window.fetch = function fetch(input, init) {
    const p = nativeFetch.apply(this, arguments);
    if (!ytEnabled) return p;

    let url = '';
    try {
      url = typeof input === 'string' ? input
          : (input instanceof Request ? input.url : String(input || ''));
    } catch (_) { return p; }
    if (!DATA_ENDPOINT.test(url)) return p;

    return p.then((resp) => {
      if (!resp || !resp.ok) return resp;
      return resp.clone().text().then((text) => {
        try {
          const data = JSON.parse(text);
          if (!stripAds(data, 0, true)) return resp;
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

  // Salvaguarda para el salto: durante el anuncio, getDuration() del
  // reproductor da la duracion del video REAL y el <video> la del anuncio
  // (medido: 375 frente a 95). Si coinciden, ese <video> ya es el contenido y
  // jamas se le salta al final, aunque la clase ad-showing siga pegada.
  function adVideoIsNotContent(video) {
    const d = video.duration;
    if (!isFinite(d) || d <= 0.5) return false;
    try {
      const p = document.getElementById('movie_player');
      const real = p && typeof p.getDuration === 'function' ? p.getDuration() : 0;
      return real > 0 && Math.abs(real - d) > 1;
    } catch (_) { return false; }
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

      // Sin boton (desde 2026-11 los anuncios vienen en tandas de 2 de hasta
      // ~3 min, sin "Saltar" ni interfaz): silenciar, acelerar y llevar el
      // anuncio a su final. Medido en vivo: el 16x real se queda en ~10x por el
      // bufer (35 s por tanda); saltando al final, <3 s. Tras el anuncio YouTube
      // impone unos segundos en negro (ad-display-override): eso es del
      // servidor y no se toca.
      video.muted = true;
      if (video.playbackRate !== 16) video.playbackRate = 16;
      if (adVideoIsNotContent(video) && video.currentTime < video.duration - 0.3) {
        video.currentTime = video.duration - 0.1;
      }
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

  // ── Cambiar de video con carga completa ───────────────────────────────────
  // Medido en vivo (2026-11): al navegar DENTRO de YouTube, get_watch trae el
  // anuncio en adSlots y, si se quita, el servidor castiga con una espera de
  // ~12 s (backoff SABR firmado). En una carga completa el anuncio viene por
  // adPlacements, se quita sin castigo y el video arranca en ~3 s. Asi que al
  // abrir otro video se recarga la pagina en vez de dejar que YouTube navegue.
  function watchTarget(u) {
    try {
      const x = new URL(u, location.href);
      if (x.origin !== location.origin || x.pathname !== '/watch') return null;
      const v = x.searchParams.get('v');
      if (!v) return null;
      const cur = new URL(location.href);
      // mismo video (p. ej. un enlace a un minuto concreto): no se recarga
      if (cur.pathname === '/watch' && cur.searchParams.get('v') === v) return null;
      return x;
    } catch (_) { return null; }
  }

  // Clic normal sobre un enlace a otro video. Se respetan Ctrl/Cmd/Shift/
  // clic central (pestaña nueva) y los botones que viven DENTRO de la
  // miniatura ("Ver mas tarde", "Añadir a la cola").
  window.addEventListener('click', (e) => {
    if (!ytEnabled || e.defaultPrevented || e.button !== 0 ||
        e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    const t = e.target;
    if (!t || !t.closest) return;
    const a = t.closest('a[href]');
    if (!a || (a.target && a.target !== '_self')) return;
    const btn = t.closest('button,[role="button"],ytd-thumbnail-overlay-toggle-button-renderer,yt-icon-button');
    if (btn && a.contains(btn)) return;
    const x = watchTarget(a.getAttribute('href'));
    if (!x) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    location.assign(x.href);
  }, true);

  // Lo que no pasa por un clic (reproduccion automatica, "siguiente" de una
  // lista, teclado): YouTube anuncia la navegacion y se convierte en carga.
  window.addEventListener('yt-navigate-start', (e) => {
    if (!ytEnabled) return;
    const d = e.detail || {};
    if (d.pageType !== 'watch' || typeof d.url !== 'string') return;
    const x = watchTarget(d.url);
    if (x) location.assign(x.href);
  }, true);

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
