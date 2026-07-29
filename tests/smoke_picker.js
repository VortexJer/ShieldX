// El picker ("SEÑALAR"): cómo se entra, cómo se sale y qué selector genera.
// La salida es lo que más fallaba: el ESC dependía de que la página tuviera el
// foco del teclado, y al abrirlo desde el popup el foco se queda en la interfaz
// del navegador. Aquí se comprueban las tres salidas y que ninguna oculta nada.
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, '..', 'content.js'), 'utf8');

let fallos = 0;
function comprobar(desc, ok) {
  console.log((ok ? 'OK   ' : 'FALLO') + '  ' + desc);
  if (!ok) fallos++;
}

// ── Mini-DOM ────────────────────────────────────────────────────────────────
function crear(tag) {
  const hijos = [];
  const el = {
    tagName: (tag || 'div').toUpperCase(),
    id: '', className: '', textContent: '', children: hijos, classList: [],
    style: { cssText: '', setProperty() {}, removeProperty() {}, pointerEvents: '' },
    parentElement: null, quitado: false,
    append(...n) { for (const x of n) { hijos.push(x); x.parentElement = el; } },
    appendChild(n) { hijos.push(n); n.parentElement = el; return n; },
    remove() { el.quitado = true; },
    setAttribute() {}, removeAttribute() {}, getAttribute: () => null,
    hasAttribute: () => false, focus() { foco = el; }, blur() {},
    querySelector: () => null, querySelectorAll: () => [], closest: () => null,
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 100, height: 50 }),
    getClientRects: () => [], offsetWidth: 100, offsetHeight: 50,
  };
  return el;
}

let foco = null;
const winHandlers = {};
const docHandlers = {};
const documentElement = crear('html');

global.document = {
  readyState: 'complete', documentElement,
  head: crear('head'), body: crear('body'),
  createElement: crear, getElementById: () => null,
  createDocumentFragment: () => ({ querySelector: () => null }),
  addEventListener(t, f) { (docHandlers[t] = docHandlers[t] || []).push(f); },
  removeEventListener(t, f) {
    if (!docHandlers[t]) return;
    docHandlers[t] = docHandlers[t].filter(x => x !== f);
  },
  querySelectorAll: () => [], elementFromPoint: () => null,
  get activeElement() { return foco; },
};
global.window = {
  location: { hostname: 'www.ejemplo.es' }, innerWidth: 1280, innerHeight: 800,
  addEventListener(t, f) { (winHandlers[t] = winHandlers[t] || []).push(f); },
  removeEventListener(t, f) {
    if (!winHandlers[t]) return;
    winHandlers[t] = winHandlers[t].filter(x => x !== f);
  },
  dispatchEvent: () => {}, focus() {},
};
global.window.top = global.window;
global.location = global.window.location;
global.performance = { now: () => Date.now() };
global.requestAnimationFrame = (f) => f();
global.CustomEvent = class { constructor(t, o) { this.type = t; Object.assign(this, o); } };
global.MutationObserver = class { observe() {} disconnect() {} };
global.getComputedStyle = () => ({ position: 'static', overflow: 'visible', cursor: 'auto' });
global.CSS = { escape: (s) => s };

let guardado = null;
let onMsg = null;
global.chrome = {
  runtime: {
    id: 'test', sendMessage() {}, lastError: null,
    onMessage: { addListener(f) { onMsg = f; } },
  },
  storage: {
    local: {
      get: (k, cb) => { if (typeof cb === 'function' && Array.isArray(k) && k.includes('customHidden')) cb({}); },
      set: (v) => { guardado = v; },
    },
    onChanged: { addListener() {} },
  },
};
// El arranque pide el estado; se responde activo.
const getOriginal = global.chrome.storage.local.get;
let storageCb = null;
global.chrome.storage.local.get = (k, cb) => {
  if (!storageCb) { storageCb = cb; return; }   // la primera es la del arranque
  cb({});                                        // las siguientes, del picker
};

new Function(src)();
storageCb({ enabled: true, ytAdBlock: true, guardEnabled: true, siteExcluded: [] });

// ── Utilidades ──────────────────────────────────────────────────────────────
const abrirPicker = () => onMsg({ type: 'PICK_START' }, { id: 'test' });
const disparar = (mapa, tipo, ev) => { for (const f of mapa[tipo] || []) f(ev); };
const cartelVisible = () => documentElement.children.some(c => !c.quitado && c.tagName === 'DIV');
const evento = (extra) => Object.assign({
  preventDefault() {}, stopPropagation() {}, target: crear('span'),
}, extra || {});

// ── Casos ───────────────────────────────────────────────────────────────────
// content.js ya tenia su propio keydown en window (el registro de gestos), asi
// que lo que se mide es el delta que anade el picker, no el total.
const keydownBase = (winHandlers['keydown'] || []).length;
const delta = () => (winHandlers['keydown'] || []).length - keydownBase;

abrirPicker();
comprobar('el picker pinta su cartel al arrancar', cartelVisible());
comprobar('el picker toma el foco del teclado (causa de que el ESC no fuera)',
  foco === documentElement);
comprobar('escucha el teclado en window Y en document (doble red)',
  delta() === 1 && (docHandlers['keydown'] || []).length === 1);

// 1. Salida por ESC.
disparar(winHandlers, 'keydown', evento({ key: 'Escape' }));
comprobar('ESC cierra el picker', !cartelVisible());
comprobar('ESC no guarda ningun selector', guardado === null);
comprobar('al salir se retiran los listeners de window', delta() === 0);
comprobar('y tambien el de document', (docHandlers['keydown'] || []).length === 0);

// 2. Salida por ESC recibido en document (el caso del foco raro).
abrirPicker();
disparar(docHandlers, 'keydown', evento({ key: 'Escape' }));
comprobar('ESC recibido en document tambien cierra', !cartelVisible());

// 3. Teclado antiguo: e.key = "Esc" y keyCode 27.
abrirPicker();
disparar(winHandlers, 'keydown', evento({ key: 'Esc' }));
comprobar('la tecla "Esc" antigua tambien cierra', !cartelVisible());
abrirPicker();
disparar(winHandlers, 'keydown', evento({ key: undefined, keyCode: 27 }));
comprobar('keyCode 27 tambien cierra', !cartelVisible());

// 4. Salida por clic derecho.
abrirPicker();
disparar(winHandlers, 'contextmenu', evento({}));
comprobar('el clic derecho sale del picker', !cartelVisible());
comprobar('el clic derecho tampoco guarda nada', guardado === null);

// 5. Salida por el boton SALIR del cartel: no debe ocultar el propio cartel.
abrirPicker();
const cartel = documentElement.children.filter(c => !c.quitado).pop();
const botonSalir = cartel.children[cartel.children.length - 1];
disparar(winHandlers, 'click', evento({ target: botonSalir, composedPath: () => [botonSalir, cartel] }));
comprobar('el boton SALIR cierra el picker', !cartelVisible());
comprobar('el boton SALIR no guarda un selector del cartel', guardado === null);

// 6. Reentrada: abrir dos veces seguidas no duplica listeners.
abrirPicker();
abrirPicker();
comprobar('abrir el picker dos veces no duplica los listeners', delta() === 1);
disparar(winHandlers, 'keydown', evento({ key: 'Escape' }));

// 7. Salir dos veces seguidas no revienta.
let exploto = false;
try { disparar(winHandlers, 'keydown', evento({ key: 'Escape' })); } catch (_) { exploto = true; }
comprobar('salir dos veces no lanza', !exploto);

console.log(fallos === 0 ? '\nTodo correcto' : `\n${fallos} fallo(s)`);
process.exit(fallos === 0 ? 0 : 1);
