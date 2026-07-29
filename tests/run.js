// Lanza toda la batería y resume. `node tests/run.js`
const { execFileSync } = require('child_process');
const path = require('path');

const suites = [
  ['smoke.js',            'arranque y donde entra la capa de ocultado'],
  ['smoke_arranque.js',   'robustez del arranque: observer y pasadas aisladas'],
  ['smoke_hide.js',       'guardia de ocultado: que se oculta y que no'],
  ['smoke_cookies.js',    'banners de cookies y lo que abre el usuario'],
  ['smoke_guard.js',      'anti pop-under: que ventanas se permiten'],
  ['smoke_picker.js',     'picker: entrada, salidas y selectores'],
  ['smoke_yt.js',         'YouTube: poda, salto y aviso anti-adblock'],
  ['smoke_background.js', 'service worker: descargas, contadores, exclusion'],
  ['smoke_rules.js',      'integridad de manifest y reglas de red'],
];

let totalOk = 0, totalFallos = 0, rotas = [];

for (const [fichero, que] of suites) {
  let salida = '', ok = true;
  try {
    salida = execFileSync(process.execPath, [path.join(__dirname, fichero)],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    ok = false;
    salida = (e.stdout || '') + (e.stderr || '');
  }
  const okN = (salida.match(/^OK/gm) || []).length;
  const falloN = (salida.match(/^FALLO/gm) || []).length;
  totalOk += okN; totalFallos += falloN;
  console.log(`${ok && !falloN ? 'PASA ' : 'FALLA'}  ${String(okN).padStart(3)} comprobaciones  ${fichero.padEnd(22)} ${que}`);
  if (!ok || falloN) {
    rotas.push(fichero);
    for (const linea of salida.split('\n').filter(l => l.startsWith('FALLO') || /Error|error:/.test(l))) {
      console.log('        ' + linea.trim());
    }
  }
}

console.log(`\n${totalOk} comprobaciones en ${suites.length} ficheros` +
  (totalFallos ? ` — ${totalFallos} FALLOS en ${rotas.join(', ')}` : ' — todo correcto'));
process.exit(totalFallos || rotas.length ? 1 : 0);
