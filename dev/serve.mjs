// Servidor estático mínimo para dev/fixture (http://localhost:8099): páginas de
// prueba INOCUAS para las funciones de seguridad (pop-unders, descargas, muros).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixture');
const tipos = { '.html': 'text/html; charset=utf-8', '.bin': 'application/octet-stream' };
createServer(async (req, res) => {
  if (req.url.startsWith('/lento.bin')) {   // 2 MB en ~8 s: una descarga que dura
    res.writeHead(200, { 'Content-Type': 'application/octet-stream',
      'Content-Disposition': 'attachment; filename="lento.bin"', 'Content-Length': 2097152 });
    let n = 0; const t = setInterval(() => {
      res.write(Buffer.alloc(131072, 1)); if (++n === 16) { clearInterval(t); res.end(); }
    }, 500);
    req.on('close', () => clearInterval(t)); return;
  }
  const f = join(dir, req.url.split('?')[0].split('#')[0]);
  try {
    const b = await readFile(f);
    const h = { 'Content-Type': tipos[extname(f)] || 'text/plain' };
    if (extname(f) === '.bin') h['Content-Disposition'] = 'attachment; filename="prueba.bin"';
    res.writeHead(200, h); res.end(b);
  } catch (_) { res.writeHead(404); res.end('no'); }
}).listen(8099, '127.0.0.1', () => console.log('fixture en http://localhost:8099'));
