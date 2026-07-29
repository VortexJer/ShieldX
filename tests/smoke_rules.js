// Integridad de los ficheros de reglas y del manifest. Chrome descarta en
// silencio las reglas mal formadas —así se perdió la de limpieza de URLs por
// pasarse del límite de 2 KB de regex— y la extensión sigue cargando como si
// nada. Esto lo caza antes de subirlo.
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');

let fallos = 0;
function comprobar(desc, ok) {
  console.log((ok ? 'OK   ' : 'FALLO') + '  ' + desc);
  if (!ok) fallos++;
}

const leer = (f) => JSON.parse(fs.readFileSync(path.join(raiz, f), 'utf8'));
const manifest = leer('manifest.json');

// ── Manifest ────────────────────────────────────────────────────────────────
comprobar('manifest v3', manifest.manifest_version === 3);
comprobar('la version es x.y o x.y.z de numeros',
  /^\d+(\.\d+){1,3}$/.test(manifest.version));

const ficheros = [
  'background.js', 'content.js', 'guard.js', 'youtube.js',
  'popup.html', 'popup.js',
];
for (const f of ficheros) {
  comprobar(`existe ${f}`, fs.existsSync(path.join(raiz, f)));
}
for (const cs of manifest.content_scripts) {
  for (const js of cs.js) {
    comprobar(`el content script ${js} existe`, fs.existsSync(path.join(raiz, js)));
  }
}
for (const icono of Object.values(manifest.icons || {})) {
  comprobar(`el icono ${icono} existe`, fs.existsSync(path.join(raiz, icono)));
}

// Permisos: que no se cuele ninguno que no usamos.
const PERMISOS_ESPERADOS = new Set([
  'declarativeNetRequest', 'declarativeNetRequestWithHostAccess', 'storage',
  'tabs', 'downloads', 'notifications', 'contextMenus',
]);
const sobrantes = manifest.permissions.filter(p => !PERMISOS_ESPERADOS.has(p));
comprobar('sin permisos de mas' + (sobrantes.length ? ' -> ' + sobrantes : ''),
  sobrantes.length === 0);
comprobar('sin webRequest ni webNavigation (no hacen falta y ven demasiado)',
  !manifest.permissions.some(p => /webRequest|webNavigation|history|cookies|bookmarks/.test(p)));
comprobar('sin web_accessible_resources (nada de la extension es alcanzable desde la web)',
  manifest.web_accessible_resources === undefined);

// El orden de los content scripts importa: guard.js debe ir en world MAIN y en
// document_start, o la pagina guarda una copia de window.open antes que el.
const guard = manifest.content_scripts.find(cs => cs.js.includes('guard.js'));
comprobar('guard.js corre en world MAIN', guard.world === 'MAIN');
comprobar('guard.js corre en document_start', guard.run_at === 'document_start');
comprobar('guard.js corre en todos los frames', guard.all_frames === true);
const yt = manifest.content_scripts.find(cs => cs.js.includes('youtube.js'));
comprobar('youtube.js corre en world MAIN', yt.world === 'MAIN');
const content = manifest.content_scripts.find(cs => cs.js.includes('content.js'));
comprobar('content.js NO corre en world MAIN (necesita chrome.storage)',
  content.world === undefined || content.world === 'ISOLATED');

// ── Reglas ──────────────────────────────────────────────────────────────────
const ids = new Map();
let totalReglas = 0;

for (const rs of manifest.declarative_net_request.rule_resources) {
  comprobar(`el ruleset ${rs.id} apunta a un fichero que existe`,
    fs.existsSync(path.join(raiz, rs.path)));
  const reglas = leer(rs.path);
  comprobar(`${rs.path} es una lista de reglas`, Array.isArray(reglas));
  totalReglas += reglas.length;

  for (const r of reglas) {
    // ids unicos EN TODA la extension, no solo dentro del fichero.
    if (ids.has(r.id)) {
      comprobar(`id ${r.id} duplicado (${ids.get(r.id)} y ${rs.path})`, false);
    } else {
      ids.set(r.id, rs.path);
    }
    if (typeof r.id !== 'number' || r.id < 1) comprobar(`id invalido en ${rs.path}`, false);
    if (typeof r.priority !== 'number') comprobar(`regla ${r.id} sin prioridad`, false);
    if (!r.action || !r.action.type) comprobar(`regla ${r.id} sin accion`, false);
    if (!r.condition) comprobar(`regla ${r.id} sin condicion`, false);

    // El limite que ya nos mordio: 2 KB de regex compilado. Se avisa mucho antes.
    if (r.condition && r.condition.regexFilter) {
      comprobar(`regla ${r.id}: regexFilter corto (limite de 2KB compilado)`,
        r.condition.regexFilter.length < 300);
    }
    // Una regla de redireccion sin destino tumba la peticion en silencio.
    if (r.action && r.action.type === 'redirect') {
      comprobar(`regla ${r.id}: el redirect lleva destino`, !!r.action.redirect);
    }
  }
}

comprobar(`las ${totalReglas} reglas tienen ids unicos`, ids.size === totalReglas);
comprobar('el total de reglas cabe en el limite estatico de Chrome (30.000)',
  totalReglas < 30000);

// ── Limpieza de URLs: sin bucles ────────────────────────────────────────────
// Cada regla quita SU parametro y ademas todos los demas; si una regla siguiera
// casando despues de aplicarse, Chrome entraria en bucle de redirecciones.
const cleanurl = leer('rules/cleanurl.json');
for (const r of cleanurl) {
  const quita = r.action.redirect.transform.queryTransform.removeParams;
  const filtro = (r.condition.urlFilter || '').replace(/=$/, '');
  comprobar(`cleanurl ${r.id}: la regla se quita a si misma del bucle (${filtro})`,
    quita.some(p => p.toLowerCase() === filtro.toLowerCase()));
  comprobar(`cleanurl ${r.id}: solo actua sobre la navegacion principal`,
    JSON.stringify(r.condition.resourceTypes) === JSON.stringify(['main_frame']));
}

// ── Las reglas anti-redireccion y main_frame ────────────────────────────────
// declarativeNetRequest EXCLUYE main_frame por defecto. Las reglas que cortan
// DOMINIOS de redes de pop-under tienen que declararlo o no paran la
// navegacion, que es justo lo que hay que parar. Las que cortan un fichero de
// script (popunder.js, pop.js) NO deben declararlo: un documento nunca es un
// .js, y anadirlo solo arriesga tumbar una URL legitima con ese nombre.
const redirect = leer('rules/redirect.json');
const esDeDominio = (r) =>
  (r.condition.requestDomains && r.condition.requestDomains.length) ||
  /^\|\|/.test(r.condition.urlFilter || '');
const esDeScript = (r) => /\.js(\?|$|\|)|\/pop/i.test(r.condition.urlFilter || '') && !esDeDominio(r);

const dominiosSinMainFrame = redirect.filter(r =>
  esDeDominio(r) && !(r.condition.resourceTypes || []).includes('main_frame'));
comprobar('las reglas de dominio cubren main_frame' +
  (dominiosSinMainFrame.length ? ' -> faltan ' + dominiosSinMainFrame.map(r => r.id) : ''),
  dominiosSinMainFrame.length === 0);

const scriptsConMainFrame = redirect.filter(r =>
  esDeScript(r) && (r.condition.resourceTypes || []).includes('main_frame'));
comprobar('las reglas de fichero .js NO se meten en main_frame' +
  (scriptsConMainFrame.length ? ' -> sobran ' + scriptsConMainFrame.map(r => r.id) : ''),
  scriptsConMainFrame.length === 0);

comprobar('la mayoria de reglas anti-redireccion son de dominio',
  redirect.filter(esDeDominio).length > redirect.length / 2);

console.log(fallos === 0 ? '\nTodo correcto' : `\n${fallos} fallo(s)`);
process.exit(fallos === 0 ? 0 : 1);
