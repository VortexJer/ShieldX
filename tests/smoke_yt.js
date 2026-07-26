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
global.window = {
  location: { hostname: 'www.youtube.com', href: 'https://www.youtube.com/watch?v=x' },
  addEventListener: (t, f) => { listeners[t] = f; },
};
global.location = global.window.location;
global.requestAnimationFrame = (f) => f();
global.MutationObserver = class { observe() {} disconnect() {} };
const timers = [];
global.setInterval = (f, ms) => { timers.push(f); return timers.length; };

try {
  new Function('window', fs.readFileSync(path, 'utf8')).call(global.window, global.window);
  console.log('OK  youtube.js arranca');

  // El reproductor asigna su respuesta: deben desaparecer sÃ³lo las claves de anuncio
  global.window.ytInitialPlayerResponse = {
    videoDetails: { title: 'vÃ­deo' },
    streamingData: { formats: [1, 2] },
    adPlacements: [{ a: 1 }], playerAds: [{ b: 2 }], adSlots: [1],
  };
  const r = global.window.ytInitialPlayerResponse;
  const limpio = !('adPlacements' in r) && !('playerAds' in r) && !('adSlots' in r);
  const intacto = !!r.videoDetails && !!r.streamingData;
  console.log(limpio && intacto
    ? 'OK  anuncios eliminados y el resto del objeto intacto'
    : `FALLO limpio=${limpio} intacto=${intacto}`);

  // El evento de toggle con detail invÃ¡lido no debe apagar el bloqueo
  attr = '1';
  listeners['__shieldx_yt_toggle']({ detail: null });
  console.log('OK  toggle con detail nulo no lanza');

  timers.forEach(f => f());   // un tick de skipAd
  console.log('OK  skipAd corre sin anuncio en pantalla');
} catch (e) {
  console.log('FALLO:', e.message);
  console.log(e.stack.split('\n').slice(0, 4).join('\n'));
  process.exit(1);
}

