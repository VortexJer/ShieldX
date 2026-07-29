// ShieldX Guard v1 – anti pop-under y anti redirección forzada
// Corre en world MAIN y en todos los frames, en document_start: tiene que
// envolver window.open ANTES de que el script de la página guarde una copia.
//
// El truco de las webs de descarga y streaming pirata es siempre el mismo: el
// primer clic en cualquier sitio (aunque sea el botón de play) dispara un
// window.open o el envío de un formulario a otra pestaña. Como hay un clic real
// de por medio, el bloqueador de ventanas de Chrome lo da por bueno.
//
// Aquí la regla es más estricta: una ventana nueva por gesto, sólo si el gesto
// ocurrió sobre un enlace o botón de verdad y hace menos de un segundo.
'use strict';

(function ShieldXGuard() {
  if (window.__shieldxGuard) return;   // no envolver dos veces
  window.__shieldxGuard = true;

  function enabled() {
    return document.documentElement.getAttribute('data-shieldx-guard') !== '0';
  }

  // ── Registro del último gesto real del usuario ────────────────────────────
  let lastGesture   = 0;
  let gestureTarget = null;
  let gesturePath   = null;
  let openedInGesture = 0;
  let lastGestureId = 0;

  function onGesture(e) {
    if (!e.isTrusted) return;          // los clics sintéticos no cuentan
    lastGesture   = Date.now();
    // Dentro de un shadow DOM, e.target se re-apunta al host del componente:
    // el botón real queda invisible y su ventana salía bloqueada (verificado
    // con un <button> dentro de un shadow root). composedPath() sí lo da.
    gesturePath   = (typeof e.composedPath === 'function') ? e.composedPath() : null;
    gestureTarget = (gesturePath && gesturePath[0]) || e.target;
    openedInGesture = 0;
    lastGestureId++;
  }

  // En captura, para verlo antes que los handlers de la página.
  for (const type of ['pointerdown', 'mousedown', 'click', 'keydown', 'touchstart']) {
    window.addEventListener(type, onGesture, true);
  }

  // ¿El gesto fue sobre algo que de verdad abre una ventana?
  // No basta con <a>/<button>: media web moderna hace los botones con un <div>
  // y un handler, y con la lista corta esos botones parecían muertos (el
  // pop-up de OAuth o de configuración salía bloqueado).
  const LEGIT_QUERY =
    'a[href],button,input,select,textarea,label,summary,option,' +
    '[role="button"],[role="link"],[role="menuitem"],[role="menuitemradio"],' +
    '[role="option"],[role="tab"],[role="switch"],[role="checkbox"],[onclick]';

  // Botón hecho con <div>: cursor pointer. Pero la trampa clásica pone el
  // pointer en una capa a pantalla completa (o en el body entero), así que se
  // sube hasta la RAÍZ del pointer —el ancestro más alto que sigue en
  // pointer— y se exige que tenga tamaño de control, no de página.
  function pointerRootIsControl(el) {
    try {
      if (typeof getComputedStyle !== 'function') return false;
      if (getComputedStyle(el).cursor !== 'pointer') return false;
      let root = el;
      while (root.parentElement &&
             getComputedStyle(root.parentElement).cursor === 'pointer') {
        root = root.parentElement;
      }
      if (root === document.body || root === document.documentElement) return false;

      // El "play" de las webs de streaming es un div a tamaño del reproductor
      // con cursor pointer: si eso contara como botón, el pop-under entraría
      // por la puerta grande. Un control de verdad no lleva un vídeo dentro.
      if (root.querySelector && root.querySelector('video,iframe,embed,object')) return false;

      const r = root.getBoundingClientRect();
      const vw = window.innerWidth || 1, vh = window.innerHeight || 1;
      // Un cuarto de pantalla ya es enorme para un botón (320x200 en 1280x800).
      return r.width * r.height < vw * vh * 0.25;
    } catch (_) { return false; }
  }

  // 0 = no fue sobre nada pulsable · 1 = heurística de cursor · 2 = control real
  function gestureStrength() {
    // El camino compuesto atraviesa las fronteras de shadow DOM, que es
    // justo donde closest() se detiene.
    if (gesturePath) {
      for (let i = 0; i < gesturePath.length && i < 40; i++) {
        const n = gesturePath[i];
        if (!n || n.nodeType !== 1 || !n.matches) continue;
        try { if (n.matches(LEGIT_QUERY)) return 2; } catch (_) {}
      }
    }
    if (!gestureTarget || !gestureTarget.closest) return 0;
    if (gestureTarget.closest(LEGIT_QUERY)) return 2;
    return pointerRootIsControl(gestureTarget) ? 1 : 0;
  }

  // Un gesto sólo autoriza si es reciente Y cayó sobre algo pulsable. Que el
  // usuario haya hecho clic en el reproductor o en el fondo de la página no es
  // permiso para nada: ese clic es precisamente el que secuestran.
  //
  // El margen depende de sobre qué se pulsó. Un <a>/<button> de verdad da 5 s:
  // las pasarelas de pago y los inicios de sesión con Google abren su ventana
  // DESPUÉS de hablar con el servidor, y con un margen corto el usuario ve que
  // "no pasa nada" al pulsar. Un pop-under, en cambio, dispara en el acto y
  // además sigue limitado a una ventana por gesto. Para la heurística del
  // cursor (un div que parece botón) el margen se queda en 1,5 s.
  const MARGEN = { 2: 5000, 1: 1500, 0: 0 };

  function gestureAuthorizes() {
    const fuerza = gestureStrength();
    if (!fuerza) return false;
    return Date.now() - lastGesture <= MARGEN[fuerza];
  }

  function allowNewWindow() {
    if (!enabled()) return true;
    if (openedInGesture >= 1) return false;   // ráfaga de ventanas
    return gestureAuthorizes();
  }

  function report(kind, url) {
    try {
      window.dispatchEvent(new CustomEvent('__shieldx_guard_block', {
        detail: { kind, url: String(url || '').slice(0, 300) }
      }));
    } catch (_) {}
  }

  // ── Ventana falsa ─────────────────────────────────────────────────────────
  // Devolver null hace que muchos scripts de pop-under reintenten con otro
  // método o rompan la página. Se les devuelve un objeto inerte.
  function fakeWindow() {
    const noop = () => {};
    const stub = {
      closed: false, opener: null, name: '',
      focus: noop, blur: noop, close() { stub.closed = true; },
      postMessage: noop, moveTo: noop, resizeTo: noop, print: noop,
      alert: noop, confirm: () => false, prompt: () => null,
      location: { href: 'about:blank', assign: noop, replace: noop, reload: noop },
      document: { write: noop, writeln: noop, close: noop, open: () => stub.document,
                  body: null, documentElement: null },
    };
    return stub;
  }

  // ── window.open ───────────────────────────────────────────────────────────
  const nativeOpen = window.open;
  try {
    Object.defineProperty(window, 'open', {
      configurable: true, writable: true,
      value: function open(url, name, features) {
        if (!allowNewWindow()) { report('popup', url); return fakeWindow(); }
        openedInGesture++;
        try { return nativeOpen.apply(window, arguments); }
        catch (_) { return fakeWindow(); }
      }
    });
  } catch (_) {}

  // ── Anchors sintéticos ────────────────────────────────────────────────────
  // El otro clásico: crear un <a target="_blank"> al vuelo y llamar a .click().
  const nativeClick = HTMLElement.prototype.click;
  try {
    HTMLElement.prototype.click = function click() {
      if (enabled() && this instanceof HTMLAnchorElement) {
        const target = (this.getAttribute('target') || '').toLowerCase();
        const suelto = !this.isConnected;   // creado al vuelo, nunca insertado
        if ((target === '_blank' || suelto) && !allowNewWindow()) {
          // Descarga programática legítima: el botón "Exportar" que crea un
          // <a download> o un blob:/data: al vuelo. No es el vector del
          // pop-under, que necesita navegar a un dominio http de spam.
          const href = String(this.href || '');
          const descarga = this.hasAttribute('download') ||
                           href.startsWith('blob:') || href.startsWith('data:');
          if (!(descarga && Date.now() - lastGesture < 2500)) {
            report('anchor', this.href);
            return;
          }
        }
      }
      return nativeClick.apply(this, arguments);
    };
  } catch (_) {}

  // ── Formularios a otra pestaña ────────────────────────────────────────────
  const nativeSubmit = HTMLFormElement.prototype.submit;
  try {
    HTMLFormElement.prototype.submit = function submit() {
      if (enabled()) {
        const target = (this.getAttribute('target') || '').toLowerCase();
        if (target === '_blank' && !allowNewWindow()) {
          report('form', this.action);
          return;
        }
      }
      return nativeSubmit.apply(this, arguments);
    };
  } catch (_) {}

  // ── Sobre la navegación forzada por location ──────────────────────────────
  // Verificado en Chrome real: location.assign/replace y el setter de href son
  // propiedades PROPIAS del objeto location, no configurables ([Unforgeable]).
  // Parchear Location.prototype compila pero no intercepta nada, así que aquí
  // no se intenta: daría una falsa sensación de protección. Esa vía se cubre
  // con las reglas de red (rules/redirect.json bloquea los dominios de destino
  // de las redes de redirección, incluido main_frame) y con la retirada de
  // meta-refresh a otro dominio en content.js.

  // Nota: no se toca onbeforeunload. Las webs de anuncios lo usan para
  // retenerte, pero también lo usan los editores y formularios legítimos para
  // avisar de cambios sin guardar, y perder eso cuesta más de lo que aporta.
})();
