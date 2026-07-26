// Arranca content.js con stubs mínimos para detectar ReferenceError / TDZ /
// selectores inválidos, y comprobar en qué sitios entra la capa de ocultado.
const fs = require('fs');
const path = require('path').join(__dirname, '..', 'content.js');
const src = fs.readFileSync(path, 'utf8');

let fallos = 0;
function comprobar(desc, ok) {
  console.log((ok ? 'OK   ' : 'FALLO') + '  ' + desc);
  if (!ok) fallos++;
}

// ── Arranque de content.js sobre un host dado ───────────────────────────────
function arrancar(hostname, estado) {
  const atributos = {};
  let cssInyectado = false;
  const cssIds = new Set();

  const el = () => ({
    setAttribute() {}, removeAttribute() {}, getAttribute: () => null,
    hasAttribute: () => false, remove() {}, click() {},
    appendChild(hijo) {
      if (hijo && hijo.id) cssIds.add(hijo.id);
      if (hijo && hijo.id === 'shieldx-css') cssInyectado = true;
    },
    querySelector: () => null, querySelectorAll: () => [],
    closest: () => null, children: [], style: { setProperty() {}, removeProperty() {} },
    textContent: '', innerText: '', tagName: 'DIV', id: '',
    getBoundingClientRect: () => ({ width: 0, height: 0 }),
    getClientRects: () => [], offsetWidth: 0, offsetHeight: 0,
  });

  const documentElement = Object.assign(el(), {
    setAttribute(k, v) { atributos[k] = v; },
    getAttribute: (k) => (k in atributos ? atributos[k] : null),
  });

  const selectoresInvalidos = [];
  global.document = {
    readyState: 'loading',
    documentElement, head: el(), body: el(),
    createElement: (tag) => Object.assign(el(), { tagName: (tag || 'div').toUpperCase() }),
    getElementById: () => null,
    addEventListener() {},
    createDocumentFragment: () => ({
      querySelector(sel) {
        const abre = (sel.match(/\[/g) || []).length, cierra = (sel.match(/\]/g) || []).length;
        if (abre !== cierra) { selectoresInvalidos.push(sel); throw new Error('selector invalido'); }
        return null;
      }
    }),
    querySelectorAll: () => [],
    elementFromPoint: () => null,
  };
  global.window = {
    location: { hostname },
    addEventListener() {},
    dispatchEvent: () => {},
    innerWidth: 1280, innerHeight: 800,
  };
  global.location = global.window.location;
  global.performance = { now: () => 0 };
  global.requestAnimationFrame = (f) => f();
  global.CustomEvent = class { constructor(t, o) { this.type = t; Object.assign(this, o); } };
  global.MutationObserver = class { observe() {} disconnect() {} };
  global.getComputedStyle = () => ({ position: 'static', cursor: 'auto', display: 'block' });

  let storageCb = null;
  global.chrome = {
    runtime: { id: 'test', sendMessage() {}, lastError: null, onMessage: { addListener() {} } },
    storage: {
      local: { get: (keys, cb) => { storageCb = cb; } },
      onChanged: { addListener() {} },
    },
  };

  new Function(src)();
  storageCb(estado);
  return { cssInyectado, atributos, selectoresInvalidos, cssIds };
}

const ACTIVO = { enabled: true, ytAdBlock: true, guardEnabled: true, siteExcluded: [] };

try {
  // 1. Web normal: la capa de ocultado entra.
  let r = arrancar('www.eldiario.es', ACTIVO);
  comprobar('en una web normal se inyecta el CSS de bloqueo', r.cssInyectado === true);
  comprobar('el anti-redireccion queda activo', r.atributos['data-shieldx-guard'] === '1');
  comprobar('sin selectores invalidos', r.selectoresInvalidos.length === 0);
  if (r.selectoresInvalidos.length) console.log('   ', r.selectoresInvalidos);

  // 2. Clientes de correo: NUNCA se oculta nada, pero el resto sigue.
  for (const host of ['mail.google.com', 'outlook.live.com', 'webmail.uc3m.es', 'mail.proton.me']) {
    r = arrancar(host, ACTIVO);
    comprobar(`en ${host} no se inyecta CSS de bloqueo`, r.cssInyectado === false);
    comprobar(`en ${host} el anti-redireccion sigue activo`, r.atributos['data-shieldx-guard'] === '1');
  }

  // 3. Otras aplicaciones de Google no son el buscador: sus clases ofuscadas
  //    podrian coincidir por casualidad con las de los anuncios de busqueda.
  r = arrancar('drive.google.com', ACTIVO);
  comprobar('drive.google.com bloquea anuncios (no es cliente de correo)', r.cssInyectado === true);

  // 4. Sitio excluido por el usuario: no entra nada.
  r = arrancar('www.eldiario.es', Object.assign({}, ACTIVO, { siteExcluded: ['eldiario.es'] }));
  comprobar('sitio excluido: sin CSS', r.cssInyectado === false);
  comprobar('sitio excluido: sin anti-redireccion', r.atributos['data-shieldx-guard'] === '0');

  // 5. Pausa global.
  r = arrancar('www.eldiario.es', Object.assign({}, ACTIVO, { enabled: false }));
  comprobar('pausa global: sin CSS', r.cssInyectado === false);

  // 6. El toggle de YouTube se propaga.
  r = arrancar('www.youtube.com', Object.assign({}, ACTIVO, { ytAdBlock: false }));
  comprobar('toggle de YouTube en OFF se propaga', r.atributos['data-shieldx-yt'] === '0');

  // 7. Selectores personales del picker: hoja propia en el host que los tiene,
  //    en ningun otro, y tampoco si el sitio esta excluido.
  r = arrancar('www.eldiario.es', Object.assign({}, ACTIVO, { customHidden: { 'eldiario.es': ['.molesto', '#banner-raro'] } }));
  comprobar('selectores del picker aplicados en su host', r.cssIds.has('shieldx-custom-css'));
  r = arrancar('www.elpais.com', Object.assign({}, ACTIVO, { customHidden: { 'eldiario.es': ['.molesto'] } }));
  comprobar('los selectores de otro host no se aplican', !r.cssIds.has('shieldx-custom-css'));
  r = arrancar('www.eldiario.es', Object.assign({}, ACTIVO, { siteExcluded: ['eldiario.es'], customHidden: { 'eldiario.es': ['.molesto'] } }));
  comprobar('sitio excluido: tampoco selectores del picker', !r.cssIds.has('shieldx-custom-css'));
} catch (e) {
  console.log('FALLO:', e.message);
  console.log(e.stack.split('\n').slice(0, 4).join('\n'));
  process.exit(1);
}

console.log(fallos === 0 ? '\nTodo correcto' : `\n${fallos} fallo(s)`);
process.exit(fallos === 0 ? 0 : 1);
