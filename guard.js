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
  let openedInGesture = 0;
  let lastGestureId = 0;

  function onGesture(e) {
    if (!e.isTrusted) return;          // los clics sintéticos no cuentan
    lastGesture   = Date.now();
    gestureTarget = e.target;
    openedInGesture = 0;
    lastGestureId++;
  }

  // En captura, para verlo antes que los handlers de la página.
  for (const type of ['pointerdown', 'mousedown', 'click', 'keydown', 'touchstart']) {
    window.addEventListener(type, onGesture, true);
  }

  // ¿El gesto fue sobre algo que de verdad abre una ventana?
  function gestureLooksLegit() {
    if (!gestureTarget || !gestureTarget.closest) return false;
    return !!gestureTarget.closest('a[href],button,[role="button"],input[type="submit"],[onclick]');
  }

  // Un gesto sólo autoriza si es reciente Y cayó sobre algo pulsable. Que el
  // usuario haya hecho clic en el reproductor o en el fondo de la página no es
  // permiso para nada: ese clic es precisamente el que secuestran.
  function gestureAuthorizes() {
    if (Date.now() - lastGesture > 1000) return false;
    return gestureLooksLegit();
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
          report('anchor', this.href);
          return;
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
