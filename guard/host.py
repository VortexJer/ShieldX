r"""ShieldX Guard - programa auxiliar (native messaging host) de la extension ShieldX.

Una descarga que el usuario no pidio nunca existe legible en disco:
  - Downloads\ShieldX-temp es una CARPETA VIRTUAL (WinFsp + winfspy, ver vfs.py)
    montada por este proceso. Chrome descarga ahi como siempre, pero cada trozo
    que escribe se guarda YA DESORDENADO en cuarentena\vuelo (XOR con una clave
    aleatoria de 64 bytes por archivo, segun la posicion del byte).
  - Al terminar, el archivo se "adopta": su respaldo desordenado pasa a la
    cuarentena (carpeta "cuarentena" junto al auxiliar, fuera de Descargas).
  - Permitir: se restaura y se deja con su nombre real para que Chrome lo
    entregue. Cancelar y borrar: se borra.
Cada archivo queda anotado en estado.json (con su clave) para poder restaurarlo
o borrarlo aunque se cierre Chrome o se apague el equipo.

Sin WinFsp, queda el modo anterior: la carpeta es real y el archivo se desordena
(principio y final, o entero si es pequeno) en cuanto Chrome termina.
Solo opera sobre archivos de ShieldX-temp o de esa cuarentena.
"""
import ctypes
import json
import msvcrt
import os
import secrets
import shutil
import struct
import sys
import threading
import time

BASE = os.path.dirname(os.path.abspath(__file__))
DB = os.path.join(BASE, 'estado.json')
CARPETA = 'ShieldX-temp'                                      # subcarpeta oculta donde baja
CUARENTENA_DIR = os.path.join(os.path.dirname(BASE), 'cuarentena')  # fuera de Descargas
ENTREGA_DIR = os.path.join(CUARENTENA_DIR, 'entrega')             # restaurados con su nombre real
SUFIJO = '.bloqueado'
TROZO = 1 << 20          # 1 MiB
COMPLETO_MAX = 2 << 20   # hasta 2 MiB se desordena entero


def cargar():
    try:
        with open(DB, 'r', encoding='utf8') as f:
            return json.load(f)
    except Exception:
        return {}


def guardar(db):
    tmp = DB + '.tmp'
    with open(tmp, 'w', encoding='utf8') as f:
        json.dump(db, f)
    os.replace(tmp, DB)


def rangos(tam):
    if tam <= COMPLETO_MAX:
        return [(0, tam)] if tam else []
    return [(0, TROZO), (tam - TROZO, TROZO)]


def xor(datos, clave, off=0):
    """XOR con flujo de clave dependiente de la posicion absoluta `off`."""
    n = len(datos)
    if n == 0:
        return datos
    r = off % len(clave)
    base = clave[r:] + clave[:r]
    k = (base * (n // len(clave) + 1))[:n]
    return (int.from_bytes(datos, 'little') ^ int.from_bytes(k, 'little')).to_bytes(n, 'little')


def ruta_valida(ruta):
    """Cualquier archivo de ShieldX-temp (donde baja), o un .bloqueado de la cuarentena."""
    if not isinstance(ruta, str) or not ruta:
        return False
    p = os.path.normcase(os.path.abspath(ruta))
    padre = os.path.dirname(p)
    if os.path.basename(padre) == os.path.normcase(CARPETA):
        return True
    if padre == os.path.normcase(os.path.abspath(CUARENTENA_DIR)) and p.endswith(SUFIJO):
        return True
    # restaurado y listo para entregar: cuarentena\entrega\<id>\<nombre real>
    return os.path.dirname(padre) == os.path.normcase(os.path.abspath(ENTREGA_DIR))


_k32 = ctypes.WinDLL('kernel32', use_last_error=True)
_k32.CreateFileW.restype = ctypes.c_void_p
_k32.CreateFileW.argtypes = [ctypes.c_wchar_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p,
                             ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p]
_INVALIDO = ctypes.c_void_p(-1).value


def abrir_una_vez(ruta):
    # Comparte lectura, escritura Y BORRADO: asi nunca impide que Chrome renombre
    # el .crdownload a su nombre final mientras lo tenemos abierto.
    h = _k32.CreateFileW(ruta, 0xC0000000, 7, None, 3, 0x80, None)
    if h is None or h == _INVALIDO:
        raise OSError(ctypes.get_last_error(), 'no se pudo abrir ' + ruta)
    return os.fdopen(msvcrt.open_osfhandle(h, os.O_RDWR | os.O_BINARY), 'r+b')


def abrir_rw(ruta, intentos=40):
    ultimo = None
    for _ in range(intentos):
        try:
            return abrir_una_vez(ruta)
        except OSError as e:
            ultimo = e
            time.sleep(0.01)
    raise ultimo


def aplicar(ruta, clave, solo=None):
    """XOR sobre los rangos que toquen. `solo`: lista de rangos ya calculada."""
    with abrir_rw(ruta) as f:
        f.seek(0, os.SEEK_END)
        tam = f.tell()
        for off, ln in (solo if solo is not None else rangos(tam)):
            f.seek(off)
            datos = f.read(ln)
            f.seek(off)
            f.write(xor(datos, clave, off))
        f.flush()
    return tam


def restar_cabeza(lista, hecho):
    """Quita de los rangos lo ya desordenado en vivo ([0, hecho))."""
    res = []
    for off, ln in lista:
        fin = off + ln
        if fin <= hecho:
            continue
        ini = max(off, hecho)
        res.append((ini, fin - ini))
    return res


# ---- Vigilancia en vivo de los .crdownload ------------------------------------------------
LOCK = threading.RLock()
vigiladas = {}      # carpeta -> instante hasta el que se vigila
vuelo = {}          # ruta .crdownload -> {'clave': bytes, 'hecho': int}
desaparecidas = []  # [(t, ruta, estado)] .crdownload que ya no existen (renombrados)
ocultas = set()     # carpetas temporales ya marcadas como ocultas


def carpeta_descargas():
    """Carpeta Descargas real de Windows (FOLDERID_Downloads)."""
    try:
        class GUID(ctypes.Structure):
            _fields_ = [('a', ctypes.c_ulong), ('b', ctypes.c_ushort), ('c', ctypes.c_ushort),
                        ('d', ctypes.c_ubyte * 8)]
        g = GUID(0x374DE290, 0x123F, 0x4565, (ctypes.c_ubyte * 8)(0x91, 0x64, 0x39, 0xC4, 0x92, 0x5E, 0x46, 0x7B))
        ruta = ctypes.c_wchar_p()
        ctypes.windll.shell32.SHGetKnownFolderPath(ctypes.byref(g), 0, None, ctypes.byref(ruta))
        r = ruta.value
        ctypes.windll.ole32.CoTaskMemFree(ruta)
        if r:
            return r
    except Exception:
        pass
    return os.path.join(os.path.expanduser('~'), 'Downloads')


def carpeta_chrome():
    """Carpeta de descargas configurada en Chrome (o la de Windows si no hay)."""
    for perfil in ('Default', 'Profile 1', 'Profile 2'):
        try:
            pref = os.path.join(os.environ['LOCALAPPDATA'], 'Google', 'Chrome', 'User Data', perfil, 'Preferences')
            with open(pref, encoding='utf8') as f:
                d = json.load(f).get('download', {}).get('default_directory')
            if d and os.path.isdir(d):
                return d
        except Exception:
            pass
    return carpeta_descargas()


def vigilar(m):
    # La extensión manda la carpeta exacta en cuanto Chrome decide la ruta; sin
    # ella, se usa la carpeta de descargas configurada en Chrome.
    carpeta = m.get('dir') or os.path.join(carpeta_chrome(), CARPETA)
    if not isinstance(carpeta, str) or os.path.basename(os.path.normpath(carpeta)) != CARPETA:
        return {'ok': False, 'error': 'carpeta no permitida'}
    montada = montar_en(carpeta)
    with LOCK:
        vigiladas[os.path.normpath(carpeta)] = time.time() + 120
    return {'ok': True, 'dir': carpeta, 'virtual': montada}


def paso_vigilante():
    """Solo oculta la carpeta temporal. NO abre ni toca los archivos mientras Chrome
    los escribe: abrirlos un instante antes que Chrome le hace fallar la descarga
    (FILE_FAILED), y una vez abiertos por Chrome no se pueden modificar. El
    desordenado se hace cuando Chrome da la descarga por terminada."""
    ahora = time.time()
    with LOCK:
        carpetas = [c for c, hasta in vigiladas.items() if hasta > ahora]
        for c in [c for c, hasta in vigiladas.items() if hasta <= ahora]:
            vigiladas.pop(c, None)
    for carpeta in carpetas:
        if carpeta not in ocultas and os.path.isdir(carpeta):
            ctypes.windll.kernel32.SetFileAttributesW(carpeta, 0x2)   # FILE_ATTRIBUTE_HIDDEN
            ocultas.add(carpeta)


def hilo_vigilante():
    while True:
        try:
            paso_vigilante()
        except Exception:
            pass
        time.sleep(0.05)


def estado_en_vuelo(ruta_final):
    """Recupera lo desordenado en vivo para este archivo (o None)."""
    esperado = ruta_final + '.crdownload'
    with LOCK:
        if esperado in vuelo:
            return vuelo.pop(esperado)
        for i, (t, r, st) in enumerate(desaparecidas):
            if r == esperado:
                return desaparecidas.pop(i)[2]
        # Chrome a veces usa "Unconfirmed N.crdownload": se toma el mas reciente que ya no existe
        sueltos = [i for i, (t, r, st) in enumerate(desaparecidas)
                   if os.path.dirname(r) == os.path.dirname(ruta_final)]
        if sueltos:
            return desaparecidas.pop(sueltos[-1])[2]
        sueltos = [r for r in vuelo if os.path.dirname(r) == os.path.dirname(ruta_final) and not os.path.exists(r)]
        if sueltos:
            return vuelo.pop(sueltos[-1])
    return None


# ---- Carpeta virtual (WinFsp): Chrome escribe y en disco solo queda desordenado ----
VUELO_DIR = os.path.join(CUARENTENA_DIR, 'vuelo')
montajes = {}        # carpeta normalizada -> (fs, ops)
error_montaje = None


def montar_en(carpeta):
    """Monta la carpeta virtual en `carpeta` (si aún no lo está). Devuelve True si queda montada."""
    global error_montaje
    clave = os.path.normcase(os.path.abspath(carpeta))
    if clave in montajes:
        return True
    try:
        import vfs   # necesita WinFsp + winfspy (Python 3.11)
    except Exception as e:
        error_montaje = 'sin winfspy: %s' % e
        return False
    try:
        if os.path.isdir(carpeta) and not os.path.ismount(carpeta):
            if os.listdir(carpeta):
                error_montaje = 'la carpeta %s no está vacía' % carpeta
                return False
            os.rmdir(carpeta)   # WinFsp necesita que el punto de montaje no exista
        fs, ops = vfs.montar(carpeta, VUELO_DIR)
        montajes[clave] = (fs, ops)
        try:
            ctypes.windll.kernel32.SetFileAttributesW(carpeta, 0x2)   # oculta
        except Exception:
            pass
        return True
    except Exception as e:
        error_montaje = '%s: %s' % (type(e).__name__, e)
        if not os.path.isdir(carpeta):
            os.makedirs(carpeta, exist_ok=True)   # sin montaje, al menos que Chrome pueda escribir
        return False


def montaje_de(ruta):
    return montajes.get(os.path.normcase(os.path.abspath(os.path.dirname(ruta))))


def estado_montaje(_m):
    return {'ok': True, 'montajes': list(montajes), 'error': error_montaje}


def aplicar_completo(ruta, clave):
    """XOR de TODO el archivo, por trozos (archivos adoptados de la carpeta virtual)."""
    paso = 4 << 20
    with abrir_rw(ruta) as f:
        f.seek(0, os.SEEK_END)
        tam = f.tell()
        off = 0
        while off < tam:
            n = min(paso, tam - off)
            f.seek(off)
            datos = f.read(n)
            f.seek(off)
            f.write(xor(datos, clave, off))
            off += n
        f.flush()
    return tam


def desordenar(m):
    id_, ruta = str(m.get('id')), m.get('path')
    if not ruta_valida(ruta):
        return {'ok': False, 'error': 'ruta no permitida'}
    mont = montaje_de(ruta)
    if mont is not None:
        os.makedirs(CUARENTENA_DIR, exist_ok=True)
        seguro = ''.join(c if c.isalnum() or c in '-_' else '_' for c in id_)[-80:]
        destino = os.path.join(CUARENTENA_DIR, seguro + SUFIJO)
        t0 = time.perf_counter()
        r = mont[1].adoptar(os.path.basename(ruta), destino)
        if r is None:
            return {'ok': False, 'error': 'no está en la carpeta virtual'}
        clave, tam = r
        db = cargar()
        db[id_] = {'path': destino, 'clave': clave.hex(), 'desordenado': True, 'modo': 'completo',
                   'nombre': m.get('nombre', ''), 't': time.time(), 'tam': tam,
                   'destino': os.path.dirname(os.path.dirname(ruta))}
        guardar(db)
        return {'ok': True, 'virtual': True, 'path': destino, 'tam': tam,
                'ms': round((time.perf_counter() - t0) * 1000, 2)}
    with LOCK:
        db = cargar()
        if id_ in db and db[id_].get('desordenado'):
            return {'ok': True, 'ya': True, 'path': db[id_]['path']}
        auto = db.pop('auto:' + os.path.normcase(os.path.abspath(ruta)), None)
        if auto:
            # El vigilante lo pilló al aparecer: solo se le pone el id y el nombre real.
            auto['nombre'] = m.get('nombre', '') or auto.get('nombre', '')
            db[id_] = auto
            guardar(db)
            return {'ok': True, 'auto': True, 'path': auto['path'], 'enVivo': auto.get('hecho', 0)}
        return _desordenar(id_, ruta, m.get('nombre', ''))


def _desordenar(id_, ruta, nombre):
    db = cargar()
    vivo = estado_en_vuelo(ruta)
    clave = vivo['clave'] if vivo else secrets.token_bytes(64)
    hecho = vivo['hecho'] if vivo else 0
    # Primero se anota (con la clave) y despues se toca el archivo: si algo se
    # corta a medias, el registro permite deshacerlo.
    db[id_] = {'path': ruta, 'clave': clave.hex(), 'desordenado': False,
               'nombre': nombre, 't': time.time(), 'hecho': hecho}
    guardar(db)
    t0 = time.perf_counter()
    with abrir_rw(ruta) as f:
        f.seek(0, os.SEEK_END)
        tam = f.tell()
    pendiente = restar_cabeza(rangos(tam), hecho)
    aplicar(ruta, clave, pendiente)
    db = cargar()
    for k in [k for k in db if k.startswith('vuelo:')]:
        if k.endswith('.crdownload') and os.path.dirname(k[6:]) == os.path.dirname(ruta) and not os.path.exists(k[6:]):
            db.pop(k, None)
    db[id_]['desordenado'] = True
    db[id_]['tam'] = tam
    guardar(db)
    # Ya inutilizable: se saca de la carpeta de descargas a la cuarentena de verdad.
    os.makedirs(CUARENTENA_DIR, exist_ok=True)
    seguro = ''.join(c if c.isalnum() or c in '-_' else '_' for c in id_)[-80:]
    nuevo = os.path.join(CUARENTENA_DIR, seguro + SUFIJO)
    for _ in range(100):
        try:
            shutil.move(ruta, nuevo)
            break
        except OSError:
            time.sleep(0.02)   # Chrome aún suelta el archivo
    if os.path.exists(nuevo):
        db[id_]['path'] = nuevo
        db[id_]['destino'] = os.path.dirname(os.path.dirname(ruta))
        guardar(db)
    return {'ok': True, 'ms': round((time.perf_counter() - t0) * 1000, 2), 'tam': tam,
            'enVivo': hecho, 'path': db[id_]['path']}


def limpio(nombre):
    nombre = os.path.basename(str(nombre or 'descarga'))
    for c in '\\/:*?"<>|':
        nombre = nombre.replace(c, '_')
    return nombre.strip(' .') or 'descarga'


def restaurar(m):
    id_ = str(m.get('id'))
    db = cargar()
    r = db.get(id_)
    if not r:
        return {'ok': False, 'error': 'desconocido'}
    if not ruta_valida(r['path']) or not os.path.exists(r['path']):
        return {'ok': False, 'error': 'archivo no encontrado'}
    if r.get('desordenado'):
        if r.get('modo') == 'completo':
            aplicar_completo(r['path'], bytes.fromhex(r['clave']))
        else:
            aplicar(r['path'], bytes.fromhex(r['clave']))
        r['desordenado'] = False
        guardar(db)
    seguro = ''.join(c if c.isalnum() or c in '-_' else '_' for c in id_)[-80:]
    carpeta = os.path.join(ENTREGA_DIR, seguro)
    destino = os.path.join(carpeta, limpio(m.get('nombre') or r.get('nombre')))
    if os.path.normcase(r['path']) != os.path.normcase(destino):
        os.makedirs(carpeta, exist_ok=True)
        shutil.move(r['path'], destino)
        r['path'] = destino
        guardar(db)
    return {'ok': True, 'path': r['path']}


def nombre_libre(carpeta, nombre):
    base, ext = os.path.splitext(nombre)
    cand, i = nombre, 1
    while os.path.exists(os.path.join(carpeta, cand)):
        cand = '%s (%d)%s' % (base, i, ext)
        i += 1
    return cand


def mover(m):
    id_ = str(m.get('id'))
    db = cargar()
    r = db.get(id_)
    if not r or r.get('desordenado'):
        return {'ok': False, 'error': 'no restaurado'}
    ruta = r['path']
    if not ruta_valida(ruta) or not os.path.exists(ruta):
        return {'ok': False, 'error': 'archivo no encontrado'}
    nombre = os.path.basename(str(m.get('nombre') or r.get('nombre') or 'descarga'))
    for c in '\\/:*?"<>|':
        nombre = nombre.replace(c, '_')
    destino = r.get('destino') or carpeta_chrome()
    libre = nombre_libre(destino, nombre)
    shutil.move(ruta, os.path.join(destino, libre))
    try:
        os.rmdir(os.path.dirname(ruta)) if os.path.dirname(os.path.dirname(os.path.normcase(ruta))) == os.path.normcase(os.path.abspath(ENTREGA_DIR)) else None
    except OSError:
        pass
    db.pop(id_, None)
    guardar(db)
    return {'ok': True, 'nombre': libre}


def borrar(m):
    id_ = str(m.get('id'))
    db = cargar()
    r = db.pop(id_, None)
    if r and ruta_valida(r['path']):
        try:
            os.remove(r['path'])
        except FileNotFoundError:
            pass
        padre = os.path.dirname(r['path'])
        if os.path.dirname(os.path.normcase(padre)) == os.path.normcase(os.path.abspath(ENTREGA_DIR)):
            try:
                os.rmdir(padre)
            except OSError:
                pass
    guardar(db)
    return {'ok': True}


def listar(_m):
    return {'ok': True, 'pendientes': [
        {'id': k, 'nombre': v.get('nombre'), 'path': v.get('path'), 'desordenado': v.get('desordenado')}
        for k, v in cargar().items() if not k.startswith('vuelo:')]}


ORDENES = {'estado': estado_montaje, 'vigilar': vigilar, 'desordenar': desordenar, 'restaurar': restaurar, 'mover': mover,
           'borrar': borrar, 'listar': listar, 'ping': lambda m: {'ok': True}}


def leer():
    cab = sys.stdin.buffer.read(4)
    if len(cab) < 4:
        return None
    (n,) = struct.unpack('<I', cab)
    return json.loads(sys.stdin.buffer.read(n).decode('utf8'))


def escribir(obj):
    datos = json.dumps(obj).encode('utf8')
    sys.stdout.buffer.write(struct.pack('<I', len(datos)) + datos)
    sys.stdout.buffer.flush()


def main():
    montar_en(os.path.join(carpeta_chrome(), CARPETA))
    threading.Thread(target=hilo_vigilante, daemon=True).start()
    while True:
        m = leer()
        if m is None:
            break
        try:
            f = ORDENES.get(m.get('cmd'))
            resp = f(m) if f else {'ok': False, 'error': 'orden desconocida'}
        except Exception as e:  # nunca tumbar el host por un archivo raro
            resp = {'ok': False, 'error': '%s: %s' % (type(e).__name__, e)}
        resp['rid'] = m.get('rid')
        with LOCK:
            escribir(resp)


if __name__ == '__main__':
    main()
