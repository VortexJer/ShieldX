// El generador de selectores del picker. Es la pieza que puede hacer más daño
// en silencio: un selector demasiado laxo oculta media portada y el usuario no
// entiende por qué. Ya pasó una vez — una ruta relajada empató con 91
// artículos de Marca— y de ahí salió la regla de anclar cada nivel.
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, '..', 'content.js'), 'utf8');

let fallos = 0;
function comprobar(desc, ok) {
  console.log((ok ? 'OK   ' : 'FALLO') + '  ' + desc);
  if (!ok) fallos++;
}

// ── Un DOM de juguete con querySelectorAll de verdad ────────────────────────
// Se construye un árbol y se resuelven a mano los pocos tipos de selector que
// genera selectorFor: #id, tag.clase.clase y rutas de :nth-child.
function crear(tag, props) {
  const el = Object.assign({
    tagName: tag.toUpperCase(), id: '', clases: [], children: [], parentElement: null,
  }, props || {});
  el.classList = el.clases;
  for (const h of el.children) h.parentElement = el;
  return el;
}

function todos(raiz) {
  const out = [];
  (function rec(n) { out.push(n); for (const h of n.children) rec(h); })(raiz);
  return out;
}

function casa(el, sel, raiz) {
  sel = sel.trim();
  if (sel.includes('>')) {
    const partes = sel.split('>').map(s => s.trim());
    let n = el;
    for (let i = partes.length - 1; i >= 0; i--) {
      if (!n || !casaSimple(n, partes[i], raiz)) return false;
      n = n.parentElement;
    }
    return true;
  }
  return casaSimple(el, sel, raiz);
}

function casaSimple(el, sel, raiz) {
  if (sel === 'body') return el.tagName === 'BODY';
  if (sel.startsWith('#')) return el.id === sel.slice(1);
  const m = sel.match(/^([a-z0-9]+)?((?:\.[^.:]+)*)(?::nth-child\((\d+)\))?$/i);
  if (!m) return false;
  const [, tag, clases, nth] = m;
  if (tag && el.tagName !== tag.toUpperCase()) return false;
  if (clases) {
    for (const c of clases.split('.').filter(Boolean)) {
      if (!el.clases.includes(c)) return false;
    }
  }
  if (nth) {
    const p = el.parentElement;
    if (!p) return false;
    if (p.children.indexOf(el) + 1 !== Number(nth)) return false;
  }
  return true;
}

function montar(raiz) {
  const lista = todos(raiz);
  global.document = {
    documentElement: raiz,
    body: lista.find(n => n.tagName === 'BODY') || raiz,
    querySelectorAll: (sel) => lista.filter(n => casa(n, sel, raiz)),
    createDocumentFragment: () => ({ querySelector: () => null }),
    getElementById: () => null,
    addEventListener() {}, removeEventListener() {},
    createElement: () => crear('div'),
  };
  global.window = {
    location: { hostname: 'www.ejemplo.es' }, innerWidth: 1280, innerHeight: 800,
    addEventListener() {}, removeEventListener() {}, dispatchEvent: () => {}, focus() {},
  };
  global.window.top = global.window;
  global.location = global.window.location;
  global.performance = { now: () => 0 };
  global.requestAnimationFrame = (f) => f();
  global.CustomEvent = class {};
  global.MutationObserver = class { observe() {} disconnect() {} };
  global.getComputedStyle = () => ({ position: 'static', overflow: 'visible', cursor: 'auto' });
  global.CSS = { escape: (s) => s };
  global.chrome = {
    runtime: { id: 't', sendMessage() {}, lastError: null, onMessage: { addListener() {} } },
    storage: { local: { get() {}, set() {} }, onChanged: { addListener() {} } },
  };
  // selectorFor no se exporta: se saca del fuente junto con su ayudante.
  const desde = src.indexOf('function cssEscapeSafe');
  const hasta = src.indexOf('let picking');
  return new Function('document', 'CSS',
    src.slice(desde, hasta) + '; return selectorFor;')(global.document, global.CSS);
}

// ── Casos ───────────────────────────────────────────────────────────────────
// 1. Con id único, se usa el id.
{
  const objetivo = crear('div', { id: 'banner-molesto', clases: ['x'] });
  const raiz = crear('html', { children: [crear('body', { children: [objetivo] })] });
  const selectorFor = montar(raiz);
  const sel = selectorFor(objetivo);
  comprobar('con id unico se usa el id', sel === '#banner-molesto');
  comprobar('y solo casa con un elemento', document.querySelectorAll(sel).length === 1);
}

// 2. Sin id, tag + clases estables si son únicas.
{
  const objetivo = crear('aside', { clases: ['promo', 'lateral'] });
  const otro = crear('aside', { clases: ['otra'] });
  const raiz = crear('html', { children: [crear('body', { children: [otro, objetivo] })] });
  const selectorFor = montar(raiz);
  const sel = selectorFor(objetivo);
  comprobar('sin id se usan tag y clases', sel === 'aside.promo.lateral');
  comprobar('y sigue casando con uno solo', document.querySelectorAll(sel).length === 1);
}

// 3. Clases con pinta autogenerada: NO se usan (cambian en cada build).
{
  const objetivo = crear('div', { clases: ['css-1x2y3z', 'sc-AbCdEf', 'js-toggle', '_hash123'] });
  const hermano = crear('div', { clases: ['otra'] });
  const raiz = crear('html', { children: [crear('body', { children: [hermano, objetivo] })] });
  const selectorFor = montar(raiz);
  const sel = selectorFor(objetivo);
  comprobar('las clases autogeneradas se descartan',
    !/css-|sc-|js-|_hash/.test(sel));
  comprobar('y se cae a la ruta anclada', sel.includes(':nth-child'));
  comprobar('la ruta casa con uno solo', document.querySelectorAll(sel).length === 1);
}

// 4. EL CASO DE MARCA: muchos hermanos idénticos. La ruta debe distinguirlos.
{
  const articulos = [];
  for (let i = 0; i < 91; i++) articulos.push(crear('article', { clases: ['ue-c-cover-content'] }));
  const contenedor = crear('div', { clases: ['portada'], children: articulos });
  const raiz = crear('html', { children: [crear('body', { children: [contenedor] })] });
  const selectorFor = montar(raiz);

  let peor = 0;
  for (const a of articulos) {
    const n = document.querySelectorAll(selectorFor(a)).length;
    if (n > peor) peor = n;
  }
  comprobar('con 91 hermanos identicos, cada selector casa con UNO (el fallo de Marca)',
    peor === 1);
}

// 5. La ruta se ancla en el primer id único que encuentra subiendo.
{
  const objetivo = crear('span', {});
  const medio = crear('div', { children: [objetivo] });
  const conId = crear('section', { id: 'contenido-principal', children: [medio] });
  const raiz = crear('html', { children: [crear('body', { children: [conId] })] });
  const selectorFor = montar(raiz);
  const sel = selectorFor(objetivo);
  comprobar('la ruta se ancla en el id de un ancestro',
    sel.startsWith('#contenido-principal'));
  comprobar('y no sube mas alla', !sel.includes('body'));
  comprobar('casando con uno solo', document.querySelectorAll(sel).length === 1);
}

// 6. Un id repetido (HTML mal hecho) no vale como ancla.
{
  const objetivo = crear('div', { id: 'repetido' });
  const gemelo = crear('div', { id: 'repetido' });
  const raiz = crear('html', { children: [crear('body', { children: [gemelo, objetivo] })] });
  const selectorFor = montar(raiz);
  const sel = selectorFor(objetivo);
  comprobar('un id duplicado no se usa como selector', sel !== '#repetido');
  comprobar('y lo que se genera distingue al elegido',
    document.querySelectorAll(sel).length === 1);
}

// 7. Elemento muy anidado: la ruta no crece sin límite.
{
  let nodo = crear('span', {});
  const objetivo = nodo;
  for (let i = 0; i < 30; i++) nodo = crear('div', { children: [nodo] });
  const raiz = crear('html', { children: [crear('body', { children: [nodo] })] });
  const selectorFor = montar(raiz);
  const sel = selectorFor(objetivo);
  comprobar('la ruta se corta a 20 niveles',
    sel.split('>').length <= 21 && sel.length > 0);
}

console.log(fallos === 0 ? '\nTodo correcto' : `\n${fallos} fallo(s)`);
process.exit(fallos === 0 ? 0 : 1);
