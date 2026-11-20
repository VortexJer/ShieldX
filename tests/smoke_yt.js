// Arranque de youtube.js con stubs: comprueba el canal del toggle y que la
// limpieza de ytInitialPlayerResponse no rompe el objeto del reproductor.
const fs = require('fs');
const path = require('path').join(__dirname, '..', 'youtube.js');

let attr = null;
const listeners = {};
const el = () => ({
  setAttribute() {}, removeAttribute() {}, remove() {}, appendChild() {},
  getAttribute: () => null, querySelector: () => null, querySelectorAll: () => [],
  closest: () => null, click() {}, style: {}, id: '', textContent: '',
  firstElementChild: null, children: [],
  getBoundingClientRect: () => ({ width: 0, height: 0 }),
  getClientRects: () => [], offsetWidth: 0, offsetHeight: 0,
});

global.document = {
  readyState: 'complete',
  documentElement: Object.assign(el(), { getAttribute: () => attr }),
  head: el(), body: el(),
  createElement: el, getElementById: () => null,
  addEventListener() {}, querySelector: () => null, querySelectorAll: () => [],
};
// fetch nativo simulado: devuelve un playerResponse con anuncios y con los
// datos de video intactos, usando la clase Response real de Node.
const PLAYER_JSON = {
  // claves de anuncio en primer nivel Y anidadas (como en get_watch real)
  adPlacements: [{ a: 1 }], adSlots: [1], playerAds: [{ b: 2 }],
  contents: {
    watchData: {
      playerResponse: {
        videoDetails: { title: 'video' },
        streamingData: { formats: [1, 2], adaptiveFormats: [3] },
        adPlacements: [{ c: 3 }], adBreakHeartbeatParams: 'x',
      },
    },
  },
};
let fetchesNativos = 0;
let PLAYER_JSON_OVERRIDE = null;
function nativeFetchStub(url) {
  fetchesNativos++;
  return Promise.resolve(new Response(JSON.stringify(PLAYER_JSON_OVERRIDE || PLAYER_JSON), {
    status: 200, headers: { 'content-type': 'application/json' },
  }));
}

global.window = {
  location: { hostname: 'www.youtube.com', href: 'https://www.youtube.com/watch?v=x' },
  addEventListener: (t, f) => { listeners[t] = f; },
  // guard.js no corre aqui; youtube.js registra sus propios listeners de gesto
  fetch: nativeFetchStub,
};
global.location = global.window.location;
global.requestAnimationFrame = (f) => f();
global.MutationObserver = class { observe() {} disconnect() {} };
const timers = [];
global.setInterval = (f, ms) => { timers.push(f); return timers.length; };

try {
  new Function('window', fs.readFileSync(path, 'utf8')).call(global.window, global.window);
  console.log('OK  youtube.js arranca');

  // El reproductor asigna su respuesta: deben desaparecer sólo las claves de anuncio
  global.window.ytInitialPlayerResponse = {
    videoDetails: { title: 'vídeo' },
    streamingData: { formats: [1, 2] },
    adPlacements: [{ a: 1 }], playerAds: [{ b: 2 }], adSlots: [1],
  };
  const r = global.window.ytInitialPlayerResponse;
  const limpio = !('adPlacements' in r) && !('playerAds' in r) && !('adSlots' in r);
  const intacto = !!r.videoDetails && !!r.streamingData;
  console.log(limpio && intacto
    ? 'OK  anuncios eliminados y el resto del objeto intacto'
    : `FALLO limpio=${limpio} intacto=${intacto}`);

  global.window.ytInitialData = { contents: { items: [
    { videoRenderer: { videoId: 'a' } }, { richItemRenderer: { content: { adSlotRenderer: {} } } },
  ] } };
  const okData = global.window.ytInitialData.contents.items.length === 1;
  console.log((okData ? 'OK  ' : 'FALLO') + '  ytInitialData (portada/busqueda de la primera carga) sin anuncios');
  if (!okData) process.exit(1);

  // El evento de toggle con detail inválido no debe apagar el bloqueo
  attr = '1';
  listeners['__shieldx_yt_toggle']({ detail: null });
  console.log('OK  toggle con detail nulo no lanza');

  timers.forEach(f => f());   // un tick de skipAd
  console.log('OK  skipAd corre sin anuncio en pantalla');

  // Aviso "el reproductor se bloqueara": se retira el dialogo y se reanuda el
  // video, sin pulsar ninguno de sus botones.
  {
    let dialogoQuitado = false, backdropQuitado = false, play = 0, clics = 0;
    const dialogo = Object.assign(el(), {
      tagName: 'TP-YT-PAPER-DIALOG', remove() { dialogoQuitado = true; },
    });
    const aviso = Object.assign(el(), {
      tagName: 'YTD-ENFORCEMENT-MESSAGE-VIEW-MODEL',
      closest: (sel) => (sel.includes('paper-dialog') ? dialogo : null),
      // si alguien intentara pulsar los botones del aviso, se contabiliza
      querySelector: () => Object.assign(el(), { click() { clics++; } }),
    });
    const backdrop = Object.assign(el(), { remove() { backdropQuitado = true; } });
    const video = Object.assign(el(), {
      paused: true, readyState: 4, muted: false, playbackRate: 1,
      play() { play++; return Promise.resolve(); },
    });
    global.document.querySelector = (sel) => {
      if (sel.includes('enforcement-message')) return aviso;
      if (sel.includes('video')) return video;
      return null;
    };
    global.document.querySelectorAll = (sel) =>
      (sel.includes('iron-overlay-backdrop') ? [backdrop] : []);
    global.document.documentElement.style = { removeProperty() {} };
    global.document.body.style = { removeProperty() {} };

    timers.forEach(f => f());
    const ok = dialogoQuitado && backdropQuitado && play === 1 && clics === 0;
    console.log((ok ? 'OK  ' : 'FALLO') +
      '  aviso anti-adblock: dialogo fuera, video reanudado, sin pulsar botones');
    if (!ok) process.exit(1);

    // YouTube vuelve a pausar tras quitar el dialogo: se insiste unos segundos
    // aunque el aviso ya no este en el DOM.
    global.document.querySelector = (sel) =>
      (sel.includes('enforcement-message') ? null : (sel.includes('video') ? video : null));
    timers.forEach(f => f());
    const ok2 = play === 2;
    console.log((ok2 ? 'OK  ' : 'FALLO') +
      '  tras el aviso se reanuda aunque YouTube vuelva a pausar');
    if (!ok2) process.exit(1);

    // ...pero si el usuario pausa el, se le respeta y no se insiste mas.
    listeners['pointerdown']({ isTrusted: true });
    timers.forEach(f => f());
    timers.forEach(f => f());
    const ok3 = play === 2;
    console.log((ok3 ? 'OK  ' : 'FALLO') +
      '  si el usuario pausa despues del aviso, no se le lleva la contraria');
    if (!ok3) process.exit(1);

    // Restaurar los stubs para los casos de fetch de abajo.
    global.document.querySelector = () => null;
    global.document.querySelectorAll = () => [];
  }

  // Anuncio sin boton "Saltar" (formato 2026-11): se lleva al final. Pero si el
  // <video> dura lo mismo que el video real (getDuration del reproductor), es
  // el contenido con la clase ad-showing pegada y NO se toca.
  {
    const player = Object.assign(el(), {
      classList: { contains: (c) => c === 'ad-showing' },
      getDuration: () => 375,
    });
    const video = Object.assign(el(), {
      duration: 95, currentTime: 2, muted: false, playbackRate: 1, paused: false,
      readyState: 4, play() { return Promise.resolve(); },
    });
    global.document.getElementById = (id) => (id === 'movie_player' ? player : null);
    global.document.querySelector = (sel) => (sel.includes('video') ? video : null);
    timers.forEach(f => f());
    const salta = video.currentTime > 94 && video.muted;
    console.log((salta ? 'OK  ' : 'FALLO') + '  anuncio sin boton llevado a su final');
    if (!salta) process.exit(1);

    video.duration = 375; video.currentTime = 10;   // ya es el video real
    timers.forEach(f => f());
    const respeta = video.currentTime === 10;
    console.log((respeta ? 'OK  ' : 'FALLO') +
      '  con ad-showing pegado sobre el video real no se salta al final');
    if (!respeta) process.exit(1);

    global.document.getElementById = () => null;
    global.document.querySelector = () => null;
  }

  // Cambiar de video = carga completa (2026-11: navegar dentro de YouTube
  // castiga con ~12 s de espera; la carga completa arranca en ~3 s).
  {
    const asignadas = [];
    global.window.location.assign = (u) => asignadas.push(u);
    global.location.href = 'https://www.youtube.com/watch?v=AAA';
    global.location.origin = 'https://www.youtube.com';
    const clic = (href, extra, dentroDeBoton) => {
      let prevenido = false;
      const a = { getAttribute: () => href, target: '', contains: () => true };
      const t = { closest: (sel) => (sel === 'a[href]' ? a : (dentroDeBoton ? {} : null)) };
      listeners['click'](Object.assign({ button: 0, target: t,
        preventDefault() { prevenido = true; }, stopImmediatePropagation() {} }, extra || {}));
      return prevenido;
    };
    const casos = [
      [clic('/watch?v=BBB&list=X'), true, 'clic en otro video -> carga completa'],
      [clic('/watch?v=AAA&t=30s'), false, 'enlace al mismo video (minuto) -> se deja a YouTube'],
      [clic('/watch?v=BBB', { ctrlKey: true }), false, 'Ctrl+clic (pestaña nueva) se respeta'],
      [clic('/watch?v=BBB', null, true), false, 'boton dentro de la miniatura (Ver mas tarde) se respeta'],
      [clic('/results?search_query=x'), false, 'enlaces que no son de video no se tocan'],
    ];
    for (const [got, want, desc] of casos) {
      const ok = got === want;
      console.log((ok ? 'OK  ' : 'FALLO') + '  ' + desc);
      if (!ok) process.exit(1);
    }
    asignadas.length = 0;
    listeners['yt-navigate-start']({ detail: { pageType: 'watch', url: '/watch?v=CCC' } });
    const okNav = asignadas.length === 1 && asignadas[0].includes('v=CCC');
    console.log((okNav ? 'OK  ' : 'FALLO') + '  autoplay/siguiente (yt-navigate-start) -> carga completa');
    if (!okNav) process.exit(1);
  }

  // La poda de fetch: /player y /get_watch pierden los anuncios (esten al
  // nivel que esten) y conservan el video; ad_break y las URLs ajenas pasan
  // tal cual.
  (async () => {
    let fallos = 0;
    const caso = async (url, esperaPoda, desc) => {
      const r = await global.window.fetch(url);
      const d = await r.json();
      // el JSON de prueba anida un playerResponse con anuncios ademas de las
      // claves de primer nivel: la poda debe alcanzar ambos
      const quedanAds = JSON.stringify(d).includes('adPlacements');
      const intacto = JSON.stringify(d).includes('streamingData');
      const ok = esperaPoda ? (!quedanAds && intacto) : quedanAds;
      console.log((ok ? 'OK  ' : 'FALLO') + '  ' + desc);
      if (!ok) fallos++;
    };
    await caso('https://www.youtube.com/youtubei/v1/player?key=x', true,
      'fetch a /player podado en profundidad, video intacto');
    await caso('https://www.youtube.com/youtubei/v1/get_watch?prettyPrint=false', true,
      'fetch a /get_watch (el endpoint SPA real) podado');
    await caso('https://www.youtube.com/youtubei/v1/player/ad_break?prettyPrint=false', false,
      '/player/ad_break pasa sin tocar (bloquearlo es detectable)');
    await caso('https://www.youtube.com/youtubei/v1/guide', false,
      'URLs ajenas al reproductor pasan sin tocar');
    // get_watch: adSlots se deja como lista VACIA (medido 2026-11: es la
    // variante que antes arranca el video), no se borra la clave.
    {
      const r = await global.window.fetch('https://www.youtube.com/youtubei/v1/get_watch?x=1');
      const d = await r.json();
      const ok = Array.isArray(d.adSlots) && d.adSlots.length === 0;
      console.log((ok ? 'OK  ' : 'FALLO') + '  get_watch: adSlots vaciado (no borrado)');
      if (!ok) fallos++;
    }
    // browse/search/next: los elementos de anuncio salen de su lista y el
    // resto queda en su sitio y en orden.
    {
      PLAYER_JSON_OVERRIDE = {
        contents: { items: [
          { richItemRenderer: { content: { videoRenderer: { videoId: 'a' } } } },
          { richItemRenderer: { content: { adSlotRenderer: { x: 1 } } } },
          { promotedSparklesWebRenderer: {} },
          { videoRenderer: { videoId: 'b' } },
          { ticketShelfRenderer: {} },
          { richSectionRenderer: { content: { statementBannerRenderer: {} } } },
        ] },
      };
      for (const ep of ['browse', 'search', 'next']) {
        const r = await global.window.fetch('https://www.youtube.com/youtubei/v1/' + ep + '?k=1');
        const d = await r.json();
        const ids = d.contents.items.map(i => JSON.stringify(i));
        const ok = d.contents.items.length === 2 && ids[0].includes('"a"') && ids[1].includes('"b"');
        console.log((ok ? 'OK  ' : 'FALLO') + '  ' + ep + ': anuncios fuera de la lista, videos intactos y en orden');
        if (!ok) fallos++;
      }
      PLAYER_JSON_OVERRIDE = null;
    }
    if (fallos) process.exit(1);
  })();
} catch (e) {
  console.log('FALLO:', e.message);
  console.log(e.stack.split('\n').slice(0, 4).join('\n'));
  process.exit(1);
}

