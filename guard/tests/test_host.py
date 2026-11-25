import hashlib, json, os, shutil, struct, subprocess, sys, tempfile, time

HOST = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'host.py')
raiz = tempfile.mkdtemp(prefix='sxg_')
q = os.path.join(raiz, 'ShieldX-temp')
os.makedirs(q)

# El host guarda estado.json junto a host.py: se prueba con una copia aislada.
aislado = os.path.join(raiz, 'host')
os.makedirs(aislado)
shutil.copy(HOST, os.path.join(aislado, 'host.py'))
p = subprocess.Popen([sys.executable, '-u', os.path.join(aislado, 'host.py')],
                     stdin=subprocess.PIPE, stdout=subprocess.PIPE)
rid = [0]


def llamar(**kw):
    rid[0] += 1
    kw['rid'] = rid[0]
    d = json.dumps(kw).encode()
    p.stdin.write(struct.pack('<I', len(d)) + d); p.stdin.flush()
    n = struct.unpack('<I', p.stdout.read(4))[0]
    return json.loads(p.stdout.read(n))


def sha(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''):
            h.update(b)
    return h.hexdigest()


fallos = 0
def ok(cond, txt):
    global fallos
    print(('OK    ' if cond else 'FALLO ') + txt)
    if not cond:
        fallos += 1


casos = {'pequeno.txt': 1500, 'vacio.bin': 0, 'justo2MB.dat': 2 << 20, 'grande-120MB.exe': 120 << 20}
for i, (nom, tam) in enumerate(casos.items(), 1):
    f = os.path.join(q, nom + '.bloqueado')
    with open(f, 'wb') as fh:
        fh.write(os.urandom(tam) if tam < (8 << 20) else (b'MZ' + os.urandom(1 << 20)) * (tam >> 20))
    h0 = sha(f)
    t0 = time.perf_counter()
    r = llamar(cmd='desordenar', id=i, path=f, nombre=nom)
    f = r.get('path', f)
    ok(os.path.dirname(f) == os.path.join(raiz, 'cuarentena'), '%s: sale de la carpeta de descargas a la cuarentena' % nom)
    dt = (time.perf_counter() - t0) * 1000
    ok(r['ok'], '%s: desordenar ok (%.1f ms total, %s ms de trabajo)' % (nom, dt, r.get('ms')))
    if tam:
        ok(sha(f) != h0, '%s: el contenido CAMBIA tras desordenar' % nom)
    r = llamar(cmd='restaurar', id=i, nombre=nom)
    f = r.get('path', f)
    ok(os.path.basename(f) == nom, '%s: restaurado con su nombre real (para que Chrome lo entregue asi)' % nom)
    ok(r['ok'] and sha(f) == h0, '%s: restaurar devuelve el archivo identico' % nom)
    r = llamar(cmd='mover', id=i, nombre=nom)
    dest = os.path.join(raiz, r.get('nombre', '?'))
    ok(r['ok'] and os.path.exists(dest) and sha(dest) == h0 and not os.path.exists(f),
       '%s: mover entrega a Descargas con su nombre real y vacia la cuarentena' % nom)

f = os.path.join(q, 'borra.txt.bloqueado'); open(f, 'wb').write(b'hola' * 1000)
f = llamar(cmd='desordenar', id=99, path=f, nombre='borra.txt')['path']
r = llamar(cmd='borrar', id=99)
ok(r['ok'] and not os.path.exists(f), 'borrar elimina el archivo')

f = os.path.join(q, 'doble.txt.bloqueado'); open(f, 'wb').write(os.urandom(5000)); h0 = sha(f)
f = llamar(cmd='desordenar', id=50, path=f, nombre='doble.txt')['path']; llamar(cmd='desordenar', id=50, path=f, nombre='doble.txt')
f = llamar(cmd='restaurar', id=50)['path']
ok(sha(f) == h0, 'desordenar dos veces seguidas no estropea la restauracion')

fuera = os.path.join(raiz, 'importante.txt'); open(fuera, 'wb').write(b'no tocar')
ok(not llamar(cmd='desordenar', id=60, path=fuera)['ok'], 'rechaza rutas fuera de ShieldX-temp')
fuera2 = os.path.join(raiz, 'cuarentena', 'ajeno.txt'); os.makedirs(os.path.dirname(fuera2), exist_ok=True); open(fuera2, 'wb').write(b'no tocar')
ok(not llamar(cmd='desordenar', id=61, path=fuera2)['ok'], 'rechaza en la cuarentena lo que no es .bloqueado')
ok(open(fuera, 'rb').read() == b'no tocar' and open(fuera2, 'rb').read() == b'no tocar', 'los archivos ajenos quedan intactos')
ok(not llamar(cmd='restaurar', id=777)['ok'], 'restaurar un id desconocido falla con limpieza')

a = os.path.join(q, 'x.txt.bloqueado'); open(a, 'wb').write(b'1')
llamar(cmd='desordenar', id=70, path=a, nombre='x.txt'); llamar(cmd='restaurar', id=70)
open(os.path.join(raiz, 'x.txt'), 'wb').write(b'ya existe')
r = llamar(cmd='mover', id=70, nombre='x.txt')
ok(r['ok'] and r['nombre'] == 'x (1).txt' and open(os.path.join(raiz, 'x.txt'), 'rb').read() == b'ya existe', 'mover no pisa un archivo existente (x (1).txt)')

p.stdin.close(); p.wait(timeout=5)
shutil.rmtree(raiz, ignore_errors=True)
print(('\n%d fallo(s)' % fallos) if fallos else '\nAUXILIAR OK')
sys.exit(1 if fallos else 0)
