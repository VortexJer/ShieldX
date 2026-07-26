# ShieldX

Bloqueador de anuncios, rastreadores, banners de cookies y redirecciones forzadas
para Chrome (Manifest V3).

## Qué hace

| Capa | Fichero | Cometido |
|---|---|---|
| Red | `rules/ads.json` | 310 reglas `declarativeNetRequest` contra dominios de anuncios y telemetría |
| Red | `rules/redirect.json` | 55 reglas contra redes de pop-under y redirección (PopAds, PropellerAds, ExoClick, Adsterra…), incluida la navegación principal |
| DOM | `content.js` | Oculta contenedores publicitarios, retira scripts de redes de anuncios, oculta banners de cookies (sin pulsar nada en nombre del usuario) y elimina las capas transparentes que roban el primer clic |
| Página | `guard.js` | Bloquea `window.open` y los saltos a otro dominio que no haya pedido el usuario |
| YouTube | `youtube.js` | Poda las claves de anuncio de los datos del reproductor (incluido `get_watch`, el endpoint SPA actual), oculta los renderers, pulsa «Saltar» y acelera los no salteables |
| Descargas | `background.js` | Pausa y pregunta cuando un fichero empieza a descargarse sin que lo hayas pedido |
| UI | `popup.html` · `popup.js` | Interruptores, exclusión por sitio y contadores |

### Resultados patrocinados

Los buscadores rotan las clases de sus anuncios y cambian dónde los colocan
(Google ya no usa `#tads`: los intercala entre los resultados orgánicos). Por eso
no se detectan por clase sino por **la etiqueta visible** —«Resultados
patrocinados», «Sponsored», «Anuncio»—, que es lo único que no pueden quitar.

### Clientes de correo

En Gmail, Outlook, Proton y cualquier host tipo `mail.*` o `webmail.*`, la capa
de ocultado **no entra nunca**. El cuerpo de un correo es HTML ajeno y
arbitrario: puede traer cualquier nombre de clase o cualquier imagen con
«banner» en la ruta, y ocultarlo significa esconderle correo al usuario. El
anti-redirección, las descargas vigiladas y la capa de red siguen funcionando
ahí con normalidad.

### YouTube

Tres capas, medidas contra el YouTube real:

1. **Poda de datos**: las claves de anuncio (`adPlacements`, `adSlots`,
   `playerAds`) se borran del JSON del reproductor antes de que lo consuma —
   tanto en `ytInitialPlayerResponse` (primer vídeo) como en las respuestas
   `fetch` de la navegación SPA, que hoy van por `/youtubei/v1/get_watch`, no
   por `/player`. La poda es profunda (las claves se buscan en todo el árbol,
   ~1,4 ms) y **jamás bloquea la petición**: ante cualquier error se entrega la
   respuesta original. `/player/ad_break` se deja pasar a propósito.
2. **Salto activo**: si aun así entra un anuncio (p. ej. cosido en el stream),
   se pulsa «Saltar» en cuanto existe y mientras tanto se silencia y acelera.
   La detección de anuncio usa **solo** la clase del `#movie_player`
   (`ad-showing`): detectar por los nodos `.ytp-ad-*` se queda pegado, porque
   persisten ocultos al terminar el anuncio.
3. **Cosmética**: los renderers de anuncio del feed y la búsqueda se eliminan
   del DOM y se cubren por CSS.

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

## Instalación

1. `chrome://extensions` → activar **Modo desarrollador**.
2. **Cargar descomprimida** → seleccionar esta carpeta.

## Interruptores

- **ON/OFF** — pausa global; al pausar se restaura la página, no hace falta recargar.
- **Este sitio** — excluye el dominio actual, también a nivel de red.
- **Anuncios YouTube** · **Anti-redirección** · **Descargas vigiladas** — cada capa por separado.

## Qué NO hace

No se salta muros de pago de prensa ni ningún otro control de acceso a contenido
de pago. Bloquear anuncios y evadir una suscripción no son lo mismo.

## Pruebas

    node tests/smoke.js
    node tests/smoke_yt.js
    node tests/smoke_guard.js

Sin dependencias: arrancan cada script con stubs mínimos del navegador y
comprueban la política de bloqueo. `smoke_guard.js` verifica en concreto que un
enlace normal sigue funcionando y que un pop-under no.

## Privacidad

Sin servidores externos, sin `eval`, sin `web_accessible_resources`, sin
`webNavigation` y sin registro del historial. El permiso de descargas sólo se usa
para pausar, reanudar o cancelar; el de notificaciones, para preguntártelo. Los
contadores son locales.
