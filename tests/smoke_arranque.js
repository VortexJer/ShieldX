// Robustez del arranque. Dos formas de quedarse mudo sin que se note:
//
//  a) chrome.storage responde en el MISMO tick, así que la primera pasada corre
//     mientras el fichero aún se evalúa. Una variable `let` declarada más abajo
//     está en zona muerta y lanza; si eso mata start() antes de crear el
//     observer, el CSS entra y el barrido no arranca jamás. Cazado en vivo:
//     el bloqueador ocultaba por CSS pero no marcaba ni un solo elemento.
//  b) Una pasada que lanza (un getComputedStyle raro, un selector que un Chrome
//     viejo no traga) no puede llevarse por delante a las demás ni al observer.
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, '..', 'content.js'), 'utf8');

let fallos = 0;
function comprobar(desc, ok) {
  console.log((ok ? 'OK   ' : 'FALLO') + '  ' + desc);
  if (!ok) fallos++;
}

function nodo(o) {
  o = o || {};
  const a = {};
  const est = {};
  const el = {
    estilos: est,
    tagName: o.tag || 'DIV', id: o.id || '', className: o.cls || '', classList: [],
    textContent: o.texto || '', children: [], parentElement: null,
    style: {
      setProperty(k, v) { est[k] = v; },
      removeProperty(k) { delete est[k]; },
    },
    setAttribute(k, v) { a[k] = String(v); }, getAttribute: (k) => (k in a ? a[k] : null),
    hasAttribute: (k) => k in a, removeAttribute(k) { delete a[k]; },
    remove() {}, append() {}, appendChild() {}, focus() {}, blur() {},
    querySelector: () => null, querySelectorAll: () => [], closest: () => null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 300, height: 250 }),
    getClientRects: () => [{}], offsetWidth: 300, offsetHeight: 250, attrs: a,
  };
  return el;
}

// `sincrono`: el get de storage responde en el acto, como puede hacer Chrome.
// `romper`: qué paso de la pasada revienta, para ver que el resto aguanta.
function arrancar({ sincrono, romper, oculta }) {
  const anuncio = nodo({ cls: 'ads', id: 'c2' });
  const documentElement = nodo({ tag: 'HTML' });
  let observerCreado = false;
  let cssPuesto = false;
  let arranqueLanzo = null;
  let observerCb = null;
  let observaDocument = false;
  const extra = [];   // anuncios que llegan despues, por mutacion

  global.document = {
    readyState: 'complete', documentElement, head: nodo({}), body: nodo({ tag: 'BODY' }),
    createElement: () => nodo({}),
    getElementById: () => null,
    createDocumentFragment: () => ({ querySelector: () => null }),
    addEventListener() {}, removeEventListener() {},
    querySelectorAll(q) {
      if (romper === 'sweep' && q.includes('.adbox')) throw new Error('selector explota');
      if (romper === 'cookies' && q.includes('onetrust')) throw new Error('cookies explota');
      if (romper === 'meta' && q.includes('http-equiv')) throw new Error('meta explota');
      if (q.includes('.ad,') || q.includes('.ads,')) return [anuncio, ...extra];
      return [];
    },
    get visibilityState() { return oculta ? 'hidden' : 'visible'; },
    elementFromPoint: () => { if (romper === 'overlays') throw new Error('overlay explota'); return null; },
  };
  // La hoja de estilo se modela de verdad: se puede poner Y quitar.
  let hoja = null;
  documentElement.appendChild = (n) => {
    if (n && n.id === 'shieldx-css') {
      cssPuesto = true;
      hoja = n;
      n.remove = () => { cssPuesto = false; hoja = null; };
    }
  };
  global.document.head.appendChild = documentElement.appendChild;
  global.document.getElementById = (id) => (id === 'shieldx-css' ? hoja : null);

  global.window = {
    location: { hostname: 'www.ejemplo.es' }, innerWidth: 1280, innerHeight: 800,
    addEventListener() {}, removeEventListener() {}, dispatchEvent: () => {}, focus() {},
  };
  global.window.top = global.window;
  global.location = global.window.location;
  global.performance = { now: () => Date.now() };
  // Con la pestana oculta, Chrome NO llama nunca al callback de rAF.
  global.requestAnimationFrame = (f) => { if (!oculta) f(); };
  global.CustomEvent = class { constructor(t, o) { this.type = t; Object.assign(this, o); } };
  global.MutationObserver = class {
    constructor(cb) { observerCb = cb; }
    observe(diana) {
      observerCreado = true;
      // `document` no cambia nunca; `document.documentElement` si, con
      // document.write. Se anota cual eligio.
      observaDocument = diana === global.document;
    }
    disconnect() {}
  };
  global.getComputedStyle = () => ({ position: 'static', overflow: 'visible', cursor: 'auto', display: 'block' });
  global.CSS = { escape: (s) => s };

  const estado = { enabled: true, ytAdBlock: true, guardEnabled: true, siteExcluded: [] };
  let cbGuardado = null;
  let onChangedCb = null;
  global.chrome = {
    runtime: { id: 't', sendMessage() {}, lastError: null, onMessage: { addListener() {} } },
    storage: {
      local: {
        get: (k, cb) => {
          // El primero es el del arranque; los siguientes vienen de onChanged y
          // deben responder ya con el estado actual.
          if (sincrono || cbGuardado) cb(estado);
          else cbGuardado = cb;
        },
        set() {},
      },
      onChanged: { addListener(f) { onChangedCb = f; } },
    },
  };

  try {
    new Function(src)();
    if (!sincrono && cbGuardado) cbGuardado(estado);
  } catch (e) {
    arranqueLanzo = e.message;
  }
  // Getters, no copias: el estado se aplica en un microtask posterior y los
  // booleanos capturados por valor se quedarian congelados en false.
  return {
    get observerCreado() { return observerCreado; },
    get cssPuesto() { return cssPuesto; },
    get observaDocument() { return observaDocument; },
    // document.write: <html> nuevo y la hoja de estilo se va con el viejo.
    reescribirDocumento() {
      cssPuesto = false;
      const nuevoHtml = nodo({ tag: 'HTML' });
      nuevoHtml.appendChild = documentElement.appendChild;
      global.document.documentElement = nuevoHtml;
      global.document.body = nodo({ tag: 'BODY' });
      global.document.head = nodo({ tag: 'HEAD' });
      global.document.head.appendChild = documentElement.appendChild;
      hoja = null;                    // la hoja se fue con el documento viejo
    },
    anuncio, arranqueLanzo,
    listo: () => new Promise(r => setTimeout(r, 0)),
    // El popup escribe en storage y el content script reacciona por onChanged.
    cambiarEstado(parche) {
      Object.assign(estado, parche);
      // querySelectorAll('[data-sx="1"]') / ('[data-sx="0"]') para restaurar
      const conMarca = (v) => [anuncio, ...extra].filter(n => n.getAttribute('data-sx') === v);
      const qsaOriginal = global.document.querySelectorAll;
      global.document.querySelectorAll = function (q) {
        if (q === '[data-sx="1"]') return conMarca('1');
        if (q === '[data-sx="0"]') return conMarca('0');
        return qsaOriginal.call(this, q);
      };
      if (onChangedCb) onChangedCb({ enabled: {} }, 'local');
    },
    // Simula que llega un anuncio nuevo y avisa al observer, como haria el DOM.
    mutar() {
      const n = nodo({ cls: 'ads', id: 'tardio' });
      extra.push(n);
      if (observerCb) observerCb([]);
      return n;
    },
  };
}

// Todos los casos esperan al microtask antes de mirar el resultado.
async function arrancarYEsperar(op) {
  const r = arrancar(op);
  await r.listo();
  return r;
}

(async () => {
  // ── a) storage sincrono ───────────────────────────────────────────────────
  let r = await arrancarYEsperar({ sincrono: true });
  comprobar('con storage sincrono el arranque no lanza' +
    (r.arranqueLanzo ? ' -> ' + r.arranqueLanzo : ''), r.arranqueLanzo === null);
  comprobar('con storage sincrono se inyecta el CSS', r.cssPuesto === true);
  comprobar('con storage sincrono SE CREA el observer (el fallo que dejaba mudo)',
    r.observerCreado === true);
  comprobar('con storage sincrono el anuncio se oculta igual',
    r.anuncio.getAttribute('data-sx') === '1');

  // ── b) storage asincrono, lo normal ───────────────────────────────────────
  r = await arrancarYEsperar({ sincrono: false });
  comprobar('con storage asincrono se crea el observer', r.observerCreado === true);
  comprobar('y el anuncio se oculta en la primera pasada',
    r.anuncio.getAttribute('data-sx') === '1');

  // ── c) una pasada rota no tumba al resto ──────────────────────────────────
  for (const roto of ['sweep', 'meta', 'cookies', 'overlays']) {
    r = await arrancarYEsperar({ sincrono: false, romper: roto });
    comprobar(`si "${roto}" lanza, el arranque sobrevive`, r.arranqueLanzo === null);
    comprobar(`si "${roto}" lanza, el observer sigue creandose`, r.observerCreado === true);
  }

  // Y con el barrido roto, el resto de la pasada ha podido correr igual: es
  // justo lo que garantiza el aislamiento por pasos.
  r = await arrancarYEsperar({ sincrono: false, romper: 'sweep' });
  comprobar('con el barrido roto el CSS sigue puesto', r.cssPuesto === true);

  // ── d) pestana en segundo plano ───────────────────────────────────────────
  // requestAnimationFrame no dispara con la pagina oculta (Ctrl+clic para abrir
  // en otra pestana). Sin esto, esa pestana se quedaba sin barrer hasta que el
  // usuario la miraba. Aqui rAF NUNCA se resuelve, como en Chrome real.
  r = await arrancarYEsperar({ sincrono: false, oculta: true });
  comprobar('con la pestana oculta el observer se crea igual', r.observerCreado === true);
  comprobar('con la pestana oculta el anuncio inicial tambien se oculta',
    r.anuncio.getAttribute('data-sx') === '1');

  const nuevo = r.mutar();          // llega un anuncio con la pestana en segundo plano
  await new Promise(res => setTimeout(res, 400));
  comprobar('con la pestana oculta el barrido sigue corriendo tras una mutacion',
    nuevo.getAttribute('data-sx') === '1');

  // ── e) la pagina se reescribe entera (document.write) ─────────────────────
  // Las webs de descarga y streaming montan la pagina asi. El <html> pasa a ser
  // OTRO nodo: un observer atado al antiguo se queda ciego y la hoja de estilo
  // inyectada desaparece con el documento viejo.
  r = await arrancarYEsperar({ sincrono: false });
  comprobar('el observer se ata a `document`, no al <html> (sobrevive a document.write)',
    r.observaDocument === true);

  r.reescribirDocumento();
  const tardio = r.mutar();
  await new Promise(res => setTimeout(res, 400));
  comprobar('tras document.write se repone la hoja de estilo', r.cssPuesto === true);
  comprobar('tras document.write se siguen ocultando anuncios',
    tardio.getAttribute('data-sx') === '1');

  // ── f) pausar y reanudar sin recargar ─────────────────────────────────────
  r = await arrancarYEsperar({ sincrono: false });
  comprobar('antes de pausar, el anuncio esta oculto',
    r.anuncio.getAttribute('data-sx') === '1');

  r.cambiarEstado({ enabled: false });
  await new Promise(res => setTimeout(res, 30));
  comprobar('al pausar se retira la marca del anuncio',
    r.anuncio.getAttribute('data-sx') === null);
  comprobar('al pausar se quitan los estilos de ocultado',
    r.anuncio.estilos.display === undefined);
  comprobar('al pausar se retira la hoja de estilo', r.cssPuesto === false);

  r.cambiarEstado({ enabled: true });
  await new Promise(res => setTimeout(res, 30));
  comprobar('al reanudar se vuelve a inyectar el CSS', r.cssPuesto === true);
  comprobar('y el anuncio se oculta otra vez',
    r.anuncio.getAttribute('data-sx') === '1');

  console.log(fallos === 0 ? '\nTodo correcto' : `\n${fallos} fallo(s)`);
  process.exit(fallos === 0 ? 0 : 1);
})();
