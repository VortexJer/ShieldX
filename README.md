# ShieldX

Bloqueador de anuncios, rastreadores y banners de cookies para Chrome (Manifest V3).

## Qué bloquea

| Capa | Fichero | Cometido |
|---|---|---|
| Red | `rules/ads.json` | 310 reglas `declarativeNetRequest` estáticas contra dominios de anuncios y telemetría |
| DOM | `content.js` | Oculta contenedores publicitarios, elimina scripts de redes de anuncios y rechaza banners de cookies |
| YouTube | `youtube.js` | Oculta renderers de anuncio, pulsa «Saltar» y acelera los anuncios no salteables |
| UI | `popup.html` · `popup.js` · `background.js` | Interruptores, lista de sitios excluidos y contadores |

## Instalación

1. `chrome://extensions` → activar **Modo desarrollador**.
2. **Cargar descomprimida** → seleccionar esta carpeta.

## Uso

- **ON/OFF** — pausa global.
- **Anuncios YouTube** — desactiva sólo la capa de YouTube.
- **Este sitio** — excluye el dominio actual; ShieldX deja de actuar ahí (también a nivel de red) y se recuerda entre sesiones.

## Privacidad

Sin servidores externos, sin `eval`, sin `web_accessible_resources` y sin almacenamiento del historial de navegación. Los contadores son locales.
