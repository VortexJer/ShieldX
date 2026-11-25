"""Prueba de la carpeta virtual: lo que se escribe nunca está legible en disco."""
import hashlib
import os
import shutil
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import vfs  # noqa: E402

raiz = tempfile.mkdtemp(prefix='sxvfs_')
punto = os.path.join(raiz, 'ShieldX-temp')          # no debe existir: lo crea WinFsp
respaldo = os.path.join(raiz, 'vuelo')
fallos = 0


def ok(c, t):
    global fallos
    print(('OK    ' if c else 'FALLO ') + t)
    if not c:
        fallos += 1


fs, ops = vfs.montar(punto, respaldo)
try:
    ok(os.path.isdir(punto), 'la carpeta virtual está montada')
    datos = b'%PDF-1.7 CABECERA-LEGIBLE ' + os.urandom(5 * (1 << 20))
    h0 = hashlib.sha256(datos).hexdigest()

    # Chrome: reserva el nombre final con un archivo vacío y escribe en un .crdownload
    final = os.path.join(punto, 'contrato.pdf')
    open(final, 'wb').close()
    tmp = os.path.join(punto, 'Sin confirmar 123.crdownload')
    legible_en_disco = False
    with open(tmp, 'wb') as f:
        for i in range(0, len(datos), 256 * 1024):
            f.write(datos[i:i + 256 * 1024])
            f.flush()
            for b in os.listdir(respaldo):
                with open(os.path.join(respaldo, b), 'rb') as g:
                    if b'%PDF' in g.read(64) or b'CABECERA-LEGIBLE' in g.read():
                        legible_en_disco = True
    ok(not legible_en_disco, 'durante la escritura, en disco NUNCA aparece el contenido legible')
    with open(tmp, 'rb') as f:
        ok(f.read(9) == datos[:9], 'leyendo por la carpeta virtual se ve el contenido (Chrome lo necesita)')

    os.replace(tmp, final)   # Chrome renombra al terminar, pisando la reserva vacía
    with open(final, 'rb') as f:
        ok(hashlib.sha256(f.read()).hexdigest() == h0, 'tras renombrar, el contenido es íntegro por la carpeta virtual')
    ok(len(os.listdir(respaldo)) == 1, 'la reserva vacía pisada no deja respaldo huérfano')

    destino = os.path.join(raiz, 'adoptado.bloqueado')
    t0 = time.perf_counter()
    r = ops.adoptar('contrato.pdf', destino)
    ok(r is not None and not os.path.exists(final), 'adoptar lo saca de la carpeta virtual (%.1f ms)' % ((time.perf_counter() - t0) * 1000))
    clave, tam = r
    with open(destino, 'rb') as f:
        crudo = f.read()
    ok(b'%PDF' not in crudo[:64] and hashlib.sha256(crudo).hexdigest() != h0 and tam == len(datos), 'el archivo adoptado está desordenado entero en disco')
    claro = vfs.xor(crudo, clave, 0)
    ok(hashlib.sha256(claro).hexdigest() == h0, 'con su clave se restaura idéntico (sha256)')

    # borrar en la carpeta virtual borra el respaldo
    p = os.path.join(punto, 'basura.bin')
    with open(p, 'wb') as f:
        f.write(b'x' * 1000)
    antes = len(os.listdir(respaldo))
    os.remove(p)
    ok(len(os.listdir(respaldo)) == antes - 1, 'borrar en la carpeta virtual borra su respaldo')
finally:
    fs.stop()
    shutil.rmtree(raiz, ignore_errors=True)

print(('\n%d fallo(s)' % fallos) if fallos else '\nVFS OK')
sys.exit(1 if fallos else 0)
