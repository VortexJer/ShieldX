"""Carpeta virtual de ShieldX (WinFsp + winfspy).

Downloads\\ShieldX-temp deja de ser una carpeta normal: la monta este módulo.
Todo lo que Chrome escribe ahí se guarda en disco YA DESORDENADO (XOR con una
clave aleatoria por archivo, dependiente de la posición del byte), en
ShieldX\\cuarentena\\vuelo\\<uuid>.bin. El archivo completo y legible no existe
nunca en disco: solo se reconstruye en memoria, trozo a trozo, cuando alguien
lee a través de la carpeta virtual (Chrome lo necesita para terminar).

Al terminar la descarga, el auxiliar "adopta" el archivo: lo saca del espacio
de nombres virtual y mueve su respaldo (ya desordenado) a la cuarentena.
"""
import os
import secrets
import threading
import uuid
from pathlib import PureWindowsPath

from winfspy import FileSystem, NTStatusEndOfFile
from winfspy.plumbing.win32_filetime import filetime_now
import winfspy.memfs as memfs

CLAVE_LEN = 64


def xor(datos, clave, off=0):
    n = len(datos)
    if n == 0:
        return bytes(datos)
    r = off % len(clave)
    base = clave[r:] + clave[:r]
    k = (base * (n // len(clave) + 1))[:n]
    return (int.from_bytes(datos, 'little') ^ int.from_bytes(k, 'little')).to_bytes(n, 'little')


class Respaldo:
    """El contenido de un archivo virtual, guardado desordenado en disco."""

    def __init__(self, carpeta):
        os.makedirs(carpeta, exist_ok=True)
        self.ruta = os.path.join(carpeta, uuid.uuid4().hex + '.bin')
        self.clave = secrets.token_bytes(CLAVE_LEN)
        self.f = open(self.ruta, 'w+b')
        self.lock = threading.Lock()
        self.adoptado = False

    def leer(self, off, n):
        with self.lock:
            self.f.seek(off)
            return xor(self.f.read(n), self.clave, off)

    def escribir(self, off, datos):
        with self.lock:
            self.f.seek(off)
            self.f.write(xor(bytes(datos), self.clave, off))

    def truncar(self, tam):
        with self.lock:
            actual = os.fstat(self.f.fileno()).st_size
            if tam < actual:
                self.f.truncate(tam)
            elif tam > actual:
                # la zona nueva debe leerse como ceros: se guardan ceros desordenados
                self.f.seek(actual)
                paso = 1 << 20
                off = actual
                while off < tam:
                    n = min(paso, tam - off)
                    self.f.write(xor(bytes(n), self.clave, off))
                    off += n

    def cerrar(self):
        with self.lock:
            try:
                self.f.flush()
                self.f.close()
            except Exception:
                pass

    def borrar(self):
        self.cerrar()
        if not self.adoptado:
            try:
                os.remove(self.ruta)
            except OSError:
                pass


def crear_clase_archivo(carpeta_respaldo):
    class ArchivoDesordenado(memfs.FileObj):   # subclase: memfs exige FileObj al renombrar
        allocation_unit = 4096

        def __init__(self, path, attributes, security_descriptor, allocation_size=0):
            memfs.BaseFileObj.__init__(self, path, attributes, security_descriptor)   # sin el bytearray de memfs
            self.respaldo = Respaldo(carpeta_respaldo)
            self._alloc = 0
            self.attributes |= memfs.FILE_ATTRIBUTE.FILE_ATTRIBUTE_ARCHIVE
            if allocation_size:
                self.set_allocation_size(allocation_size)

        @property
        def allocation_size(self):
            return self._alloc

        def set_allocation_size(self, allocation_size):
            self._alloc = allocation_size
            if self.file_size > allocation_size:
                self.respaldo.truncar(allocation_size)
                self.file_size = allocation_size

        def adapt_allocation_size(self, file_size):
            units = (file_size + self.allocation_unit - 1) // self.allocation_unit
            self.set_allocation_size(units * self.allocation_unit)

        def set_file_size(self, file_size):
            if file_size != self.file_size:
                self.respaldo.truncar(file_size)
            if file_size > self._alloc:
                self.adapt_allocation_size(file_size)
            self.file_size = file_size

        def read(self, offset, length):
            if offset >= self.file_size:
                raise NTStatusEndOfFile()
            fin = min(self.file_size, offset + length)
            return self.respaldo.leer(offset, fin - offset)

        def write(self, buffer, offset, write_to_end_of_file):
            if write_to_end_of_file:
                offset = self.file_size
            fin = offset + len(buffer)
            if fin > self.file_size:
                self.set_file_size(fin)
            self.respaldo.escribir(offset, buffer)
            return len(buffer)

        def constrained_write(self, buffer, offset):
            if offset >= self.file_size:
                return 0
            fin = min(self.file_size, offset + len(buffer))
            n = fin - offset
            self.respaldo.escribir(offset, bytes(buffer[:n]))
            return n

    return ArchivoDesordenado


class Operaciones(memfs.InMemoryFileSystemOperations):
    """memfs con archivos desordenados en disco y limpieza de respaldos."""

    def __init__(self, clase_archivo):
        super().__init__('ShieldX', read_only=False)
        self._clase = clase_archivo

    def _es_nuestro(self, obj):
        return isinstance(obj, self._clase)

    @memfs.operation
    def create(self, file_name, create_options, granted_access, file_attributes,
               security_descriptor, allocation_size):
        file_name = PureWindowsPath(file_name)
        try:
            padre = self._entries[file_name.parent]
            if not isinstance(padre, memfs.FolderObj):
                raise memfs.NTStatusNotADirectory()
        except KeyError:
            raise memfs.NTStatusObjectNameNotFound()
        if file_name in self._entries:
            raise memfs.NTStatusObjectNameCollision()
        if create_options & memfs.CREATE_FILE_CREATE_OPTIONS.FILE_DIRECTORY_FILE:
            obj = self._entries[file_name] = memfs.FolderObj(file_name, file_attributes, security_descriptor)
        else:
            obj = self._entries[file_name] = self._clase(file_name, file_attributes, security_descriptor, allocation_size)
        return memfs.OpenedObj(obj)

    @memfs.operation
    def cleanup(self, file_context, file_name, flags):
        obj = file_context.file_obj
        borrar = flags & 0x01
        presente = obj.path in self._entries
        # el método base sin su decorador: el candado de memfs no es reentrante
        memfs.InMemoryFileSystemOperations.cleanup.__wrapped__(self, file_context, file_name, flags)
        if borrar and presente and obj.path not in self._entries and self._es_nuestro(obj):
            obj.respaldo.borrar()

    @memfs.operation
    def rename(self, file_context, file_name, new_file_name, replace_if_exists):
        destino = PureWindowsPath(new_file_name)
        pisado = self._entries.get(destino)
        memfs.InMemoryFileSystemOperations.rename.__wrapped__(self, file_context, file_name, new_file_name, replace_if_exists)
        if pisado is not None and self._es_nuestro(pisado) and pisado is not file_context.file_obj:
            pisado.respaldo.borrar()

    def adoptar(self, nombre, destino):
        """Saca `nombre` de la carpeta virtual y mueve su respaldo desordenado a
        `destino`. Devuelve (clave, tamaño) o None si no existe."""
        with self._thread_lock:
            ruta = PureWindowsPath('\\' + nombre)
            obj = self._entries.get(ruta)
            if obj is None or not self._es_nuestro(obj):
                return None
            tam = obj.file_size
            obj.respaldo.truncar(tam)
            obj.respaldo.cerrar()
            obj.respaldo.adoptado = True
            os.replace(obj.respaldo.ruta, destino)
            del self._entries[ruta]
            return obj.respaldo.clave, tam


def montar(punto, carpeta_respaldo):
    """Monta la carpeta virtual en `punto` (ruta que NO debe existir)."""
    clase = crear_clase_archivo(carpeta_respaldo)
    ops = Operaciones(clase)
    fs = FileSystem(
        str(punto), ops,
        sector_size=512, sectors_per_allocation_unit=1,
        volume_creation_time=filetime_now(), volume_serial_number=0,
        file_info_timeout=1000,
        case_sensitive_search=0, case_preserved_names=1, unicode_on_disk=1,
        persistent_acls=1, post_cleanup_when_modified_only=1,
        um_file_context_is_user_context2=1,
        file_system_name='ShieldX',
        reject_irp_prior_to_transact0=True,
    )
    fs.start()
    return fs, ops
