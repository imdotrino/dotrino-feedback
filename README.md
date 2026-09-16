# @dotrino/feedback

> **Parte del ecosistema [Dotrino](https://dotrino.com).** Dotrino es un ecosistema de aplicaciones centradas en la privacidad de los datos: tu información es tuya, y las decisiones sobre ella también — qué compartes, con quién, cuándo y por qué. Sin anuncios, sin cookies, sin rastreo de datos, sin vender tu identidad a nadie.

Relay del ecosistema Dotrino en **Cloudflare Workers**. Recibe envíos de
formularios públicos (p. ej. el input *"Solicita o recomienda una aplicación"*
del home) y los reenvía por **email** a `imdotrino@gmail.com` (vía Resend).

El home es estático (GitHub Pages) y no puede guardar secretos ni mandar mail:
este worker es la **única** pieza con credenciales, y es **compartido**
(cualquier app del ecosistema puede postear aquí).

> Solo email. (El relay se diseñó para poder sumar más canales —GitHub issue,
> Discord— pero por decisión del proyecto el request de apps llega **solo al
> mail**.)

## API

```
POST /  (Content-Type: application/json)
{ "text": "...", "app": "home", "locale": "es", "contact": "opcional@mail" }
→ 200 { "ok": true }
```

`text` 1..2000 chars (requerido). Solo acepta `Origin` de `ALLOWED_ORIGINS`.

### Con un archivo adjunto

Para pedir algo mandando un archivo de muestra (lo usa Facturero para «¿Necesitas otro
importador?»):

```
POST /  Content-Type: application/octet-stream
        X-Dotrino-Feedback: base64url(JSON { text, app, locale, contact, pubkey, nickname, ts, signature, filename })
        cuerpo: los bytes del archivo
→ 200 { "ok": true } · 413 attachment_too_large · 400 bad_filename | bad_meta | attachment_length_mismatch
```

- **Tope: 5 MB**. Resend admite 40 MB por correo, ya en base64, y Cloudflare 100 MB de
  cuerpo.
- **Extensiones admitidas:** `xls xlsx xlsm ods csv txt xml json pdf zip`.
- **Por qué el archivo no va dentro de un JSON:** en el plan gratuito un Worker tiene
  **10 ms de CPU** por petición, y leer y volver a escribir un JSON con 1 MB de base64 ya
  gasta unos 7 ms (medido).
- **Cómo se lee:** el cuerpo entra por tramos, pasa a base64 con el `Buffer` nativo
  (`nodejs_compat`, unos 0,3 ms por MB) y se pega al JSON de Resend sin interpretarlo.
- **Los helpers** viven en `src/attachment.js` y no en `src/index.js`: el módulo de entrada
  de un Worker solo puede exportar manejadores, y workerd no arranca si exporta otra cosa.
- **Pruebas:** `npm test` (contra un Resend falso).

## Deploy (lo corre el dueño de la cuenta Cloudflare)

```bash
cd dotrino-feedback
npm install
npx wrangler login                       # auth interactiva (abrir en ! si hace falta)
npx wrangler secret put RESEND_API_KEY   # API key de resend.com (dominio dotrino.com verificado)
npx wrangler deploy
```

Tras el deploy queda en `https://dotrino-feedback.<subdominio>.workers.dev`.
- O el home lo consume con `VITE_FEEDBACK_URL=<esa url>` en build,
- o se mapea `feedback.dotrino.com` como custom domain (descomentar `routes` en
  `wrangler.toml`) y el home lo usa por default.

## Secreto

- **RESEND_API_KEY** — resend.com → verificar el dominio `dotrino.com` (agregar
  los registros DKIM/SPF en Cloudflare DNS) → API Keys → crear. El `EMAIL_FROM`
  (`requests@dotrino.com`) debe ser de ese dominio verificado.
