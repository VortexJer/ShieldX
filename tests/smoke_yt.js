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
function nativeFetchStub(url) {
  fetchesNativos++;
  return Promise.resolve(new Response(JSON.stringify(PLAYER_JSON), {
    status: 200, headers: { 'content-type': 'application/json' },
  }));
}

global.window = {
  location: { hostname: 'www.youtube.com', href: 'https://www.youtube.com/watch?v=x' },
  addEventListener: (t, f) => { listeners[t] = f; },
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

  // El evento de toggle con detail inválido no debe apagar el bloqueo
  attr = '1';
  listeners['__shieldx_yt_toggle']({ detail: null });
  console.log('OK  toggle con detail nulo no lanza');

  timers.forEach(f => f());   // un tick de skipAd
  console.log('OK  skipAd corre sin anuncio en pantalla');

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
    await caso('https://www.youtube.com/youtubei/v1/browse', false,
      'URLs ajenas al reproductor pasan sin tocar');
    if (fallos) process.exit(1);
  })();
} catch (e) {
  console.log('FALLO:', e.message);
  console.log(e.stack.split('\n').slice(0, 4).join('\n'));
  process.exit(1);
}

