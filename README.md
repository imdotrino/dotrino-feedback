# @dotrino/feedback

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
