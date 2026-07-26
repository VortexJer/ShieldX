// Arranca content.js con stubs mÃ­nimos para detectar ReferenceError / TDZ /
// selectores invÃ¡lidos, cosas que `node --check` no ve.
const fs = require('fs');
const path = require('path').join(__dirname, '..', 'content.js');

const listeners = {};
const el = () => ({
  setAttribute() {}, removeAttribute() {}, getAttribute: () => null,
  hasAttribute: () => false, remove() {}, appendChild() {}, click() {},
  querySelector: () => null, querySelectorAll: () => [],
  closest: () => null, children: [], style: { setProperty(){}, removeProperty(){} },
  textContent: '', innerText: '', tagName: 'DIV', id: '',
  getBoundingClientRect: () => ({ width: 0, height: 0 }),
  getClientRects: () => [], offsetWidth: 0, offsetHeight: 0,
});

const badSelectors = [];
global.document = {
  readyState: 'loading',
  documentElement: el(),
  head: el(),
  body: el(),
  createElement: el,
  getElementById: () => null,
  addEventListener() {},
  createDocumentFragment: () => ({
    querySelector(sel) {
      // Rechaza lo que un navegador rechazarÃ­a: parÃ©ntesis/corchetes sin cerrar
      const open = (sel.match(/\[/g) || []).length, close = (sel.match(/\]/g) || []).length;
      if (open !== close) { badSelectors.push(sel); throw new Error('selector invÃ¡lido'); }
      return null;
    }
  }),
  querySelectorAll: () => [],
};
global.window = {
  location: { hostname: 'www.google.com' },
  addEventListener: (t, f) => { listeners[t] = f; },
  dispatchEvent: () => {},
  innerWidth: 1280, innerHeight: 800,
};
global.performance = { now: () => 0 };
global.requestAnimationFrame = (f) => f();
global.CustomEvent = class { constructor(t, o) { this.type = t; Object.assign(this, o); } };
global.MutationObserver = class { observe() {} disconnect() {} };
global.location = global.window.location;

let storageCb = null;
global.chrome = {
  runtime: { id: 'test', sendMessage() {}, lastError: null, onMessage: { addListener() {} } },
  storage: {
    local: { get: (keys, cb) => { storageCb = cb; } },
    onChanged: { addListener() {} },
  },
};

const src = fs.readFileSync(path, 'utf8');
try {
  new Function(src)();
  // Simular la respuesta del storage: dispara applyState -> buildQueries -> start
  storageCb({ enabled: true, ytAdBlock: true, siteExcluded: [] });
  console.log('OK  content.js arranca y aplica estado');
  // Y ahora el camino de "sitio excluido" -> stop()
  storageCb({ enabled: true, ytAdBlock: true, siteExcluded: ['google.com'] });
  console.log('OK  camino de sitio excluido');
  storageCb({ enabled: false, ytAdBlock: false, siteExcluded: [] });
  console.log('OK  camino de pausa global');
  if (badSelectors.length) console.log('AVISO selectores invÃ¡lidos:', badSelectors);
} catch (e) {
  console.log('FALLO:', e.message);
  console.log(e.stack.split('\n').slice(0, 4).join('\n'));
  process.exit(1);
}

