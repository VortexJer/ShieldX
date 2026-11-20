#!/usr/bin/env node
// sx — banco de pruebas de ShieldX desde la terminal (herramienta de desarrollo,
// NO forma parte de la extensión: no añade ni un permiso ni un listener).
//
// Lanza un Chrome aparte con perfil temporal (nunca toca el tuyo), carga ShieldX
// sin empaquetar por CDP y lo maneja: interruptores, recarga, páginas, popup,
// clics reales. Sin dependencias (usa el WebSocket integrado de Node ≥ 22).
//
//   node dev/sx.mjs start            lanza Chrome de pruebas y carga la extensión
//   node dev/sx.mjs stop             lo cierra
//   node dev/sx.mjs reload           recarga la extensión (código nuevo)
//   node dev/sx.mjs status           estado guardado (storage.local) + reglas activas
//   node dev/sx.mjs get [clave]      lee storage.local
//   node dev/sx.mjs set <clave> <json>   escribe (p. ej. set enabled false)
//   node dev/sx.mjs sw "<js>"        evalúa JS en el service worker
//   node dev/sx.mjs open <url>       abre una pestaña
//   node dev/sx.mjs tabs             lista pestañas
//   node dev/sx.mjs close <match>    cierra las pestañas que casen
//   node dev/sx.mjs page <match> "<js>"   evalúa JS en una pestaña (match = trozo de url o id)
//   node dev/sx.mjs popup [match]    abre el popup apuntando a la pestaña que case
//   node dev/sx.mjs ui               estado visible del popup (interruptores, textos)
//   node dev/sx.mjs click <sel>      clic REAL (CDP) sobre un selector del popup
//   node dev/sx.mjs tclick <match> <sel|x,y>  clic real en una pestaña
//   node dev/sx.mjs key <match> <tecla>       pulsa una tecla en una pestaña
//   node dev/sx.mjs shot <match> <fichero.png> captura
import { spawn } from 'node:child_process';
import { existsSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 9333;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..').replace(/\\/g, '/');
const PROFILE = join(tmpdir(), 'sxprof');
const STATE = join(tmpdir(), 'sxstate.json');
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  (process.env.LOCALAPPDATA || '') + '/Google/Chrome/Application/chrome.exe',
].find(existsSync);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function version() {
  try { return await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); }
  catch (_) { return null; }
}

// ── CDP sobre el WebSocket del navegador, con sesiones aplanadas ─────────────
async function connect() {
  const v = await version();
  if (!v) throw new Error('El Chrome de pruebas no está arrancado: node dev/sx.mjs start');
  const ws = new WebSocket(v.webSocketDebuggerUrl);
  await new Promise((ok, ko) => { ws.onopen = ok; ws.onerror = () => ko(new Error('no conecta')); });
  let n = 0; const pend = new Map(); const hooks = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.method && hooks.has(d.method)) hooks.get(d.method)(d.params, d.sessionId);
    if (d.id && pend.has(d.id)) {
      const { ok, ko } = pend.get(d.id); pend.delete(d.id);
      d.error ? ko(new Error(d.error.message)) : ok(d.result);
    }
  };
  const send = (method, params = {}, sessionId) => new Promise((ok, ko) => {
    const id = ++n; pend.set(id, { ok, ko });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
  return { send, on: (ev, fn) => hooks.set(ev, fn), close: () => ws.close() };
}

async function targets(c) { return (await c.send('Target.getTargets')).targetInfos; }

async function attach(c, t) {
  const { sessionId } = await c.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
  return sessionId;
}

async function evalIn(c, t, expression) {
  const sid = await attach(c, t);
  const r = await c.send('Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true }, sid);
  await c.send('Target.detachFromTarget', { sessionId: sid }).catch(() => {});
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  }
  return r.result.value;
}

async function findSW(c, tries = 30) {
  for (let i = 0; i < tries; i++) {
    const t = (await targets(c)).find(x => x.type === 'service_worker' &&
      x.url.endsWith('/background.js') && x.url.includes(extId()));
    if (t) return t;
    await sleep(250);
  }
  throw new Error('No aparece el service worker de ShieldX');
}

function extId() { return existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')).id : ''; }

async function findPage(c, match) {
  const pages = (await targets(c)).filter(t => t.type === 'page');
  const t = pages.find(p => p.targetId.startsWith(match) || p.url.includes(match));
  if (!t) throw new Error('Sin pestaña que case con "' + match + '"');
  return t;
}

async function swEval(c, js) { return evalIn(c, await findSW(c), js); }

// ── Comandos ─────────────────────────────────────────────────────────────────
async function start() {
  if (!CHROME) throw new Error('No encuentro chrome.exe');
  if (!(await version())) {
    try { rmSync(PROFILE, { recursive: true, force: true }); } catch (_) {}
    spawn(CHROME, [
      `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${PORT}`,
      '--enable-unsafe-extension-debugging', '--no-first-run', '--mute-audio',
      // Ventana tapada != pestaña oculta: si no, Chrome la marca hidden y pausa
      // el vídeo, y las pruebas de YouTube no avanzan.
      '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding', '--disable-background-media-suspend',
      '--no-default-browser-check', '--window-size=1280,900', 'about:blank',
    ], { detached: true, stdio: 'ignore' }).unref();
    for (let i = 0; i < 40 && !(await version()); i++) await sleep(250);
  }
  const c = await connect();
  const r = await c.send('Extensions.loadUnpacked', { path: ROOT });
  writeFileSync(STATE, JSON.stringify({ id: r.id }));
  await findSW(c);
  c.close();
  console.log('ShieldX cargada · id ' + r.id);
}

async function stop() {
  const c = await connect().catch(() => null);
  if (c) { await c.send('Browser.close').catch(() => {}); c.close(); }
  console.log('Chrome de pruebas cerrado');
}

async function reload() {
  // runtime.reload() deja sin service worker a una extensión cargada por CDP:
  // se descarga y se vuelve a cargar, que es justo lo que hace "recargar" en
  // chrome://extensions.
  const c = await connect();
  const id = extId();
  if (id) await c.send('Extensions.uninstall', { id }).catch(() => {});
  const r = await c.send('Extensions.loadUnpacked', { path: ROOT });
  writeFileSync(STATE, JSON.stringify({ id: r.id }));
  await findSW(c);
  c.close();
  console.log('Extensión recargada');
}

async function main() {
  const [cmd, ...a] = process.argv.slice(2);
  if (cmd === 'start') return start();
  if (cmd === 'stop') return stop();
  if (cmd === 'reload') return reload();
  if (!cmd) { console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('import')[0]); return; }

  const c = await connect();
  try {
    const out = (v) => console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
    if (cmd === 'get') out(await swEval(c,
      `new Promise(r => chrome.storage.local.get(${a[0] ? JSON.stringify([a[0]]) : 'null'}, r))`));
    else if (cmd === 'set') {
      const val = a[1] === undefined ? 'null' : a[1];
      JSON.parse(val);
      out(await swEval(c, `new Promise(r => chrome.storage.local.set({${JSON.stringify(a[0])}: ${val}}, () => r('ok')))`));
    }
    else if (cmd === 'status') out(await swEval(c, `(async () => ({
      storage: await new Promise(r => chrome.storage.local.get(null, r)),
      rulesetsActivos: await chrome.declarativeNetRequest.getEnabledRulesets(),
      reglasDeSesion: (await chrome.declarativeNetRequest.getSessionRules()).length,
    }))()`));
    else if (cmd === 'sw') out(await swEval(c, a[0]));
    else if (cmd === 'open') {
      const r = await c.send('Target.createTarget', { url: a[0] });
      await sleep(+a[1] || 2500);
      out(r.targetId.slice(0, 8));
    }
    else if (cmd === 'close') {
      for (const t of (await targets(c)).filter(t => t.type === 'page' && (t.targetId.startsWith(a[0]) || t.url.includes(a[0]))))
        await c.send('Target.closeTarget', { targetId: t.targetId }).catch(() => {});
      out('cerradas las pestañas que casan con ' + a[0]);
    }
    else if (cmd === 'netlog') {
      // Recarga la pestaña y lista las peticiones que fallan/se bloquean (segundos = a[1]).
      const sid = await attach(c, await findPage(c, a[0]));
      const fallos = []; const urls = new Map();
      c.on('Network.requestWillBeSent', (p) => urls.set(p.requestId, p.request.url));
      c.on('Network.loadingFailed', (p) => fallos.push((p.blockedReason || p.errorText) + '  ' + (urls.get(p.requestId) || '?').slice(0, 140)));
      await c.send('Network.enable', {}, sid);
      await c.send('Network.setCacheDisabled', { cacheDisabled: true }, sid);
      await c.send('Page.reload', {}, sid);
      await sleep((+a[1] || 8) * 1000);
      out(fallos.filter(f => !/ERR_ABORTED/.test(f)).join(String.fromCharCode(10)) || 'sin fallos');
    }
    else if (cmd === 'upload') {
      // Sube un fichero a un <input type=file> (CDP: DOM.setFileInputFiles).
      const sid = await attach(c, await findPage(c, a[0]));
      const doc = await c.send('DOM.getDocument', {}, sid);
      const q = await c.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: a[1] }, sid);
      await c.send('DOM.setFileInputFiles', { files: [resolve(a[2])], nodeId: q.nodeId }, sid);
      out('subido ' + a[2]);
    }
    else if (cmd === 'tabs') out((await targets(c)).filter(t => t.type === 'page')
      .map(t => t.targetId.slice(0, 8) + '  ' + t.url).join('\n'));
    else if (cmd === 'page') out(await evalIn(c, await findPage(c, a[0]), a[1]));
    else if (cmd === 'popup') await popup(c, a[0]);
    else if (cmd === 'ui') out(await evalIn(c, await findPage(c, 'popup.html'), UI_JS));
    else if (cmd === 'click') await realClick(c, await findPage(c, 'popup.html'), a[0]);
    else if (cmd === 'tclick') await realClick(c, await findPage(c, a[0]), a[1]);
    else if (cmd === 'key') await key(c, await findPage(c, a[0]), a[1]);
    else if (cmd === 'shot') {
      const sid = await attach(c, await findPage(c, a[0]));
      const r = await c.send('Page.captureScreenshot', { format: 'png' }, sid);
      writeFileSync(a[1], Buffer.from(r.data, 'base64'));
      out('guardada ' + a[1]);
    }
    else throw new Error('Comando desconocido: ' + cmd);
  } finally { c.close(); }
}

// El popup real pregunta "¿cuál es la pestaña activa?" con tabs.query. Abierto en
// una pestaña normal, la activa sería él mismo: se le apunta a la pestaña de la web.
async function popup(c, match) {
  const tabs = await swEval(c, `new Promise(r => chrome.tabs.query({}, t => r(t.map(x => ({id: x.id, url: x.url})))))`);
  const objetivo = match ? tabs.find(t => t.url.includes(match)) : null;
  if (match && !objetivo) throw new Error('Ninguna pestaña con "' + match + '"');
  for (const v of (await targets(c)).filter(x => x.type === 'page' && x.url.includes('popup.html')))
    await c.send('Target.closeTarget', { targetId: v.targetId }).catch(() => {});
  const t = (await c.send('Target.createTarget', { url: 'about:blank' }));
  const info = (await targets(c)).find(x => x.targetId === t.targetId);
  const sid = await attach(c, info);
  if (objetivo) {
    // Al arrancar el documento aún no existe chrome.tabs: se antepone el parche a
    // popup.js en la propia respuesta, justo antes de que pida la pestaña activa.
    const parche = `chrome.tabs.query = ((q) => (o, cb) => q({}, (ts) =>
      cb(ts.filter(x => x.id === ${objetivo.id}))))(chrome.tabs.query.bind(chrome.tabs));
`;
    await c.send('Fetch.enable', { patterns: [{ urlPattern: '*popup.js*', requestStage: 'Response' }] }, sid);
    c.on('Fetch.requestPaused', async (p, s2) => {
      const body = await c.send('Fetch.getResponseBody', { requestId: p.requestId }, s2).catch(() => null);
      if (!body) return c.send('Fetch.continueRequest', { requestId: p.requestId }, s2);
      const txt = parche + (body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body);
      c.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'text/javascript' }],
        body: Buffer.from(txt).toString('base64') }, s2);
    });
  }
  await c.send('Network.enable', {}, sid);
  await c.send('Network.setCacheDisabled', { cacheDisabled: true }, sid);
  const url = `chrome-extension://${extId()}/popup.html`;
  for (let intento = 0; intento < 4; intento++) {
    await c.send('Page.navigate', { url }, sid);
    await sleep(1500);
    if (!objetivo) break;
    const host = await c.send('Runtime.evaluate', { returnByValue: true,
      expression: `document.getElementById('siteHost') && document.getElementById('siteHost').textContent` }, sid);
    if (host.result.value && !/no aplicable/.test(host.result.value)) break;
  }
  console.log('popup abierto' + (objetivo ? ' sobre ' + objetivo.url : ''));
}

const UI_JS = `(() => { const o = {};
  for (const i of document.querySelectorAll('input[type=checkbox]')) o[i.id] = i.checked;
  for (const id of ['stText','ytStatus','guardStatus','dlStatus','aabStatus','siteStatus','siteHost','sessionCount','totalCount'])
    { const e = document.getElementById(id); if (e) o[id] = e.textContent; }
  return o; })()`;

async function realClick(c, t, spec) {
  const sid = await attach(c, t);
  let x, y;
  if (/^\d+,\d+$/.test(spec)) [x, y] = spec.split(',').map(Number);
  else {
    const r = await c.send('Runtime.evaluate', { returnByValue: true, expression: `(() => {
      const e = document.querySelector(${JSON.stringify(spec)}); if (!e) return null;
      e.scrollIntoView({block:'center'}); const b = e.getBoundingClientRect();
      return [b.left + b.width / 2, b.top + b.height / 2]; })()` }, sid);
    if (!r.result.value) throw new Error('No existe ' + spec);
    [x, y] = r.result.value;
  }
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'])
    await c.send('Input.dispatchMouseEvent',
      { type, x, y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 }, sid);
  await sleep(400);
  console.log('clic en ' + spec);
}

async function key(c, t, k) {
  const sid = await attach(c, t);
  for (const type of ['keyDown', 'keyUp'])
    await c.send('Input.dispatchKeyEvent', { type, key: k, code: k, text: k.length === 1 ? k : undefined }, sid);
  console.log('tecla ' + k);
}

main().catch(e => { console.error('ERROR: ' + e.message); process.exit(1); });
