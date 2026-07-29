// El service worker: descargas vigiladas, contadores, exclusión por sitio y
// validación de los mensajes. Aquí viven las decisiones que tocan ficheros del
// usuario (pausar/cancelar descargas), así que conviene tenerlas atadas.
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, '..', 'background.js'), 'utf8');

let fallos = 0;
function comprobar(desc, ok) {
  console.log((ok ? 'OK   ' : 'FALLO') + '  ' + desc);
  if (!ok) fallos++;
}
const dormir = (ms) => new Promise(r => setTimeout(r, ms));

// ── Stub de chrome ──────────────────────────────────────────────────────────
const store = {};
const oyentes = {};
const acciones = [];          // registro de todo lo que se le hace a una descarga
let sesionRules = [];
let notificacionSiguiente = 'n1';
let badge = {};
const aPestana = [];      // mensajes enviados a la pestaña
let recargada = null;

function on(nombre) {
  return { addListener(f) { (oyentes[nombre] = oyentes[nombre] || []).push(f); } };
}
function disparar(nombre, ...args) {
  for (const f of oyentes[nombre] || []) f(...args);
}

global.chrome = {
  runtime: {
    id: 'test', lastError: null,
    onInstalled: on('installed'), onStartup: on('startup'), onMessage: on('message'),
  },
  storage: {
    local: {
      get(keys, cb) {
        const out = {};
        for (const k of (Array.isArray(keys) ? keys : Object.keys(keys))) out[k] = store[k];
        cb(out);
      },
      set(obj, cb) { Object.assign(store, obj); if (cb) cb(); },
    },
    onChanged: { addListener() {} },
  },
  contextMenus: { create(o, cb) { if (cb) cb(); }, onClicked: on('menu') },
  commands: { onCommand: on('command') },
  tabs: {
    sendMessage(id, msg, cb) { aPestana.push([id, msg]); if (cb) cb(); },
    reload(id) { recargada = id; },
    onUpdated: on('tabUpdated'), onRemoved: on('tabRemoved'),
  },
  action: {
    setBadgeText(o) { badge = o; },
    setBadgeBackgroundColor() {},
  },
  declarativeNetRequest: {
    getSessionRules(cb) { cb(sesionRules); },
    updateSessionRules(o, cb) {
      sesionRules = sesionRules.filter(r => !(o.removeRuleIds || []).includes(r.id));
      sesionRules.push(...(o.addRules || []));
      if (cb) cb();
    },
  },
  downloads: {
    onCreated: on('download'),
    pause(id, cb) { acciones.push(['pause', id]); cb(); },
    resume(id, cb) { acciones.push(['resume', id]); if (cb) cb(); },
    cancel(id, cb) { acciones.push(['cancel', id]); if (cb) cb(); },
    erase(o, cb) { acciones.push(['erase', o.id]); if (cb) cb(); },
  },
  notifications: {
    create(o, cb) { acciones.push(['notificar', o.title]); cb(notificacionSiguiente); },
    clear() {},
    onButtonClicked: on('notifBtn'), onClosed: on('notifClose'),
  },
};

new Function(src)();
disparar('installed');

const mensaje = (msg, tabId, cb) => {
  for (const f of oyentes['message'] || []) {
    f(msg, { id: 'test', tab: tabId === undefined ? undefined : { id: tabId } }, cb || (() => {}));
  }
};
const descarga = (extra) => Object.assign({
  id: 7, state: 'in_progress', tabId: 1,
  url: 'https://sitio-pirata.example/instalador.exe',
  filename: 'C:\\Users\\x\\Downloads\\instalador.exe', fileSize: 5242880,
}, extra || {});

(async () => {
  // ── Valores por defecto ───────────────────────────────────────────────────
  comprobar('al instalar quedan los interruptores en ON',
    store.enabled === true && store.downloadGuard === true && store.guardEnabled === true);

  // Una actualizacion no puede borrar los contadores del usuario.
  store.blockedTotal = 1234;
  store.siteExcluded = ['midominio.es'];
  disparar('installed');
  await dormir(10);
  comprobar('actualizar no borra el total bloqueado', store.blockedTotal === 1234);
  comprobar('actualizar no borra los sitios excluidos',
    JSON.stringify(store.siteExcluded) === JSON.stringify(['midominio.es']));

  // ── Descargas ─────────────────────────────────────────────────────────────
  acciones.length = 0;
  disparar('download', descarga());
  await dormir(10);
  comprobar('descarga sin ningun clic previo: se pausa y se pregunta',
    acciones.some(a => a[0] === 'pause') && acciones.some(a => a[0] === 'notificar'));

  // Cerrar la notificacion sin elegir = cancelar (opcion segura).
  acciones.length = 0;
  disparar('notifClose', 'n1');
  comprobar('cerrar la notificacion sin elegir cancela la descarga',
    acciones.some(a => a[0] === 'cancel' && a[1] === 7));

  // Permitir la reanuda.
  notificacionSiguiente = 'n2';
  acciones.length = 0;
  disparar('download', descarga({ id: 8 }));
  await dormir(10);
  disparar('notifBtn', 'n2', 0);
  comprobar('boton Permitir reanuda la descarga',
    acciones.some(a => a[0] === 'resume' && a[1] === 8));

  // Cancelar la borra del historial.
  notificacionSiguiente = 'n3';
  acciones.length = 0;
  disparar('download', descarga({ id: 9 }));
  await dormir(10);
  disparar('notifBtn', 'n3', 1);
  comprobar('boton Cancelar cancela Y borra del historial',
    acciones.some(a => a[0] === 'cancel' && a[1] === 9) &&
    acciones.some(a => a[0] === 'erase' && a[1] === 9));

  // Con un clic reciente en esa pestana, la descarga es tuya: ni se toca.
  mensaje({ type: 'GESTURE' }, 1);
  acciones.length = 0;
  disparar('download', descarga({ id: 10 }));
  await dormir(10);
  comprobar('descarga tras un clic tuyo: pasa sin preguntar', acciones.length === 0);

  // El clic de OTRA pestana no vale como permiso.
  acciones.length = 0;
  disparar('download', descarga({ id: 11, tabId: 2 }));
  await dormir(10);
  comprobar('el clic de otra pestana no autoriza la descarga',
    acciones.some(a => a[0] === 'pause'));

  // Descargas sin pestana (Guardar como... de Chrome): no se vigilan.
  acciones.length = 0;
  disparar('download', descarga({ id: 12, tabId: -1 }));
  await dormir(10);
  comprobar('descarga sin pestana (Guardar como) no se toca', acciones.length === 0);

  // Con el interruptor de descargas apagado, no se vigila nada.
  store.downloadGuard = false;
  acciones.length = 0;
  disparar('download', descarga({ id: 13, tabId: 3 }));
  await dormir(10);
  comprobar('con "descargas vigiladas" en OFF no se interviene', acciones.length === 0);
  store.downloadGuard = true;

  // Con ShieldX pausado del todo, tampoco.
  store.enabled = false;
  acciones.length = 0;
  disparar('download', descarga({ id: 14, tabId: 4 }));
  await dormir(10);
  comprobar('con ShieldX pausado no se interviene', acciones.length === 0);
  store.enabled = true;

  // ── Contadores ────────────────────────────────────────────────────────────
  store.blockedTotal = 0;
  mensaje({ type: 'BLOCKED', delta: 5 }, 1);
  mensaje({ type: 'BLOCKED', delta: 3 }, 1);
  await dormir(600);
  comprobar('los incrementos se agrupan en una sola escritura', store.blockedTotal === 8);
  comprobar('el badge muestra el total de la pestana', badge.text === '8');

  const antes = store.blockedTotal;
  mensaje({ type: 'BLOCKED', delta: -5 }, 1);
  mensaje({ type: 'BLOCKED', delta: 999999 }, 1);
  mensaje({ type: 'BLOCKED', delta: 'muchos' }, 1);
  await dormir(600);
  comprobar('los deltas absurdos se ignoran', store.blockedTotal === antes);

  // Un mensaje de otra extension no se atiende.
  const antesTotal = store.blockedTotal;
  for (const f of oyentes['message'] || []) f({ type: 'BLOCKED', delta: 100 }, { id: 'otra' }, () => {});
  await dormir(600);
  comprobar('los mensajes de otra extension se ignoran', store.blockedTotal === antesTotal);

  // Navegar reinicia el contador de la pagina, no el total.
  disparar('tabUpdated', 1, { status: 'loading', url: 'https://otra.example/' });
  comprobar('al navegar el contador de la pagina vuelve a cero', badge.text === '');
  comprobar('pero el total persiste', store.blockedTotal === antesTotal);

  // ── Exclusion por sitio ───────────────────────────────────────────────────
  store.siteExcluded = [];
  let resp = null;
  mensaje({ type: 'SET_SITE', host: 'WWW.Ejemplo.ES', excluded: true }, 1, (r) => { resp = r; });
  await dormir(10);
  comprobar('el host se normaliza (sin www y en minusculas)',
    JSON.stringify(store.siteExcluded) === JSON.stringify(['ejemplo.es']));
  comprobar('se levanta una regla de red que exime al sitio',
    sesionRules.length === 1 && sesionRules[0].action.type === 'allowAllRequests' &&
    sesionRules[0].condition.requestDomains[0] === 'ejemplo.es');
  comprobar('la regla de exencion pisa a las de bloqueo (prioridad alta)',
    sesionRules[0].priority === 10000);

  mensaje({ type: 'SET_SITE', host: 'ejemplo.es', excluded: false }, 1, () => {});
  await dormir(10);
  comprobar('quitar la exclusion retira la regla de red', sesionRules.length === 0);

  mensaje({ type: 'SET_SITE', host: '', excluded: true }, 1, () => {});
  mensaje({ type: 'SET_SITE', host: 'x.es', excluded: 'si' }, 1, () => {});
  await dormir(10);
  comprobar('SET_SITE con datos invalidos no hace nada', sesionRules.length === 0);

  // ── Atajos de teclado ─────────────────────────────────────────────────────
  const pestana = { id: 7, url: 'https://www.ejemplo.es/una/pagina' };

  store.siteExcluded = [];
  aPestana.length = 0; acciones.length = 0; recargada = null;
  disparar('command', 'sx-toggle-site', pestana);
  await dormir(20);
  comprobar('Alt+Shift+S excluye el sitio actual',
    JSON.stringify(store.siteExcluded) === JSON.stringify(['ejemplo.es']));
  comprobar('y levanta la regla de red', sesionRules.length === 1);
  comprobar('y avisa de lo que ha hecho',
    acciones.some(a => a[0] === 'notificar' && a[1] === 'ShieldX'));
  comprobar('y recarga la pestana para que se note', recargada === 7);

  disparar('command', 'sx-toggle-site', pestana);
  await dormir(20);
  comprobar('pulsarlo otra vez lo reactiva',
    JSON.stringify(store.siteExcluded) === JSON.stringify([]));
  comprobar('y retira la regla de red', sesionRules.length === 0);

  aPestana.length = 0;
  disparar('command', 'sx-pick', pestana);
  comprobar('Alt+Shift+X arranca el modo senalar',
    aPestana.some(([id, m]) => id === 7 && m.type === 'PICK_START'));

  aPestana.length = 0;
  disparar('command', 'sx-cookie-show', pestana);
  comprobar('el atajo de cookies pide mostrar el aviso',
    aPestana.some(([id, m]) => id === 7 && m.type === 'COOKIE_SHOW'));

  // En paginas que no son la web de verdad no hay sitio que excluir.
  const antesLista = JSON.stringify(store.siteExcluded);
  for (const u of ['chrome://extensions/', 'chrome-extension://abc/x.html',
                   'file:///C:/x.html', 'about:blank', 'data:text/html,x']) {
    disparar('command', 'sx-toggle-site', { id: 8, url: u });
  }
  await dormir(20);
  comprobar('en paginas internas / file: / data: el atajo no toca nada',
    JSON.stringify(store.siteExcluded) === antesLista);

  // Sin pestana no puede pasar nada raro.
  let exploto = false;
  try { disparar('command', 'sx-toggle-site', null); } catch (_) { exploto = true; }
  comprobar('un atajo sin pestana no lanza', !exploto);

  // ── SYNC_RULES (lo manda el popup al importar ajustes) ────────────────────
  store.siteExcluded = ['importado.es', 'otro.com'];
  sesionRules = [];
  mensaje({ type: 'SYNC_RULES' }, 1);
  await dormir(20);
  comprobar('SYNC_RULES levanta las reglas de los sitios importados',
    sesionRules.length === 2);

  // ── antiAdblockWalls viaja en las estadisticas ────────────────────────────
  let stats = null;
  store.antiAdblockWalls = false;
  mensaje({ type: 'GET_STATS', tabId: 1 }, 1, (r) => { stats = r; });
  await dormir(20);
  comprobar('GET_STATS informa del interruptor de los muros',
    stats && stats.antiAdblockWalls === false);

  console.log(fallos === 0 ? '\nTodo correcto' : `\n${fallos} fallo(s)`);
  process.exit(fallos === 0 ? 0 : 1);
})();
