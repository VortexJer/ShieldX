// Pestaña rezagada (tab-under): una web abre lo pedido en una pestaña nueva y
// cambia la de origen por otra web. ShieldX debe devolverla y avisar, sin
// estorbar la navegación normal ni los inicios de sesión con ventana.
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, '..', 'background.js'), 'utf8');

let fallos = 0;
function comprobar(desc, ok) {
  console.log((ok ? 'OK   ' : 'FALLO') + '  ' + desc);
  if (!ok) fallos++;
}

// Stub tolerante: cualquier API que no se defina aquí es un oyente/función muda.
const oyentes = {};
function mudo(ruta) {
  return new Proxy(function () {}, {
    get(_, k) {
      if (k === 'addListener') return (f) => { (oyentes[ruta] = oyentes[ruta] || []).push(f); };
      return mudo(ruta + '.' + String(k));
    },
    apply(_, __, args) { const cb = args.find(a => typeof a === 'function'); if (cb) cb(); return mudo(ruta + '()'); },
  });
}
const disparar = (ruta, ...a) => { for (const f of oyentes[ruta] || []) f(...a); };

const store = { enabled: true, guardEnabled: true, siteExcluded: [] };
const urls = { 1: 'https://descargas.example/pelicula', 2: 'about:blank' };
const actualizadas = [];
const aPestana = [];
const real = {
  runtime: { id: 'test', lastError: null },
  storage: { local: {
    get(keys, cb) { const o = {}; for (const k of [].concat(keys)) o[k] = store[k]; cb(o); },
    set(o, cb) { Object.assign(store, o); if (cb) cb(); },
  } },
  tabs: {
    get(id, cb) { cb({ id, url: urls[id] }); },
    update(id, o, cb) { actualizadas.push([id, o.url]); if (cb) cb(); },
    sendMessage(id, msg, opt, cb) { aPestana.push([id, msg]); if (cb) cb(); },
  },
};
function stub(obj, ruta) {
  return new Proxy(obj, { get(t, k) {
    if (k in t) return (t[k] && typeof t[k] === 'object') ? stub(t[k], ruta + '.' + k) : t[k];
    return mudo(ruta + '.' + String(k));
  } });
}
global.chrome = stub(real, 'chrome');
new Function(src)();

const msg = (m, tabId) => disparar('chrome.runtime.onMessage', m, { id: 'test', tab: { id: tabId } }, () => {});
const abre = (origen, nueva) => disparar('chrome.webNavigation.onCreatedNavigationTarget', { sourceTabId: origen, tabId: nueva });
const navega = (tab, url) => disparar('chrome.webNavigation.onBeforeNavigate', { tabId: tab, frameId: 0, url });
const carga = (tab) => disparar('chrome.webNavigation.onCompleted', { tabId: tab, frameId: 0 });

// 1. El ataque: abre pestaña nueva y la de origen se va a otro sitio.
abre(1, 2);
navega(1, 'https://estafa.example/virus');
comprobar('la pestaña rezagada se devuelve a la página que tenía',
  actualizadas.some(([id, u]) => id === 1 && u === urls[1]));
carga(1);
comprobar('al recargar sale el globito con el destino bloqueado',
  aPestana.some(([id, m]) => id === 1 && m.type === 'SX_GLOBO' && m.kind === 'tabunder' && /estafa/.test(m.url)));
comprobar('cuenta como redirección bloqueada', store.redirectsBlocked === 1);

// 2. Navegación dentro del mismo sitio (OAuth que vuelve a /callback, etc.): pasa.
actualizadas.length = 0;
abre(1, 3);
navega(1, 'https://www.descargas.example/gracias');
comprobar('navegar dentro del mismo sitio no se toca', actualizadas.length === 0);

// 3. El usuario vuelve y pulsa un enlace a otra web: es suyo, pasa.
actualizadas.length = 0;
abre(1, 4);
const t0 = Date.now(); while (Date.now() - t0 < 350) {}   // el clic llega después
msg({ type: 'GESTURE' }, 1);
navega(1, 'https://otra-web.example/');
comprobar('con un clic tuyo después, la navegación es tuya', actualizadas.length === 0);

// 4. Una pestaña que no ha abierto nada navega libre.
actualizadas.length = 0;
navega(7, 'https://cualquiera.example/');
comprobar('sin pestaña abierta antes no hay bloqueo', actualizadas.length === 0);

// 5. "Ir igualmente" deja pasar ese destino una vez.
actualizadas.length = 0;
abre(1, 5);
navega(1, 'https://estafa.example/b');
msg({ type: 'TABUNDER_ALLOW', url: 'https://estafa.example/b' }, 1);
const ultimo = actualizadas[actualizadas.length - 1];
navega(1, 'https://estafa.example/b');
comprobar('Ir igualmente navega al destino y no se vuelve a bloquear',
  ultimo && ultimo[1] === 'https://estafa.example/b' && actualizadas.length === 2);

// 6. Con la protección apagada o el sitio excluido, nada.
actualizadas.length = 0;
store.guardEnabled = false;
abre(1, 6); navega(1, 'https://estafa.example/c');
comprobar('con el anti-redirección apagado no se toca', actualizadas.length === 0);
store.guardEnabled = true; store.siteExcluded = ['descargas.example'];
abre(1, 8); navega(1, 'https://estafa.example/d');
comprobar('en un sitio excluido no se toca', actualizadas.length === 0);

process.exitCode = fallos ? 1 : 0;
