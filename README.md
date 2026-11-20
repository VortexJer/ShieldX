# ShieldX

Bloqueador de anuncios, rastreadores, banners de cookies y redirecciones forzadas
para Chrome (Manifest V3).

## Qué hace

| Capa | Fichero | Cometido |
|---|---|---|
| Red | `rules/ads.json` | 310 reglas `declarativeNetRequest` contra dominios de anuncios y telemetría |
| Red | `rules/redirect.json` | 55 reglas contra redes de pop-under y redirección (PopAds, PropellerAds, ExoClick, Adsterra…), incluida la navegación principal |
| Red | `rules/cleanurl.json` | Limpia los parámetros de rastreo de las URLs al navegar (`utm_*`, `gclid`, `fbclid`, `msclkid`, `igshid`…) |
| Picker | `content.js` + menú contextual | «Ocultar elemento»: señala cualquier cosa de una página y ShieldX la oculta y la recuerda para ese sitio; restaurable desde el popup. Se sale con **Esc**, con **clic derecho** o con el botón **SALIR** del cartel |
| DOM | `content.js` | Oculta contenedores publicitarios, retira scripts de redes de anuncios, oculta banners de cookies (sin pulsar nada en nombre del usuario) y elimina las capas transparentes que roban el primer clic |
| Página | `guard.js` | Bloquea `window.open` y los saltos a otro dominio que no haya pedido el usuario |
| YouTube | `youtube.js` | Poda los anuncios en los datos antes de pintarse (reproductor, `get_watch`, Shorts, feed, búsqueda y columna lateral), oculta los renderers, y si alguno se cuela lo lleva a su final |
| Muros | `content.js` | Retira los muros de «desactiva tu bloqueador» y devuelve el scroll — sin pulsar nada suyo |
| Descargas | `background.js` | Pausa y pregunta cuando un fichero empieza a descargarse sin que lo hayas pedido |
| UI | `popup.html` · `popup.js` | Interruptores, exclusión por sitio y contadores |

### Resultados patrocinados

Los buscadores rotan las clases de sus anuncios y cambian dónde los colocan
(Google ya no usa `#tads`: los intercala entre los resultados orgánicos). Por eso
no se detectan por clase sino por **la etiqueta visible** —«Resultados
patrocinados», «Sponsored», «Anuncio»—, que es lo único que no pueden quitar.

### Qué NO se toca nunca

Un bloqueador que se lleva por delante un botón o un panel de ajustes molesta
más que los anuncios. Las reglas que lo evitan, todas comprobadas navegando de
verdad:

- **Lo que abres tú.** Si acabas de hacer clic, lo que aparezca en el segundo
  siguiente es asunto tuyo: no se oculta. Y si trae interruptores por finalidad
  (un panel de preferencias), se respeta ya para siempre.
- **Ventanas que tardan en abrirse.** Una pasarela de pago o un inicio de
  sesión con Google abren su ventana *después* de hablar con el servidor. Si
  pulsaste un enlace o un botón de verdad, hay 5 segundos de margen; si sólo
  pulsaste algo que *parecía* un botón (un `<div>` con el cursor de mano), 1,5.
  Al pop-under no le sirve de nada: dispara en el mismo instante del clic y
  sigue limitado a una ventana por gesto.
- **El «play» de una web de streaming no es un botón.** Es un `<div>` enorme
  con cursor de mano encima del reproductor, y es la puerta de entrada del
  pop-under: si el elemento con cursor de mano contiene un vídeo, o pasa de un
  cuarto de la pantalla, no cuenta como intención de abrir nada.
- **Botones que no son `<button>`.** Media web moderna hace los botones con un
  `<div>`. Antes esos clics no contaban como intención y su ventana emergente
  —el `popup` de OAuth, el de configuración— salía bloqueada. Ahora también
  cuenta el control hecho a mano; la trampa clásica (el `cursor:pointer` puesto
  sobre una capa a pantalla completa o sobre el `body`) sigue sin contar.
- **Descargas que pides.** El botón «Exportar» que crea un `<a download>` o un
  `blob:` al vuelo funciona; el pop-under que crea un `<a target="_blank">`
  hacia otro dominio, no.
- **Diálogos.** Un modal solo se toma por banner de cookies si menciona cookies
  de forma explícita **y** habla de aceptar, rechazar o configurar. Un modal de
  registro que enlaza la política de privacidad no cumple eso, y por eso ya no
  desaparece.
- **Un anuncio tiene algo que enseñar.** Los nombres de la lista ambigua
  (`.promo-banner`, `.ad-box`…) los usan también los avisos de la propia web.
  Un bloque que solo lleva una frase —«tu pedido se ha guardado», «revisa el
  número de tarjeta»— no se oculta salvo que traiga imagen, iframe o enlace, o
  tenga medidas de formato publicitario (300×250, 728×90…).
- **Dentro de un iframe no se oculta ningún banner.** El aviso de un CMP suele
  vivir en su propio iframe: vaciarlo desde dentro deja el iframe a pantalla
  completa pero en blanco, con el velo del sitio puesto y el scroll bloqueado —
  la página queda inservible, ni se lee ni se puede responder. Verificado así en
  `as.com`. Los banners solo se ocultan desde el marco superior, escondiendo el
  iframe entero; si desde ahí no se reconoce, se deja intacto a propósito.

Y si algún día quieres responder al aviso, el popup tiene **Aviso de cookies →
MOSTRAR**: lo devuelve a la página tal cual estaba. Hay sitios (Marca, sin ir
más lejos) donde el único acceso a «Configuración de cookies» vive dentro del
propio banner, así que ocultarlo dejaba sin salida.

### Clientes de correo

En Gmail, Outlook, Proton y cualquier host tipo `mail.*` o `webmail.*`, la capa
de ocultado **no entra nunca**. El cuerpo de un correo es HTML ajeno y
arbitrario: puede traer cualquier nombre de clase o cualquier imagen con
«banner» en la ruta, y ocultarlo significa esconderle correo al usuario. El
anti-redirección, las descargas vigiladas y la capa de red siguen funcionando
ahí con normalidad.

### YouTube

Tres capas, medidas contra el YouTube real:

1. **Poda de datos**: los anuncios se quitan del JSON antes de que YouTube lo
   pinte. En el reproductor (`ytInitialPlayerResponse`, `get_watch`, `player`,
   Shorts) se borran `adPlacements`/`playerAds` y `adSlots` se deja vacío; en
   feed, búsqueda y columna lateral (`ytInitialData`, `browse`, `search`,
   `next`) se sacan de su lista los elementos que solo son anuncio. **Jamás
   bloquea la petición**: ante cualquier error se entrega la respuesta
   original. `/player/ad_break` se deja pasar a propósito.
   Desde 2026-11, al quitar el anuncio el servidor impone una espera antes del
   vídeo (orden de *backoff* firmada en el protocolo SABR, ~10-15 s al navegar
   entre vídeos). No se puede saltar desde el navegador: forzarla a 0 solo
   genera reintentos rechazados. Sin bloquear, los anuncios duran 15-39 s.
2. **Salto activo**: si aun así entra un anuncio, se pulsa «Saltar» si existe;
   si no (lo normal desde 2026-11), se silencia y se lleva a su final, con
   salvaguarda: si el `<video>` dura lo mismo que el vídeo real
   (`getDuration()` del reproductor), no se toca. La detección usa **solo** la
   clase del `#movie_player` (`ad-showing`): los nodos `.ytp-ad-*` persisten
   ocultos al terminar el anuncio.
3. **Cosmética y red**: los renderers de anuncio (también los nuevos
   `*-view-model` y la estantería de entradas) se eliminan del DOM y se cubren
   por CSS; las balizas de impresión (`/api/stats/ads`, `/pagead/`,
   `/ptracking`, `/pcs/activeview`) se bloquean en red.
4. **El aviso «el reproductor se bloqueará»**: YouTube detecta el bloqueo y
   planta un modal que pausa el vídeo (el `<video>` conserva su `src`: solo
   está pausado). Se retira el diálogo y se reanuda lo que estabas viendo,
   dejando de insistir en cuanto tocas algo — si la pausa la das tú, manda tu
   pausa. **No se pulsa ninguno de sus botones**: ni «Permitir anuncios» ni
   «Probar Premium». Esas son decisiones tuyas.

### Anti-redirección

La regla es que un clic sólo autoriza una ventana o un salto de dominio si cayó
sobre un enlace o botón de verdad y hace menos de un segundo. Un clic sobre el
fondo de la página o sobre el reproductor no autoriza nada: ese clic es
precisamente el que secuestran las webs de descarga y streaming.

Matiz honesto: `location.assign/replace/href` son inparcheables desde script
([Unforgeable], verificado en Chrome real), así que la redirección lanzada por
el script de primer nivel de la página no se puede interceptar ahí. Esa vía se
cubre bloqueando en red los dominios de las redes de redirección (incluido
`main_frame`) y retirando los `<meta http-equiv="refresh">` hacia otro dominio.

### Muros de «desactiva tu bloqueador»

No es lo mismo que un muro de pago: aquí no se pide dinero ni una cuenta, sólo
tapan el contenido hasta que apagues el bloqueador. Se retira la capa (y su
fondo oscuro) y se devuelve el scroll. **No se pulsa ningún botón suyo** ni se
finge que el bloqueador no está.

El listón es alto a propósito, y así se comprueba en las pruebas: tiene que
mencionar bloqueadores de anuncios **y** pedirte que lo desactives, ser corto
(un aviso, no un artículo que hable del tema) y además estar tapando la página
o haber dejado el scroll bloqueado. Un muro de pago, un banner de cookies o un
artículo sobre adblockers no cumplen eso y no se tocan. Se puede apagar desde
el popup.

## Atajos de teclado

| Atajo | Qué hace |
|---|---|
| **Alt+Mayús+S** | Excluye —o reactiva— ShieldX en el sitio que estás viendo |
| **Alt+Mayús+X** | Entra en modo «señalar» para ocultar un elemento |

Se cambian en `chrome://extensions/shortcuts`, donde además puedes darle una
tecla a «volver a mostrar el aviso de cookies», que viene sin asignar.

## Tus ajustes

El popup exporta todo lo que has configurado —interruptores, sitios excluidos y
elementos que ocultaste a mano— a un fichero JSON, y lo vuelve a importar. Todo
pasa dentro del navegador: no hay servidor ninguno. Al importar sólo se aceptan
las claves conocidas y con el tipo correcto, así que un fichero manipulado no
puede colar nada raro en el almacenamiento.

La lista de sitios excluidos también se ve entera en el popup, con un botón para
reactivar cada uno; antes había que volver a visitar el sitio para quitarlo.

## Instalación

ShieldX no está en la Chrome Web Store: se instala como extensión
«descomprimida» desde una carpeta. Son dos minutos.

### 1. Descargar

Elige una de las dos:

- **ZIP** (sin instalar nada): en esta página de GitHub, botón verde **Code →
  Download ZIP**. Descomprímelo en una carpeta **fija**, por ejemplo
  `Documentos\ShieldX`. No la dejes en Descargas ni en el Escritorio si sueles
  limpiarlos: si la carpeta se borra o se mueve, la extensión deja de funcionar.
- **Git** (más cómodo para actualizar):

  ```
  git clone https://github.com/VortexJer/ShieldX.git
  ```

La carpeta correcta es la que tiene `manifest.json` dentro. Con el ZIP suele
quedar una carpeta dentro de otra (`ShieldX-main\ShieldX-main`): elige la de
dentro.

### 2. Cargar en el navegador

**Chrome**

1. Abre `chrome://extensions`.
2. Activa **Modo de desarrollador** (interruptor arriba a la derecha).
3. Pulsa **Cargar descomprimida** y selecciona la carpeta que tiene
   `manifest.json`.
4. Fija el icono: pieza de puzle de la barra → chincheta junto a ShieldX.

**Edge** — igual, en `edge://extensions`: activa **Modo de desarrollador**
(menú de la izquierda) y pulsa **Cargar desempaquetada**.

**Brave** — igual, en `brave://extensions`.

**Opera** — igual, en `opera://extensions`.

Firefox y Safari no están soportados (ShieldX usa APIs de Chrome Manifest V3).
Chrome para Android no admite extensiones.

### 3. Comprobar que funciona

1. Abre el popup: arriba debe salir la misma versión que en `manifest.json`.
2. **Recarga las pestañas que ya tenías abiertas**: las que se abrieron antes
   de instalar no tienen ShieldX dentro.
3. Prueba en YouTube o en una búsqueda de Google con anuncios.

### Actualizar

1. Trae la versión nueva: `git pull` dentro de la carpeta, o descarga el ZIP de
   nuevo y **reemplaza el contenido de la misma carpeta**.
2. En `chrome://extensions`, pulsa el botón de recargar (flecha circular) de
   ShieldX.
3. Recarga las pestañas abiertas, sobre todo YouTube.

Tus ajustes se conservan al actualizar. Si cambias de carpeta, pasan a ser
otra extensión: expórtalos antes desde el popup e impórtalos después.

### Problemas típicos

- **Cambio el código y no se nota nada.** Seguramente Chrome tiene cargada otra
  copia. En `chrome://extensions`, en la tarjeta de ShieldX, mira **Detalles →
  Cargada desde**: esa es la carpeta que manda. Edita esa o carga la buena.
- **Dos ShieldX en la lista.** Hay dos carpetas cargadas y las dos actúan a la
  vez. Quita una con **Quitar**.
- **«Desactiva las extensiones en modo de desarrollador».** Es un aviso normal
  de Chrome para las extensiones descomprimidas. Ciérralo; ShieldX sigue
  activo.
- **YouTube tarda en arrancar el vídeo.** Desde noviembre de 2026, YouTube
  impone una espera desde su servidor cuando no se ve el anuncio. Está
  explicado en [YouTube](#youtube).
- **Una web se rompe.** Pulsa **Este sitio** en el popup para excluirla, o
  `Alt+Shift+S`.

## Interruptores

- **ON/OFF** — pausa global; al pausar se restaura la página, no hace falta recargar.
- **Este sitio** — excluye el dominio actual, también a nivel de red.
- **Aviso de cookies · MOSTRAR** — devuelve a la página el banner que se ocultó,
  por si quieres responderlo.
- **Anuncios YouTube** · **Anti-redirección** · **Descargas vigiladas** — cada capa por separado.

## Qué NO hace

No se salta muros de pago de prensa ni ningún otro control de acceso a contenido
de pago. Bloquear anuncios y evadir una suscripción no son lo mismo.

Tampoco toca los resultados patrocinados de **Google Maps**. Sus fichas no usan
la estructura de los resultados de búsqueda, y para ocultarlas habría que
adivinar el contenedor: si se falla, desaparece la lista entera. Preferimos
dejar un par de hoteles patrocinados a riesgo de romperle el mapa a nadie.

Y al **pausar** se restaura lo que estaba oculto, pero no vuelve lo que se
eliminó del documento (scripts de redes publicitarias, imágenes de banner,
capas que robaban el clic). Para eso hace falta recargar.

## Pruebas

    node tests/run.js        # toda la batería: 346 comprobaciones, 13 ficheros

o cada una por separado:

    node tests/smoke.js            # dónde entra la capa de ocultado
    node tests/smoke_arranque.js   # arranque, document.write, pausar/reanudar
    node tests/smoke_hide.js       # qué se oculta y qué NO
    node tests/smoke_cookies.js    # banners, y lo que abres tú
    node tests/smoke_muros.js      # muros de «desactiva el bloqueador»
    node tests/smoke_guard.js      # qué ventanas se permiten
    node tests/smoke_picker.js     # el picker y sus tres salidas
    node tests/smoke_selector.js   # los selectores que genera el picker
    node tests/smoke_buscador.js   # resultados patrocinados y meta-refresh
    node tests/smoke_yt.js         # YouTube
    node tests/smoke_popup.js      # popup: interruptores, exportar/importar
    node tests/smoke_background.js # descargas, atajos, contadores, exclusión
    node tests/smoke_rules.js      # manifest y reglas de red

Sin dependencias: arrancan cada script con stubs mínimos del navegador y
comprueban la política de bloqueo. Los casos no salen de la imaginación: cada
uno es un fallo que apareció navegando de verdad. `smoke_guard.js` verifica que
un enlace normal —y un botón hecho con `<div>`, y otro dentro de un shadow
DOM— siguen funcionando y que un pop-under no; `smoke_hide.js`, que un aviso
de la propia web («tu pedido se ha guardado») no se toma por un anuncio;
`smoke_arranque.js`, que el vigilante del DOM se crea aunque algo falle en la
primera pasada.

## Privacidad

Sin servidores externos, sin `eval`, sin `web_accessible_resources`, sin
`webNavigation` y sin registro del historial. El permiso de descargas sólo se usa
para pausar, reanudar o cancelar; el de notificaciones, para preguntártelo. Los
contadores son locales.
