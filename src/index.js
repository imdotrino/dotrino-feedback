/**
 * @dotrino/feedback — Cloudflare Worker relay (solo email)
 *
 * Recibe envíos de formularios públicos del ecosistema (p. ej. el input
 * "Solicita o recomienda una aplicación" del home) y los reenvía por **email**
 * a EMAIL_TO (imdotrino@gmail.com) vía Resend.
 *
 * El home es estático (GitHub Pages): no puede guardar secretos ni mandar mail.
 * Este worker es la única pieza con credenciales. Es compartido: cualquier app
 * del ecosistema puede postear aquí.
 *
 * POST  application/json  { text, app?, locale?, contact? }
 *   text     (req) — lo que el usuario escribió. 1..2000 chars.
 *   app      (opc) — qué app originó el envío (default "home").
 *   locale   (opc) — "es" | "en".
 *   contact  (opc) — email/handle opcional de quien pide (para responderle).
 *
 * Respuesta: { ok: true } | { ok: false, error }.
 *
 * Vars (wrangler.toml [vars], no secretas):
 *   EMAIL_TO          "imdotrino@gmail.com"
 *   EMAIL_FROM        "Dotrino <requests@dotrino.com>"   (dominio verificado en Resend)
 *   ALLOWED_ORIGINS   "https://dotrino.com,https://*.dotrino.com"  (CSV; * = comodín de subdominio)
 * Secret:
 *   RESEND_API_KEY    (wrangler secret put RESEND_API_KEY)
 */

const MAX_TEXT = 2000

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || ''
    const cors = corsHeaders(origin, env)

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
    if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405, cors)

    // Solo aceptamos orígenes del ecosistema. OJO: CORS NO es barrera real
    // (un script puede falsear el header Origin) → el anti-spam de verdad es el
    // rate limit de abajo.
    if (origin && !originAllowed(origin, env)) {
      return json({ ok: false, error: 'origin_not_allowed' }, 403, cors)
    }

    // Rate limit por IP (anti-spam). Binding nativo de Cloudflare (ver
    // wrangler.toml). Si no está configurado, no rompe.
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown'
    if (env.RATE_LIMITER) {
      const { success } = await env.RATE_LIMITER.limit({ key: ip })
      if (!success) return json({ ok: false, error: 'rate_limited' }, 429, cors)
    }

    let body
    try { body = await request.json() } catch { return json({ ok: false, error: 'bad_json' }, 400, cors) }

    const text = String(body.text ?? '').trim()
    if (!text) return json({ ok: false, error: 'empty_text' }, 400, cors)
    if (text.length > MAX_TEXT) return json({ ok: false, error: 'text_too_long' }, 400, cors)

    const meta = {
      app: sanitize(String(body.app ?? 'home'), 40),
      locale: body.locale === 'en' ? 'en' : 'es',
      contact: sanitize(String(body.contact ?? ''), 120),
      country: request.cf?.country || '',
      // Identidad opcional del remitente (si tenía vault al enviar): para sumar
      // nickname + link de calificación + reviews existentes al email.
      pubkey: String(body.pubkey ?? '').trim().slice(0, 4000),
      nickname: sanitize(String(body.nickname ?? ''), 80),
    }

    try {
      await sendEmail(env, text, meta)
    } catch (e) {
      return json({ ok: false, error: String(e?.message || e) }, 502, cors)
    }
    return json({ ok: true }, 200, cors)
  },
}

/* ───────────────────────── email (Resend) ───────────────────────── */

async function sendEmail(env, text, meta) {
  if (!env.RESEND_API_KEY || !env.EMAIL_TO || !env.EMAIL_FROM) throw new Error('not_configured')
  const subject = `[Dotrino] App request${meta.nickname ? ' de ' + meta.nickname : ''}: ${oneLine(text, 50)}`
  const sender = await senderBlock(meta)
  const html =
    `<p style="white-space:pre-wrap">${escapeHtml(text)}</p>` +
    sender +
    `<hr><p style="color:#666;font-size:13px">app: ${escapeHtml(meta.app)} · ${meta.locale}` +
    `${meta.country ? ' · ' + escapeHtml(meta.country) : ''}` +
    `${meta.contact ? '<br>contacto: ' + escapeHtml(meta.contact) : ''}</p>`
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: [env.EMAIL_TO],
      ...(meta.contact && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(meta.contact) ? { reply_to: meta.contact } : {}),
      subject,
      html,
    }),
  })
  if (!res.ok) throw new Error(`email_${res.status}`)
  return { sent: true }
}

/* ───────────────────────── remitente + reviews ───────────────────────── */

// Bloque del remitente en el email: nickname + link para ver/calificar su perfil
// (profile.dotrino.com) + sus reviews actuales del registro de reputación.
async function senderBlock(meta) {
  if (!meta.pubkey && !meta.nickname) return ''
  let html = '<hr><p style="font-size:14px"><strong>Remitente</strong>'
  if (meta.nickname) html += `<br>Nickname: ${escapeHtml(meta.nickname)}`
  if (meta.pubkey) {
    const link = `https://profile.dotrino.com/#${b64url(meta.pubkey)}`
    html += `<br><a href="${link}">Ver / calificar su perfil →</a>`
  }
  html += '</p>'
  if (meta.pubkey) html += await fetchReviews(meta.pubkey)
  return html
}

// Lee las atestaciones públicas sobre el sujeto (GET reputation.dotrino.com).
async function fetchReviews(pubkey) {
  try {
    const res = await fetch(`https://reputation.dotrino.com/ratings?subject=${encodeURIComponent(pubkey)}`)
    if (!res.ok) return ''
    const data = await res.json()
    const att = Array.isArray(data && data.attestations) ? data.attestations : []
    if (!att.length) return '<p style="font-size:13px;color:#666">Sin reviews todavía.</p>'
    const rows = att.slice(0, 10).map((a) => {
      const conf = (a.indicators && a.indicators.confianza != null) ? a.indicators.confianza : a.rating
      const af = a.indicators && a.indicators.afinidad
      const parts = []
      if (conf != null) parts.push(`confianza ${conf}/5`)
      if (af != null) parts.push(`afinidad ${af}/5`)
      const notes = a.notes ? ` — "${escapeHtml(String(a.notes).slice(0, 160))}"` : ''
      return `<li>${parts.join(', ') || 'sin puntaje'}${notes}</li>`
    }).join('')
    return `<p style="font-size:14px"><strong>Reviews (${att.length})</strong></p><ul style="font-size:13px;color:#444">${rows}</ul>`
  } catch {
    return ''
  }
}

// base64url UTF-8-safe (inverso del decode de la página dotrino_profile).
function b64url(s) {
  const bytes = new TextEncoder().encode(s)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/* ───────────────────────── helpers ───────────────────────── */

function corsHeaders(origin, env) {
  const allow = origin && originAllowed(origin, env) ? origin : firstOrigin(env)
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
}

function originList(env) {
  return (env.ALLOWED_ORIGINS || 'https://dotrino.com,https://*.dotrino.com')
    .split(',').map((s) => s.trim()).filter(Boolean)
}
function firstOrigin(env) { return originList(env)[0] || 'https://dotrino.com' }

function originAllowed(origin, env) {
  return originList(env).some((pat) => {
    if (pat === origin) return true
    if (pat.includes('*')) {
      const re = new RegExp('^' + pat.replace(/\./g, '\\.').replace(/\*/g, '[^.]+') + '$')
      return re.test(origin)
    }
    return false
  })
}

const json = (obj, status, headers) =>
  new Response(JSON.stringify(obj), { status, headers: { ...headers, 'Content-Type': 'application/json' } })

const SANITIZE_RE = new RegExp('[\\u0000-\\u001f\\u007f]', 'g')
const sanitize = (s, max) => s.replace(SANITIZE_RE, '').trim().slice(0, max)
const oneLine = (s, max) => s.replace(/\s+/g, ' ').trim().slice(0, max)
const escapeHtml = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
