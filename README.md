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
| YouTube | `youtube.js` | Poda las claves de anuncio de los datos del reproductor (incluido `get_watch`, el endpoint SPA actual), oculta los renderers, pulsa «Saltar» y acelera los no salteables |
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

## Instalación

1. `chrome://extensions` → activar **Modo desarrollador**.
2. **Cargar descomprimida** → seleccionar esta carpeta.

## Interruptores

- **ON/OFF** — pausa global; al pausar se restaura la página, no hace falta recargar.
- **Este sitio** — excluye el dominio actual, también a nivel de red.
- **Aviso de cookies · MOSTRAR** — devuelve a la página el banner que se ocultó,
  por si quieres responderlo.
- **Anuncios YouTube** · **Anti-redirección** · **Descargas vigiladas** — cada capa por separado.

## Qué NO hace

No se salta muros de pago de prensa ni ningún otro control de acceso a contenido
de pago. Bloquear anuncios y evadir una suscripción no son lo mismo.

## Pruebas

    node tests/run.js        # toda la batería: 227 comprobaciones, 9 ficheros

o cada una por separado:

    node tests/smoke.js            # dónde entra la capa de ocultado
    node tests/smoke_arranque.js   # el observer se crea pase lo que pase
    node tests/smoke_hide.js       # qué se oculta y qué NO
    node tests/smoke_cookies.js    # banners, y lo que abres tú
    node tests/smoke_guard.js      # qué ventanas se permiten
    node tests/smoke_picker.js     # el picker y sus tres salidas
    node tests/smoke_yt.js         # YouTube
    node tests/smoke_background.js # descargas, contadores, exclusión
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
