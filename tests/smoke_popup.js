// El popup: lo único que el usuario toca a mano. Se comprueba que cada
// interruptor escribe lo que dice, que el estado se pinta bien, que en el
// correo no promete lo que no puede cumplir y que los ids del HTML y del JS no
// se han desincronizado (un el('x') que devuelve null revienta el popup entero
// al cargar, y en un popup eso se ve como "no se abre").
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(raiz, 'popup.js'), 'utf8');
const html = fs.readFileSync(path.join(raiz, 'popup.html'), 'utf8');

let fallos = 0;
function comprobar(desc, ok) {
  console.log((ok ? 'OK   ' : 'FALLO') + '  ' + desc);
  if (!ok) fallos++;
}

// ── 1. Los ids que pide el JS existen en el HTML ────────────────────────────
const idsHtml = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
const idsJs = [...src.matchAll(/\bel\('([^']+)'\)/g)].map(m => m[1]);
const faltan = [...new Set(idsJs)].filter(id => !idsHtml.has(id));
comprobar('todos los ids que busca popup.js existen en popup.html' +
  (faltan.length ? ' -> faltan: ' + faltan.join(', ') : ''), faltan.length === 0);

comprobar('el popup no carga scripts externos',
  !/<script[^>]+src="https?:/.test(html));
comprobar('el popup no trae manejadores inline (los prohibe su CSP)',
  !/\son(click|change|load)=/.test(html));

// ── 2. Arranque con stubs ───────────────────────────────────────────────────
function arrancar({ host, url, estado }) {
  const nodos = {};
  const escuchas = {};
  for (const id of idsHtml) {
    const hijos = [];
    nodos[id] = {
      id, textContent: '', className: '', checked: false, disabled: false,
      style: { display: '' }, children: hijos, files: [],
      appendChild(n) { hijos.push(n); return n; },
      append(...n) { hijos.push(...n); },
      click() { const e = escuchas[id]; if (e && e.click) e.click(); },
      addEventListener(t, f) { (escuchas[id] = escuchas[id] || {})[t] = f; },
    };
  }

  // Los nodos que el popup crea al vuelo (la lista de sitios excluidos).
  const creados = [];
  function crear(tag) {
    const hijos = [];
    const n = {
      tagName: (tag || 'div').toUpperCase(), className: '', textContent: '',
      children: hijos, style: {},
      appendChild(h) { hijos.push(h); return h; },
      append(...h) { hijos.push(...h); },
      addEventListener(t, f) { (n.escuchas = n.escuchas || {})[t] = f; },
      click() { if (n.escuchas && n.escuchas.click) n.escuchas.click(); },
      files: [],
    };
    creados.push(n);
    return n;
  }

  global.document = {
    getElementById: (id) => nodos[id] || null,
    createElement: crear,
    addEventListener() {},
  };
  global.window = { close() { cerrado = true; } };
  let cerrado = false;
  const descargas = [];
  let urlRevocada = false;
  // Ojo: hay que CONSERVAR el constructor nativo (popup.js hace `new URL(...)`
  // para sacar el host de la pestaña); solo se le anaden los dos metodos.
  global.URL.createObjectURL = (b) => { global.__blob = b; return 'blob:shieldx/1'; };
  global.URL.revokeObjectURL = () => { urlRevocada = true; };
  global.Blob = class { constructor(partes, o) { this.texto = partes.join(''); this.type = o && o.type; } };
  global.FileReader = class {
    readAsText(f) { this.result = f.contenido; if (this.onload) this.onload(); }
  };
  global.setTimeout = (f) => 0;

  const escrito = {};
  const enviados = [];
  let recargada = null;
  let respuestaStats = Object.assign({
    blockedTotal: 12, cookiesBlocked: 3, redirectsBlocked: 4, pageCount: 5,
    enabled: true, ytAdBlock: true, guardEnabled: true, downloadGuard: true,
    antiAdblockWalls: true, siteExcluded: [],
  }, estado || {});

  global.chrome = {
    runtime: {
      lastError: null,
      sendMessage(msg, cb) {
        enviados.push(msg);
        if (msg.type === 'GET_STATS' && cb) cb(respuestaStats);
        else if (cb) cb({ ok: true });
      },
    },
    tabs: {
      query(_, cb) { cb([{ id: 42, url: url || ('https://' + host + '/algo') }]); },
      sendMessage(id, msg, cb) { enviados.push(msg); if (cb) cb({ restaurados: 1 }); },
      reload(id) { recargada = id; },
    },
    storage: {
      local: {
        get(keys, cb) {
          const base = { customHidden: { [host]: ['.molesto'] } };
          // Exportar pide las claves de ajustes: se responde con algo real.
          if (Array.isArray(keys) && keys.includes('siteExcluded')) {
            Object.assign(base, {
              enabled: true, ytAdBlock: false, guardEnabled: true,
              downloadGuard: true, antiAdblockWalls: true,
              siteExcluded: ['uno.es', 'dos.com'],
            });
          }
          cb(base);
        },
        set(obj, cb) { Object.assign(escrito, obj); if (cb) cb(); },
      },
    },
    downloads: {
      download(o, cb) { descargas.push(o); if (cb) cb(1); },
    },
  };
  global.setInterval = () => 0;
  global.clearInterval = () => {};

  new Function(src)();
  return {
    nodos, escuchas, escrito, enviados, creados, descargas,
    get recargada() { return recargada; },
    get cerrado() { return cerrado; },
    get urlRevocada() { return urlRevocada; },
    // Simula que el usuario elige un fichero para importar.
    importar(contenido) {
      nodos.importFile.files = [{ contenido }];
      escuchas.importFile.change();
    },
  };
}

// ── 3. Web normal ───────────────────────────────────────────────────────────
let r = arrancar({ host: 'eldiario.es' });
comprobar('se pinta el host del sitio', r.nodos.siteHost.textContent === 'eldiario.es');
comprobar('el sitio aparece como ACTIVO', r.nodos.siteStatus.textContent === 'ACTIVO');
comprobar('el interruptor del sitio esta disponible', r.nodos.siteToggle.disabled === false);
comprobar('se piden las estadisticas de la pestana actual',
  r.enviados.some(m => m.type === 'GET_STATS' && m.tabId === 42));

// Interruptor maestro.
r.nodos.masterToggle.checked = false;
r.escuchas.masterToggle.change();
comprobar('apagar el maestro escribe enabled=false', r.escrito.enabled === false);
comprobar('y el texto pasa a PAUSADO', r.nodos.stText.textContent === 'PAUSADO');

// YouTube.
r.nodos.ytToggle.checked = false;
r.escuchas.ytToggle.change();
comprobar('apagar YouTube escribe ytAdBlock=false', r.escrito.ytAdBlock === false);

// Anti-redireccion y descargas.
r.nodos.guardToggle.checked = false;
r.escuchas.guardToggle.change();
comprobar('apagar el anti-redireccion escribe guardEnabled=false',
  r.escrito.guardEnabled === false);
r.nodos.dlToggle.checked = false;
r.escuchas.dlToggle.change();
comprobar('apagar las descargas vigiladas escribe downloadGuard=false',
  r.escrito.downloadGuard === false);

// Excluir el sitio: manda el mensaje Y recarga la pestana (la capa de red solo
// cambia en la siguiente navegacion).
r.nodos.siteToggle.checked = false;
r.escuchas.siteToggle.change();
comprobar('excluir el sitio manda SET_SITE con el host normalizado',
  r.enviados.some(m => m.type === 'SET_SITE' && m.host === 'eldiario.es' && m.excluded === true));
comprobar('excluir el sitio recarga la pestana', r.recargada === 42);

// Picker.
r.escuchas.pickBtn.click();
comprobar('SENALAR manda PICK_START a la pestana',
  r.enviados.some(m => m.type === 'PICK_START'));
comprobar('y cierra el popup para no estorbar', r.cerrado === true);

// Mostrar el aviso de cookies.
r.escuchas.cookieShowBtn.click();
comprobar('MOSTRAR manda COOKIE_SHOW a la pestana',
  r.enviados.some(m => m.type === 'COOKIE_SHOW'));
comprobar('y cuenta lo que ha restaurado',
  /restaurado/i.test(r.nodos.cookieDesc.textContent));

// Reiniciar contadores.
r.escuchas.resetBtn.click();
comprobar('RESET manda RESET_STATS', r.enviados.some(m => m.type === 'RESET_STATS'));

// ── 4. Sitio ya excluido ────────────────────────────────────────────────────
r = arrancar({ host: 'eldiario.es', estado: { siteExcluded: ['eldiario.es'] } });
comprobar('un sitio excluido se muestra como EXCLUIDO',
  r.nodos.siteStatus.textContent === 'EXCLUIDO');
r = arrancar({ host: 'noticias.eldiario.es', estado: { siteExcluded: ['eldiario.es'] } });
comprobar('la exclusion cubre los subdominios',
  r.nodos.siteStatus.textContent === 'EXCLUIDO');

// ── 5. Cliente de correo ────────────────────────────────────────────────────
r = arrancar({ host: 'mail.google.com' });
comprobar('en el correo se avisa de que no se oculta nada',
  r.nodos.siteStatus.textContent === 'SIN OCULTAR');
comprobar('y el interruptor del sitio queda deshabilitado',
  r.nodos.siteToggle.disabled === true);
comprobar('el host se marca como correo',
  /correo/.test(r.nodos.siteHost.textContent));

// ── 6. Paginas donde no hay nada que excluir ────────────────────────────────
for (const u of ['chrome://extensions/', 'chrome-extension://abc/popup.html',
                 'file:///C:/x.html', 'about:blank']) {
  r = arrancar({ host: '', url: u });
  comprobar(`en ${u} el interruptor del sitio se deshabilita`,
    r.nodos.siteToggle.disabled === true && r.nodos.siteStatus.textContent === '—');
}

// ── 7. Los contadores llegan a su valor ─────────────────────────────────────
// animateNumber usa setInterval (aqui inerte), asi que se comprueba que al
// menos no ha explotado y que el popup sigue en pie.
r = arrancar({ host: 'eldiario.es', estado: { blockedTotal: 999 } });
comprobar('el popup arranca sin lanzar con contadores grandes',
  r.nodos.totalCount !== undefined);

// ── 8. Muros de "desactiva el bloqueador" ───────────────────────────────────
r = arrancar({ host: 'eldiario.es' });
comprobar('el interruptor de los muros se pinta como ACTIVO',
  r.nodos.aabStatus.textContent === 'ACTIVO');
r.nodos.aabToggle.checked = false;
r.escuchas.aabToggle.change();
comprobar('apagarlo escribe antiAdblockWalls=false', r.escrito.antiAdblockWalls === false);

// ── 9. Lista de sitios excluidos ────────────────────────────────────────────
r = arrancar({ host: 'eldiario.es', estado: { siteExcluded: ['uno.es', 'dos.com'] } });
comprobar('la caja de sitios excluidos aparece', r.nodos.excludedBox.style.display === '');
comprobar('cuenta los sitios', r.nodos.excludedCount.textContent === '(2)');
const filas = r.nodos.excludedList.children || [];
comprobar('pinta una fila por sitio', filas.length === 2);

const botonReactivar = r.creados.find(n => n.textContent === 'REACTIVAR');
comprobar('cada sitio trae su boton de reactivar', !!botonReactivar);
if (botonReactivar) {
  botonReactivar.click();
  comprobar('reactivar manda SET_SITE con excluded=false',
    r.enviados.some(m => m.type === 'SET_SITE' && m.excluded === false));
}

r = arrancar({ host: 'eldiario.es', estado: { siteExcluded: [] } });
comprobar('sin sitios excluidos la caja no se muestra',
  r.nodos.excludedBox.style.display === 'none');

// ── 10. Exportar ────────────────────────────────────────────────────────────
r = arrancar({ host: 'eldiario.es' });
r.escuchas.exportBtn.click();
comprobar('exportar lanza una descarga', r.descargas.length === 1);
comprobar('con nombre reconocible y preguntando donde guardarla',
  r.descargas[0].filename === 'shieldx-ajustes.json' && r.descargas[0].saveAs === true);
comprobar('el fichero es JSON local (blob), sin pasar por ningun servidor',
  /^blob:/.test(r.descargas[0].url));
const exportado = JSON.parse(global.__blob.texto);
comprobar('el JSON lleva los ajustes dentro',
  exportado.shieldx === 1 && exportado.ajustes.ytAdBlock === false &&
  Array.isArray(exportado.ajustes.siteExcluded));
comprobar('y NO lleva los contadores ni nada de navegacion',
  !('blockedTotal' in exportado.ajustes) && !('pageCount' in exportado.ajustes));

// ── 11. Importar ────────────────────────────────────────────────────────────
r = arrancar({ host: 'eldiario.es' });
r.importar(JSON.stringify({ shieldx: 1, ajustes: {
  enabled: false, ytAdBlock: true, antiAdblockWalls: false,
  siteExcluded: ['WWW.Nuevo.ES', 'otro.com'],
  customHidden: { 'sitio.es': ['.molesto'] },
} }));
comprobar('importar aplica los interruptores',
  r.escrito.enabled === false && r.escrito.antiAdblockWalls === false);
comprobar('importar normaliza los hosts',
  JSON.stringify(r.escrito.siteExcluded) === JSON.stringify(['nuevo.es', 'otro.com']));
comprobar('importar conserva los elementos ocultos a mano',
  r.escrito.customHidden['sitio.es'][0] === '.molesto');
comprobar('importar pide levantar las reglas de red',
  r.enviados.some(m => m.type === 'SYNC_RULES'));
comprobar('y lo dice', /restaurad/i.test(r.nodos.settingsDesc.textContent));

// Ficheros que no valen: ni explotan ni escriben nada.
for (const [desc, contenido] of [
  ['un fichero que no es JSON', 'esto no es json'],
  ['un JSON de otra cosa', '{"otra":"app"}'],
  ['un JSON vacio', '{}'],
  ['ajustes con basura', '{"shieldx":1,"ajustes":{"enabled":"si","siteExcluded":"no-es-lista"}}'],
]) {
  r = arrancar({ host: 'eldiario.es' });
  let exploto = false;
  try { r.importar(contenido); } catch (_) { exploto = true; }
  comprobar(`importar ${desc}: ni lanza ni escribe`,
    !exploto && Object.keys(r.escrito).length === 0);
}

// Un fichero manipulado no puede meter claves ajenas en el almacenamiento.
r = arrancar({ host: 'eldiario.es' });
r.importar(JSON.stringify({ shieldx: 1, ajustes: {
  enabled: true, blockedTotal: 999999, __proto__: { malo: 1 }, loQueSea: 'x',
} }));
comprobar('importar ignora las claves que no son ajustes conocidos',
  r.escrito.enabled === true && !('blockedTotal' in r.escrito) && !('loQueSea' in r.escrito));

console.log(fallos === 0 ? '\nTodo correcto' : `\n${fallos} fallo(s)`);
process.exit(fallos === 0 ? 0 : 1);
