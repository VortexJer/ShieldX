// Guardia de ocultado (isSafeToHide): qué se oculta y qué NO con los
// selectores ambiguos (.ad, .promo-banner, #ads...). Es la parte que más daño
// hace si se equivoca: un falso positivo se lleva contenido de la página.
//
// El fichero no exporta nada, así que la función se extrae del fuente y se
// evalúa con un mini-DOM. Si alguien la renombra, el test lo dice.
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, '..', 'content.js'), 'utf8');

let fallos = 0;
function comprobar(desc, ok) {
  console.log((ok ? 'OK   ' : 'FALLO') + '  ' + desc);
  if (!ok) fallos++;
}

// ── Extraer la guardia y sus ayudantes ──────────────────────────────────────
function trozo(nombre) {
  const i = src.indexOf('function ' + nombre);
  if (i < 0) throw new Error('no se encuentra ' + nombre + ' en content.js');
  // hasta la línea que cierra la función a nivel 0
  let nivel = 0, dentro = false;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') { nivel++; dentro = true; }
    else if (src[j] === '}') { nivel--; if (dentro && nivel === 0) return src.slice(i, j + 1); }
  }
  throw new Error('funcion sin cerrar: ' + nombre);
}

const constantes = src.slice(src.indexOf('const STRUCTURAL'), src.indexOf('// ── Ocultado'));
const codigo = constantes + '\n return isSafeToHide;';
const isSafeToHide = new Function('window', codigo)({ innerWidth: 1280, innerHeight: 800 });

// ── Mini-elemento ───────────────────────────────────────────────────────────
function el(o) {
  o = o || {};
  return {
    tagName: o.tag || 'DIV',
    textContent: o.texto || '',
    querySelector: (sel) => {
      const dentro = o.dentro || '';
      return dentro.split(',').some(t => t && sel.includes(t.trim())) ? {} : null;
    },
    getBoundingClientRect: () => ({ width: o.w != null ? o.w : 200, height: o.h != null ? o.h : 90 }),
  };
}

// ── Casos ───────────────────────────────────────────────────────────────────
// 1. Anuncios de verdad: se ocultan.
comprobar('hueco 300x250 vacio (formato IAB): se oculta',
  isSafeToHide(el({ w: 300, h: 250 })) === true);
comprobar('banner 728x90 con imagen: se oculta',
  isSafeToHide(el({ w: 728, h: 90, dentro: 'img' })) === true);
comprobar('rascacielos 160x600 con iframe: se oculta',
  isSafeToHide(el({ w: 160, h: 600, dentro: 'iframe' })) === true);
comprobar('caja con enlace y texto corto de reclamo: se oculta',
  isSafeToHide(el({ w: 250, h: 120, texto: 'Compra ya con un 50% de descuento', dentro: 'a[href]' })) === true);
comprobar('contenedor vacio de cualquier tamano: se oculta',
  isSafeToHide(el({ w: 210, h: 60, texto: '' })) === true);

// 2. Contenido legitimo: NO se toca.
comprobar('aviso de la web ("tu pedido se ha guardado"): intacto',
  isSafeToHide(el({ w: 400, h: 60, texto: 'Tu pedido se ha guardado correctamente. Te avisaremos por correo.' })) === false);
comprobar('parrafo largo con clase de anuncio: intacto',
  isSafeToHide(el({ texto: 'x'.repeat(700) })) === false);
comprobar('bloque con formulario dentro: intacto',
  isSafeToHide(el({ texto: 'Buscar', dentro: 'input' })) === false);
comprobar('bloque con video dentro: intacto',
  isSafeToHide(el({ texto: 'Reproductor', dentro: 'video' })) === false);
comprobar('bloque que ocupa media pantalla: intacto',
  isSafeToHide(el({ w: 900, h: 700 })) === false);
comprobar('elemento estructural (ARTICLE): intacto',
  isSafeToHide(el({ tag: 'ARTICLE', w: 300, h: 250 })) === false);
comprobar('elemento estructural (FORM): intacto',
  isSafeToHide(el({ tag: 'FORM', w: 300, h: 250 })) === false);
comprobar('mensaje de error de un formulario: intacto',
  isSafeToHide(el({ w: 320, h: 40, texto: 'La contrasena debe tener al menos 8 caracteres' })) === false);
comprobar('migas de pan con enlaces pero medidas raras: se oculta solo si trae carga',
  isSafeToHide(el({ w: 700, h: 24, texto: 'Inicio > Ofertas > Portatiles', dentro: 'a[href]' })) === true);

// 3. Casos frontera del tamano IAB (tolerancia de 2 px).
comprobar('301x251 sigue contando como 300x250',
  isSafeToHide(el({ w: 301, h: 251, texto: 'Publicidad de un anunciante cualquiera aqui' })) === true);
comprobar('310x260 ya no es formato IAB: intacto si es solo texto',
  isSafeToHide(el({ w: 310, h: 260, texto: 'Aviso importante sobre tu cuenta de usuario' })) === false);

console.log(fallos === 0 ? '\nTodo correcto' : `\n${fallos} fallo(s)`);
process.exit(fallos === 0 ? 0 : 1);
