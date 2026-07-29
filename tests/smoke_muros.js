// Muros de "desactiva tu bloqueador". Lo delicado aquí es no pasarse: hay
// artículos que HABLAN de bloqueadores, avisos discretos que no tapan nada, y
// muros de pago de verdad — y ninguno de los tres se toca.
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, '..', 'content.js'), 'utf8');

let fallos = 0;
function comprobar(desc, ok) {
  console.log((ok ? 'OK   ' : 'FALLO') + '  ' + desc);
  if (!ok) fallos++;
}
const dormir = (ms) => new Promise(r => setTimeout(r, ms));

// ── Mini-DOM ────────────────────────────────────────────────────────────────
let candidatos = [];
const estiloDe = new Map();

function nodo(o) {
  o = o || {};
  const a = {};
  const est = {};
  const el = {
    tagName: o.tag || 'DIV', id: o.id || '', className: o.cls || '',
    textContent: o.texto || '', children: [], parentElement: o.padre || null,
    estilos: est,
    style: { setProperty(k, v) { est[k] = v; }, removeProperty(k) { delete est[k]; } },
    setAttribute(k, v) { a[k] = String(v); },
    getAttribute: (k) => (k in a ? a[k] : null),
    hasAttribute: (k) => k in a,
    removeAttribute(k) { delete a[k]; },
    remove() { el.quitado = true; }, append() {}, appendChild() {},
    focus() {}, blur() {},
    querySelector: () => null, querySelectorAll: () => [], closest: () => null,
    getBoundingClientRect: () => ({
      left: 0, top: 0,
      width: o.w != null ? o.w : 1280,
      height: o.h != null ? o.h : 700,
    }),
    getClientRects: () => [{}], offsetWidth: 1280, offsetHeight: 700, attrs: a,
  };
  estiloDe.set(el, { position: o.pos || 'fixed', overflow: 'visible', cursor: 'auto' });
  return el;
}
const oculto = (el) => el.attrs['data-sx'] === '1';

const documentElement = nodo({ tag: 'HTML', pos: 'static' });
const body = nodo({ tag: 'BODY', pos: 'static' });

global.document = {
  readyState: 'complete', documentElement, body, head: nodo({ tag: 'HEAD' }),
  createElement: () => nodo({}), getElementById: () => null,
  createDocumentFragment: () => ({ querySelector: () => null }),
  addEventListener() {}, removeEventListener() {},
  querySelectorAll(q) {
    if (q.includes('div:not([data-sx-aab])')) {
      return candidatos.filter(n => !n.hasAttribute('data-sx-aab'));
    }
    return [];
  },
  elementFromPoint: () => null,
  visibilityState: 'visible',
};
const handlers = {};
global.window = {
  location: { hostname: 'www.periodico.es' }, innerWidth: 1280, innerHeight: 800,
  addEventListener(t, f) { (handlers[t] = handlers[t] || []).push(f); },
  removeEventListener() {}, dispatchEvent: () => {}, focus() {},
};
global.window.top = global.window;
global.location = global.window.location;
global.performance = { now: () => Date.now() };
global.requestAnimationFrame = (f) => f();
global.CustomEvent = class { constructor(t, o) { this.type = t; Object.assign(this, o); } };
global.CSS = { escape: (s) => s };
let observerCb = null;
global.MutationObserver = class {
  constructor(cb) { observerCb = cb; }
  observe() {} disconnect() {}
};
global.getComputedStyle = (el) =>
  estiloDe.get(el) || { position: 'static', overflow: 'visible', cursor: 'auto' };

let storageCb = null;
global.chrome = {
  runtime: { id: 't', sendMessage() {}, lastError: null, onMessage: { addListener() {} } },
  storage: {
    local: { get: (k, cb) => { if (!storageCb) storageCb = cb; else cb(estado); }, set() {} },
    onChanged: { addListener() {} },
  },
};

const estado = { enabled: true, ytAdBlock: true, guardEnabled: true,
                 siteExcluded: [], antiAdblockWalls: true };

new Function(src)();
const pasada = async () => { observerCb([]); await dormir(400); };

(async () => {
  storageCb(estado);
  await dormir(30);

  // ── 1. El muro de verdad ──────────────────────────────────────────────────
  const muro = nodo({
    texto: 'Vaya, parece que usas un bloqueador de anuncios. Desactiva tu bloqueador para seguir leyendo este artículo.',
    w: 1280, h: 700, pos: 'fixed',
  });
  candidatos.push(muro);
  await pasada();
  comprobar('el muro que tapa la pantalla se retira', oculto(muro));

  // ── 2. Lo que NO se toca ──────────────────────────────────────────────────
  const casos = [
    ['un articulo QUE HABLA de bloqueadores (texto largo)', nodo({
      texto: 'Los bloqueadores de anuncios han cambiado la web. '.repeat(20) +
             ' Muchos usuarios desactivan su bloqueador en las webs que les gustan.',
      w: 800, h: 2000, pos: 'static',
    })],
    ['un aviso discreto que no tapa nada', nodo({
      texto: 'Usas un bloqueador de anuncios. Puedes desactivarlo si quieres apoyarnos.',
      w: 300, h: 60, pos: 'static',
    })],
    ['un muro de pago (no menciona bloqueadores)', nodo({
      texto: 'Este contenido es solo para suscriptores. Suscríbete por 1 € al mes para seguir leyendo.',
      w: 1280, h: 700, pos: 'fixed',
    })],
    ['un aviso de cookies a pantalla completa', nodo({
      texto: 'Usamos cookies propias y de terceros. Puedes aceptar o configurar tus preferencias.',
      w: 1280, h: 700, pos: 'fixed',
    })],
    ['una capa que solo dice "publicidad"', nodo({
      texto: 'Publicidad', w: 1280, h: 700, pos: 'fixed',
    })],
  ];
  for (const [desc, n] of casos) candidatos.push(n);
  await pasada();
  for (const [desc, n] of casos) comprobar(desc + ': intacto', !oculto(n));

  // ── 3. Muro que no tapa pero deja sin scroll ──────────────────────────────
  estiloDe.get(document.body).overflow = 'hidden';
  const muroConScrollBloqueado = nodo({
    texto: 'Detectamos un adblocker. Desactívalo para continuar.',
    w: 500, h: 300, pos: 'fixed',
  });
  candidatos.push(muroConScrollBloqueado);
  await pasada();
  comprobar('un muro pequeño que bloquea el scroll tambien se retira',
    oculto(muroConScrollBloqueado));
  comprobar('y se devuelve el scroll a la pagina',
    document.body.estilos.overflow === 'visible' ||
    documentElement.estilos.overflow === 'visible');
  estiloDe.get(document.body).overflow = 'visible';

  // ── 4. El backdrop del muro se va con el ──────────────────────────────────
  const fondo = nodo({ w: 1280, h: 800, pos: 'fixed', texto: '' });
  const dentro = nodo({
    texto: 'Por favor, desactiva el bloqueador de anuncios para ver el contenido.',
    w: 600, h: 400, pos: 'absolute', padre: fondo,
  });
  fondo.textContent = dentro.textContent;   // el fondo no tiene mas contenido
  candidatos.push(dentro);
  await pasada();
  comprobar('el muro se retira', oculto(dentro));
  comprobar('y su fondo oscuro tambien', oculto(fondo));

  // ── 5. El interruptor lo apaga ────────────────────────────────────────────
  estado.antiAdblockWalls = false;
  storageCb(estado);              // simula storage.onChanged
  await dormir(30);
  const otroMuro = nodo({
    texto: 'Desactiva tu bloqueador de anuncios para continuar navegando.',
    w: 1280, h: 700, pos: 'fixed',
  });
  candidatos.push(otroMuro);
  await pasada();
  comprobar('con el interruptor en OFF no se toca ningun muro', !oculto(otroMuro));

  console.log(fallos === 0 ? '\nTodo correcto' : `\n${fallos} fallo(s)`);
  process.exit(fallos === 0 ? 0 : 1);
})();
