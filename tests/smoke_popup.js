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
    nodos[id] = {
      id, textContent: '', className: '', checked: false, disabled: false,
      style: { display: '' },
      addEventListener(t, f) { (escuchas[id] = escuchas[id] || {})[t] = f; },
    };
  }

  global.document = {
    getElementById: (id) => nodos[id] || null,
    addEventListener() {},
  };
  global.window = { close() { cerrado = true; } };
  let cerrado = false;

  const escrito = {};
  const enviados = [];
  let recargada = null;
  let respuestaStats = Object.assign({
    blockedTotal: 12, cookiesBlocked: 3, redirectsBlocked: 4, pageCount: 5,
    enabled: true, ytAdBlock: true, guardEnabled: true, downloadGuard: true,
    siteExcluded: [],
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
        get(keys, cb) { cb({ customHidden: { [host]: ['.molesto'] } }); },
        set(obj, cb) { Object.assign(escrito, obj); if (cb) cb(); },
      },
    },
  };
  global.setInterval = () => 0;
  global.clearInterval = () => {};

  new Function(src)();
  return { nodos, escuchas, escrito, enviados, get recargada() { return recargada; },
           get cerrado() { return cerrado; } };
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

console.log(fallos === 0 ? '\nTodo correcto' : `\n${fallos} fallo(s)`);
process.exit(fallos === 0 ? 0 : 1);
