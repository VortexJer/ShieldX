// Política del quitacookies (v11.5): oculta banners, pero JAMÁS lo que el
// usuario ha abierto él mismo ni los modales normales que solo mencionan la
// política de privacidad. Simula un mini-DOM con las cuatro situaciones.
const fs = require('fs');
const path = require('path').join(__dirname, '..', 'content.js');
const src = fs.readFileSync(path, 'utf8');

let fallos = 0;
function comprobar(desc, ok) {
  console.log((ok ? 'OK   ' : 'FALLO') + '  ' + desc);
  if (!ok) fallos++;
}
const dormir = (ms) => new Promise(r => setTimeout(r, ms));

// ── Mini-DOM ────────────────────────────────────────────────────────────────
function nodo(props) {
  const attrs = {};
  const estilo = {};
  const el = {
    tagName: 'DIV', textContent: '', id: '', className: '',
    offsetWidth: 100, offsetHeight: 50,
    parentElement: null, children: [], posicion: 'fixed',
    getClientRects: () => [{}],
    getBoundingClientRect: () => ({ width: 100, height: 50 }),
    hasAttribute: (k) => k in attrs,
    setAttribute(k, v) { attrs[k] = String(v); },
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    removeAttribute(k) { delete attrs[k]; },
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
    remove() { el.removido = true; },
    style: { setProperty(k, v) { estilo[k] = v; }, removeProperty(k) { delete estilo[k]; } },
    appendChild() {},
    attrs, estilo,
  };
  return Object.assign(el, props);
}
const oculto = (el) => el.attrs['data-sx'] === '1';

// Los tres cubos que devuelve el dispatcher de querySelectorAll.
const conocidos = [];   // COOKIE_QUERY + CMP_IFRAME_QUERY  (marca: #onetrust)
const genericos = [];   // COOKIE_HINT_QUERY                (marca: [id*="ookie")
const dialogos  = [];   // [role="dialog"]…                 (marca: role="dialog")

const documentElement = nodo({ tagName: 'HTML' });
global.document = {
  readyState: 'loading',
  documentElement, head: nodo({}), body: nodo({ tagName: 'BODY' }),
  createElement: () => nodo({}),
  getElementById: () => null,
  addEventListener() {},
  createDocumentFragment: () => ({ querySelector: () => null }),
  querySelectorAll(q) {
    if (q.includes('#onetrust')) return conocidos;
    if (q.includes('[id*="ookie"')) return genericos;
    if (q.includes('[role="dialog"')) return dialogos;
    if (q.includes('data-sx-cookie="1"')) {
      return [...conocidos, ...genericos, ...dialogos]
        .filter(n => n.attrs['data-sx-cookie'] === '1');
    }
    return [];
  },
  elementFromPoint: () => null,
};

const handlers = {};
global.window = {
  location: { hostname: 'www.ejemplo.es' },
  innerWidth: 1280, innerHeight: 800,
  addEventListener(t, f) { (handlers[t] = handlers[t] || []).push(f); },
  dispatchEvent: () => {},
};
global.window.top = global.window;   // marco superior por defecto
global.location = global.window.location;
global.performance = { now: () => Date.now() };
global.requestAnimationFrame = (f) => f();
global.CustomEvent = class { constructor(t, o) { this.type = t; Object.assign(this, o); } };
global.getComputedStyle = (el) => ({
  position: (el && el.posicion) || 'static', overflow: 'visible', cursor: 'auto',
});

let observerCb = null;
global.MutationObserver = class {
  constructor(cb) { observerCb = cb; }
  observe() {} disconnect() {}
};

let storageCb = null;
let onMsg = null;
global.chrome = {
  runtime: {
    id: 'test', sendMessage() {}, lastError: null,
    onMessage: { addListener(f) { onMsg = f; } },
  },
  storage: {
    local: { get: (keys, cb) => { storageCb = cb; }, set() {} },
    onChanged: { addListener() {} },
  },
};

function gesto() {
  for (const f of handlers['pointerdown'] || []) f({ isTrusted: true, target: null });
}
async function pasada() {
  observerCb([]);
  await dormir(400);   // coalescing de 250 ms + margen
}

// ── Escenarios ──────────────────────────────────────────────────────────────
(async () => {
  // Banner conocido presente al cargar, sin ningún gesto.
  const banner = nodo({ id: 'onetrust-banner-sdk', textContent: 'Usamos cookies. Aceptar / Rechazar' });
  conocidos.push(banner);

  new Function(src)();
  storageCb({ enabled: true, ytAdBlock: true, guardEnabled: true, siteExcluded: [] });
  await dormir(30);   // el estado se aplica en un microtask

  comprobar('banner de cookies al cargar (sin gesto): oculto', oculto(banner));

  // Modal de login que enlaza la política de privacidad: NI TOCARLO.
  const login = nodo({
    textContent: 'Inicia sesión. Al continuar aceptas los términos y la política de privacidad.',
  });
  dialogos.push(login);
  await pasada();
  comprobar('modal de login con "privacidad" (sin cookies): intacto', !oculto(login));

  // Diálogo que SÍ es de cookies, aparecido solo: fuera.
  const dlgCookies = nodo({
    textContent: 'Utilizamos cookies propias y de terceros. Puedes aceptar todas o rechazar su uso.',
  });
  dialogos.push(dlgCookies);
  await pasada();
  comprobar('diálogo de cookies aparecido solo: oculto', oculto(dlgCookies));

  // El usuario hace clic y se abren: su panel de preferencias de cookies (con
  // interruptores) y un pop-up de configuración cualquiera. Se respetan, y
  // PARA SIEMPRE.
  const panelPrefs = nodo({
    className: 'cookie-preferences',
    textContent: 'Preferencias de cookies: analítica, personalización…',
    querySelector: (q) => (q.includes('checkbox') ? nodo({}) : null),
  });
  const popupConfig = nodo({ textContent: 'Ajustes de la cuenta. Notificaciones. Idioma.' });
  const bannerSPA = nodo({ id: 'onetrust-banner-sdk', textContent: 'Cookies. Aceptar / Rechazar' });
  genericos.push(panelPrefs);
  dialogos.push(popupConfig);
  conocidos.push(bannerSPA);   // banner que solo coincide en el tiempo con el clic

  gesto();
  await pasada();
  comprobar('panel de preferencias abierto por el usuario: intacto', !oculto(panelPrefs));
  comprobar('pop-up de configuración abierto por el usuario: intacto', !oculto(popupConfig));
  comprobar('banner llano justo tras el clic: aún intacto (espera)', !oculto(bannerSPA));

  // Pasado el margen del gesto, el banner llano cae; lo del usuario, no.
  await dormir(1600);
  await pasada();
  comprobar('banner llano pasada la espera: oculto', oculto(bannerSPA));
  comprobar('panel de preferencias sigue intacto tras más pasadas', !oculto(panelPrefs));
  comprobar('pop-up de configuración sigue intacto tras más pasadas', !oculto(popupConfig));

  // El popup puede pedir que se vuelva a mostrar el aviso: hay sitios donde el
  // unico acceso a "Configuracion de cookies" vive dentro del propio banner.
  {
    let resp = null;
    onMsg({ type: 'COOKIE_SHOW' }, { id: 'test' }, (r) => { resp = r; });
    comprobar('MOSTRAR desde el popup restaura el banner oculto',
      !oculto(banner) && resp && resp.restaurados >= 1);
    await pasada();
    comprobar('y no se vuelve a ocultar despues', !oculto(banner));
  }

  // Dentro de un iframe NO se oculta ningun banner: el CMP vive en su propio
  // iframe y vaciarlo desde dentro deja la web bloqueada tras un muro en
  // blanco (verificado en as.com). Solo el marco superior actua.
  {
    conocidos.length = 0; genericos.length = 0; dialogos.length = 0;
    const bannerEnIframe = nodo({ id: 'onetrust-banner-sdk', textContent: 'Cookies. Aceptar / Rechazar' });
    conocidos.push(bannerEnIframe);
    global.window.top = { distinto: true };   // ahora somos un subframe
    new Function(src)();
    storageCb({ enabled: true, ytAdBlock: true, guardEnabled: true, siteExcluded: [] });
    await dormir(30);
    await pasada();
    comprobar('dentro de un iframe no se toca el banner (lo hace el marco superior)',
      !oculto(bannerEnIframe));
  }

  console.log(fallos === 0 ? '\nTodo correcto' : `\n${fallos} fallo(s)`);
  process.exit(fallos === 0 ? 0 : 1);
})();
