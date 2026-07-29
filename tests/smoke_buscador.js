// Resultados patrocinados y meta-refresh. Lo primero es lo que más se nota si
// se equivoca (desaparece un resultado que querías), y lo segundo toca la
// navegación, así que un fallo se lleva al usuario a otra web.
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, '..', 'content.js'), 'utf8');

let fallos = 0;
function comprobar(desc, ok) {
  console.log((ok ? 'OK   ' : 'FALLO') + '  ' + desc);
  if (!ok) fallos++;
}
const dormir = (ms) => new Promise(r => setTimeout(r, ms));

// ── Mini-DOM con closest() y querySelectorAll de mentira pero coherentes ────
function nodo(o) {
  o = o || {};
  const a = {};
  const el = {
    tagName: (o.tag || 'div').toUpperCase(), id: o.id || '', className: o.cls || '',
    textContent: o.texto || '', children: o.hijos || [], parentElement: null,
    esBloque: !!o.esBloque,
    style: { setProperty() {}, removeProperty() {} },
    setAttribute(k, v) { a[k] = String(v); },
    getAttribute: (k) => (k in a ? a[k] : null),
    hasAttribute: (k) => k in a, removeAttribute(k) { delete a[k]; },
    remove() { el.quitado = true; }, append() {}, appendChild() {},
    querySelector: (sel) => (o.dentro || []).find(n => sel.includes(n.marca)) || null,
    querySelectorAll: (sel) => (o.dentro || []).filter(n => sel.includes(n.marca)),
    closest: (sel) => {
      let n = el.parentElement;
      while (n) { if (n.esBloque) return n; n = n.parentElement; }
      return null;
    },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 300, height: 100 }),
    getClientRects: () => [{}], offsetWidth: 300, offsetHeight: 100, attrs: a,
  };
  for (const h of el.children) h.parentElement = el;
  return el;
}
const oculto = (el) => el.attrs['data-sx'] === '1';

let hojas = [];      // los nodos de texto que se ofrecen como posibles etiquetas
let metas = [];

function montar(hostname) {
  const documentElement = nodo({ tag: 'html' });
  global.document = {
    readyState: 'complete', documentElement,
    body: nodo({ tag: 'body' }), head: nodo({ tag: 'head' }),
    createElement: () => nodo({}), getElementById: () => null,
    createDocumentFragment: () => ({ querySelector: () => null }),
    addEventListener() {}, removeEventListener() {},
    querySelectorAll(q) {
      if (q.includes('#center_col')) return [{ querySelectorAll: () => hojas }];
      if (q.includes('http-equiv')) return metas.filter(m => !m.hasAttribute('data-sx'));
      return [];
    },
    elementFromPoint: () => null,
    visibilityState: 'visible',
  };
  global.window = {
    location: { hostname, href: 'https://' + hostname + '/buscar?q=x' },
    innerWidth: 1280, innerHeight: 800,
    addEventListener() {}, removeEventListener() {}, dispatchEvent: () => {}, focus() {},
  };
  global.window.top = global.window;
  global.location = global.window.location;
  global.performance = { now: () => Date.now() };
  global.requestAnimationFrame = (f) => f();
  global.CustomEvent = class { constructor(t, o) { this.type = t; Object.assign(this, o); } };
  global.CSS = { escape: (s) => s };
  global.getComputedStyle = () => ({ position: 'static', overflow: 'visible', cursor: 'auto' });
  let observerCb = null;
  global.MutationObserver = class {
    constructor(cb) { observerCb = cb; }
    observe() {} disconnect() {}
  };
  let storageCb = null;
  global.chrome = {
    runtime: { id: 't', sendMessage() {}, lastError: null, onMessage: { addListener() {} } },
    storage: {
      local: { get: (k, cb) => { if (!storageCb) storageCb = cb; else cb({}); }, set() {} },
      onChanged: { addListener() {} },
    },
  };
  new Function(src)();
  storageCb({ enabled: true, ytAdBlock: true, guardEnabled: true, siteExcluded: [] });
  // El estado se aplica en un microtask, asi que el observer aun no existe.
  return async () => {
    await dormir(30);
    if (observerCb) observerCb([]);
    await dormir(400);
  };
}

// Una etiqueta suelta dentro de un bloque de resultado.
function resultado({ etiqueta, texto, bloqueId, conFormulario }) {
  const bloque = nodo({ tag: 'div', cls: 'MjjYud', texto: texto, esBloque: true,
                        id: bloqueId || '',
                        dentro: conFormulario ? [{ marca: 'input' }] : [] });
  const hoja = nodo({ tag: 'span', texto: etiqueta });
  hoja.parentElement = bloque;
  hojas.push(hoja);
  return bloque;
}

(async () => {
  // ── Resultados patrocinados ───────────────────────────────────────────────
  hojas = [];
  const pasada = montar('google.es');

  const anuncio    = resultado({ etiqueta: 'Patrocinado', texto: 'Compra ahora en tienda.example' });
  const anuncioEn  = resultado({ etiqueta: 'Sponsored',   texto: 'Buy now at shop.example' });
  const organico   = resultado({ etiqueta: 'hace 3 días', texto: 'Un artículo cualquiera sobre el tema' });
  const parecido   = resultado({ etiqueta: 'patrocinadores del evento', texto: 'Noticia sobre patrocinadores' });
  const conForm    = resultado({ etiqueta: 'Anuncio', texto: 'Bloque con formulario', conFormulario: true });
  const enorme     = resultado({ etiqueta: 'Anuncio', texto: 'x'.repeat(5000) });
  const estructura = resultado({ etiqueta: 'Anuncio', texto: 'contenedor', bloqueId: 'rso' });

  await pasada();

  comprobar('un resultado con "Patrocinado" se oculta', oculto(anuncio));
  comprobar('y con "Sponsored" tambien', oculto(anuncioEn));
  comprobar('un resultado organico se queda', !oculto(organico));
  comprobar('"patrocinadores del evento" NO cuenta como etiqueta', !oculto(parecido));
  comprobar('un bloque con formulario dentro no se toca', !oculto(conForm));
  comprobar('un bloque gigantesco (>4000 chars) no se toca', !oculto(enorme));
  comprobar('el contenedor de resultados (#rso) jamas se oculta', !oculto(estructura));

  // Fuera de un buscador no se mira ninguna etiqueta.
  hojas = [];
  const pasadaWeb = montar('www.tienda.es');
  const enTienda = resultado({ etiqueta: 'Patrocinado', texto: 'Seccion patrocinada de la tienda' });
  await pasadaWeb();
  comprobar('fuera de un buscador no se tocan las etiquetas', !oculto(enTienda));

  // ── Meta refresh ──────────────────────────────────────────────────────────
  metas = [];
  const pasada2 = montar('www.miweb.es');

  const aOtroDominio = nodo({ tag: 'meta' });
  aOtroDominio.getAttribute = (k) => (k === 'content' ? '0;url=https://sitio-scam.example/x' : null);
  const alMismo = nodo({ tag: 'meta' });
  alMismo.getAttribute = (k) => (k === 'content' ? '5;url=https://www.miweb.es/otra' : null);
  const aSubdominio = nodo({ tag: 'meta' });
  aSubdominio.getAttribute = (k) => (k === 'content' ? '0;url=https://blog.miweb.es/x' : null);
  const sinUrl = nodo({ tag: 'meta' });
  sinUrl.getAttribute = (k) => (k === 'content' ? '30' : null);
  const relativo = nodo({ tag: 'meta' });
  relativo.getAttribute = (k) => (k === 'content' ? '0;url=/otra-pagina' : null);
  const javascriptUrl = nodo({ tag: 'meta' });
  javascriptUrl.getAttribute = (k) => (k === 'content' ? '0;url=javascript:alert(1)' : null);

  metas = [aOtroDominio, alMismo, aSubdominio, sinUrl, relativo, javascriptUrl];
  await pasada2();

  comprobar('el meta-refresh hacia otro dominio se retira', aOtroDominio.quitado === true);
  comprobar('el que recarga la misma web se respeta', !alMismo.quitado);
  comprobar('el que va a un subdominio propio se respeta', !aSubdominio.quitado);
  comprobar('el refresh sin URL (recarga) se respeta', !sinUrl.quitado);
  comprobar('el refresh relativo se respeta', !relativo.quitado);
  comprobar('un refresh con javascript: no se toca (no es navegacion)',
    !javascriptUrl.quitado);

  console.log(fallos === 0 ? '\nTodo correcto' : `\n${fallos} fallo(s)`);
  process.exit(fallos === 0 ? 0 : 1);
})();
