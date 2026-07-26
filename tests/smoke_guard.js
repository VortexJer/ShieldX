// Comprueba la política de guard.js: qué ventanas y navegaciones deja pasar y
// cuáles corta. Es el fichero que envuelve APIs globales, así que un fallo aquí
// rompe páginas legítimas.
const fs = require('fs');
const path = require('path').join(__dirname, '..', 'guard.js');

let fallos = 0;
function comprobar(desc, ok) {
  console.log((ok ? 'OK   ' : 'FALLO') + '  ' + desc);
  if (!ok) fallos++;
}

// ── Stubs ───────────────────────────────────────────────────────────────────
const handlers = {};
let guardAttr = '1';
let aperturasReales = 0;
let navegacionesReales = [];
const bloqueos = [];

// El contador del click nativo se instala ANTES de cargar guard.js: si se hace
// después se sobrescribe su envoltorio y el test mide otra cosa.
let clicNativo = 0;
global.HTMLElement = class HTMLElement {
  constructor() { this.isConnected = true; }
  click() { clicNativo++; }
  getAttribute() { return null; }
  closest() { return null; }
  hasAttribute() { return false; }
};
global.HTMLAnchorElement = class HTMLAnchorElement extends global.HTMLElement {};
global.HTMLFormElement = class HTMLFormElement extends global.HTMLElement {
  submit() {}
};
global.Location = class Location {
  assign(url) { navegacionesReales.push(['assign', url]); }
  replace(url) { navegacionesReales.push(['replace', url]); }
};
global.CustomEvent = class CustomEvent {
  constructor(type, opts) { this.type = type; Object.assign(this, opts); }
};

global.document = {
  documentElement: { getAttribute: () => guardAttr },
};
global.location = { href: 'https://sitio-pirata.example/ver/pelicula', hostname: 'sitio-pirata.example' };
global.window = {
  location: global.location,
  addEventListener(type, fn) { (handlers[type] = handlers[type] || []).push(fn); },
  dispatchEvent(e) { if (e.type === '__shieldx_guard_block') bloqueos.push(e.detail); return true; },
  open(url) { aperturasReales++; return { real: true, url }; },
};

const locationAssignOriginal  = global.Location.prototype.assign;
const locationReplaceOriginal = global.Location.prototype.replace;

new Function('window', fs.readFileSync(path, 'utf8')).call(global.window, global.window);

// ── Utilidades del test ─────────────────────────────────────────────────────
const boton = Object.assign(new global.HTMLElement(), {
  closest: (sel) => (sel.includes('button') ? boton : null),
});
const fondo = Object.assign(new global.HTMLElement(), { closest: () => null });

function gesto(target) {
  for (const fn of handlers['pointerdown'] || []) fn({ isTrusted: true, target });
}

// ── Casos ───────────────────────────────────────────────────────────────────
// 1. Sin ningún gesto: la ventana se corta.
let r = global.window.open('https://porno-scam.example');
comprobar('sin gesto, window.open se bloquea', aperturasReales === 0 && r && !r.real);
comprobar('devuelve una ventana inerte, no null', !!r && typeof r.focus === 'function' && r.closed === false);
comprobar('el bloqueo se reporta', bloqueos.length === 1 && bloqueos[0].kind === 'popup');

// 2. Clic real sobre un botón: la primera ventana pasa.
gesto(boton);
r = global.window.open('https://destino-legitimo.example');
comprobar('con clic en un botón, la ventana se permite', aperturasReales === 1 && r.real === true);

// 3. El mismo gesto no puede abrir una segunda (ráfaga de pop-unders).
r = global.window.open('https://porno-scam.example');
comprobar('segunda ventana del mismo clic, bloqueada', aperturasReales === 1 && !r.real);

// 4. Clic sobre el fondo de la página: no cuenta como intención.
gesto(fondo);
r = global.window.open('https://porno-scam.example');
comprobar('clic sobre el fondo no autoriza ventanas', aperturasReales === 1 && !r.real);

// 5. Location NO se parchea: en Chrome real location.assign/replace son
//    propiedades propias no configurables y el parche al prototipo no
//    intercepta nada. Si alguien lo reintroduce, este test lo delata para que
//    no vuelva la falsa sensacion de proteccion.
comprobar('Location.prototype.assign queda intacto (via inparcheable)',
  global.Location.prototype.assign === locationAssignOriginal);
comprobar('Location.prototype.replace queda intacto (via inparcheable)',
  global.Location.prototype.replace === locationReplaceOriginal);

// 6. Anchor sintético creado al vuelo, el otro clásico del pop-under.
const a = new global.HTMLAnchorElement();
a.isConnected = false;                 // creado con createElement, nunca insertado
a.href = 'https://scam.example';
a.getAttribute = () => '_blank';
clicNativo = 0;
gesto(fondo);                          // gesto que no autoriza
a.click();
comprobar('anchor sintético con target=_blank, bloqueado', clicNativo === 0);

// Y el enlace normal en el que pulsa el usuario debe seguir funcionando.
const enlaceReal = new global.HTMLAnchorElement();
enlaceReal.getAttribute = () => null;  // sin target
clicNativo = 0;
enlaceReal.click();
comprobar('un enlace normal sigue funcionando', clicNativo === 1);

// 7. Con el guard apagado no se estorba a nadie.
guardAttr = '0';
aperturasReales = 0;
r = global.window.open('https://lo-que-sea.example');
comprobar('con el guard apagado, todo pasa', aperturasReales === 1 && r.real === true);

console.log(fallos === 0 ? '\nTodo correcto' : `\n${fallos} fallo(s)`);
process.exit(fallos === 0 ? 0 : 1);
