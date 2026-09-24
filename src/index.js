import { verifyDeviceSig } from '@dotrino/identity/capabilities'

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

import { myIndicators, pubkeyId } from '@dotrino/reputation'
import { MAX_ATTACHMENT_BYTES, readMetaHeader, sanitizeFilename, readBase64 } from './attachment.js'

const MAX_TEXT = 2000
// Lo que puede tener de viejo una solicitud firmada. La firma cubre `ts`, así que esto es lo
// que impide reenviar hoy una solicitud firmada de otro día.
export const MAX_SKEW_MS = 10 * 60 * 1000



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

    const withFile = (request.headers.get('Content-Type') || '').startsWith('application/octet-stream')
    let body
    let attachment = null
    if (withFile) {
      try { body = readMetaHeader(request.headers.get('X-Dotrino-Feedback')) } catch { return json({ ok: false, error: 'bad_meta' }, 400, cors) }
      const filename = sanitizeFilename(String(body.filename ?? ''))
      if (!filename) return json({ ok: false, error: 'bad_filename' }, 400, cors)
      const size = Number(request.headers.get('Content-Length'))
      if (!Number.isInteger(size) || size <= 0) return json({ ok: false, error: 'length_required' }, 411, cors)
      if (size > MAX_ATTACHMENT_BYTES) return json({ ok: false, error: 'attachment_too_large', max: MAX_ATTACHMENT_BYTES }, 413, cors)
      attachment = { filename, size }
    } else {
      try { body = await request.json() } catch { return json({ ok: false, error: 'bad_json' }, 400, cors) }
    }

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
      // Firma del contenido por el remitente (vault, ECDSA P-256) → validable.
      ts: Number(body.ts) || 0,
      signature: String(body.signature ?? '').trim().slice(0, 1000),
    }

    // LA FIRMA ES OBLIGATORIA (dueño, 2026-09-24: «el app request debe enviar la firma de
    // Dotrino»). Antes era opcional y llegaban correos sin firma que nadie podía atribuir.
    // Se comprueba ANTES de leer un adjunto: a quien no firma no se le leen 5 MB.
    if (!meta.pubkey || !meta.signature) return json({ ok: false, error: 'unsigned_request' }, 401, cors)
    if (!meta.ts || Math.abs(Date.now() - meta.ts) > MAX_SKEW_MS) return json({ ok: false, error: 'stale_request' }, 401, cors)
    meta.verified = await verifyContentSig(meta.pubkey, text, meta.ts, meta.signature)
    if (!meta.verified) return json({ ok: false, error: 'bad_signature' }, 401, cors)

    if (attachment) {
      try {
        attachment.base64 = await readBase64(request.body, attachment.size)
      } catch (e) {
        if (e.code === 'attachment_too_large') return json({ ok: false, error: e.code, max: MAX_ATTACHMENT_BYTES }, 413, cors)
        if (e.code === 'attachment_length_mismatch') return json({ ok: false, error: e.code }, 400, cors)
        throw e
      }
    }

    try {
      await sendEmail(env, text, meta, attachment)
    } catch (e) {
      return json({ ok: false, error: String(e?.message || e) }, 502, cors)
    }
    return json({ ok: true }, 200, cors)
  },
}

/* ───────────────────────── email (Resend) ───────────────────────── */

async function sendEmail(env, text, meta, attachment = null) {
  if (!env.RESEND_API_KEY || !env.EMAIL_TO || !env.EMAIL_FROM) throw new Error('not_configured')
  const subject = `[Dotrino] App request${meta.nickname ? ' de ' + meta.nickname : ''}: ${oneLine(text, 50)}` +
    (attachment ? ` (adjunto: ${attachment.filename})` : '')
  const sender = await senderBlock(text, meta)
  const html =
    `<p style="white-space:pre-wrap">${escapeHtml(text)}</p>` +
    sender +
    `<hr><p style="color:#666;font-size:13px">app: ${escapeHtml(meta.app)} · ${meta.locale}` +
    `${meta.country ? ' · ' + escapeHtml(meta.country) : ''}` +
    `${meta.contact ? '<br>contacto: ' + escapeHtml(meta.contact) : ''}</p>`
  const base = JSON.stringify({
    from: env.EMAIL_FROM,
    to: [env.EMAIL_TO],
    ...(meta.contact && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(meta.contact) ? { reply_to: meta.contact } : {}),
    subject,
    html,
  })
  // El base64 del adjunto se pega tal cual: solo trae [A-Za-z0-9+/=], que no hay que escapar
  // en JSON, y así no se serializa otra vez un texto de megas.
  const body = attachment
    ? base.slice(0, -1) + `,"attachments":[{"filename":${JSON.stringify(attachment.filename)},"content":"` + attachment.base64 + '"}]}'
    : base
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body,
  })
  if (!res.ok) throw new Error(`email_${res.status}`)
  return { sent: true }
}

/* ───────────────────────── remitente + reviews ───────────────────────── */

// Bloque del remitente en el email: nickname + link para ver/calificar su perfil
// (profile.dotrino.com) + sus reviews actuales del registro de reputación.
async function senderBlock(text, meta) {
  // Aquí solo llega lo que ya se verificó (ver el `fetch`): siempre hay remitente y firma.
  let html = '<hr><p style="font-size:14px"><strong>Remitente</strong>'
  if (meta.nickname) html += `<br>Nickname: ${escapeHtml(meta.nickname)}`
  html += '<br><span style="color:#1a7a3a;font-weight:600">✓ Firmada con la identidad de Dotrino (firma válida)</span>'
  html += '</p>'
  html += await fetchReviews(meta.pubkey)
  // UN solo link: el modo #v= valida la firma + muestra el perfil/reputación (con el
  // nickname) + permite calificar, todo en un paso. Verificación client-side.
  const payload = { op: 'app-request', text, ts: meta.ts, pubkey: meta.pubkey, nickname: meta.nickname, signature: meta.signature }
  html += `<p style="font-size:13px"><a href="https://profile.dotrino.com/#v=${b64url(JSON.stringify(payload))}"><strong>Ver perfil, validar firma y calificar →</strong></a></p>`
  return html
}

// Lee las atestaciones públicas sobre el sujeto (GET rep.dotrino.com, el backend
// del registro: `reputation.dotrino.com` es el frontend desde el rename y da 404).
async function fetchReviews(pubkey) {
  try {
    const res = await fetch(`https://rep.dotrino.com/ratings?subject=${encodeURIComponent(pubkey)}`)
    if (!res.ok) return ''
    const data = await res.json()
    const att = Array.isArray(data && data.attestations) ? data.attestations : []
    if (!att.length) return '<p style="font-size:13px;color:#666">Sin reviews todavía.</p>'
    // El registro guarda UNA atestación por eje, así que hay que agrupar por
    // emisor: si no, quien califica 3 ejes sale como 3 filas y el conteo miente.
    const byIssuer = new Map()
    for (const a of att) {
      if (!a || typeof a.issuer !== 'string') continue
      const id = pubkeyId(a.issuer)
      const r = byIssuer.get(id) || { issuer: a.issuer, notes: '' }
      if (a.notes && !r.notes) r.notes = String(a.notes)
      byIssuer.set(id, r)
    }
    const reviewers = [...byIssuer.values()]
    const rows = reviewers.slice(0, 10).map((r) => {
      const ind = myIndicators(att, r.issuer)   // fusiona los ejes de ESE emisor
      const parts = []
      for (const [key, label] of [['confianza', 'confianza'], ['afinidad', 'afinidad'], ['conoce', 'conocimiento']]) {
        if (typeof ind[key] === 'number') parts.push(`${label} ${ind[key]}/5`)
      }
      const notes = r.notes ? ` — "${escapeHtml(r.notes.slice(0, 160))}"` : ''
      return `<li>${parts.join(', ') || 'sin puntaje'}${notes}</li>`
    }).join('')
    return `<p style="font-size:14px"><strong>Reviews (${reviewers.length})</strong></p><ul style="font-size:13px;color:#444">${rows}</ul>`
  } catch {
    return ''
  }
}

// base64url UTF-8-safe (inverso del decode de la página dotrino-profile-app).
function b64url(s) {
  const bytes = new TextEncoder().encode(s)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Verifica la firma del contenido (ECDSA P-256 + SHA-256 sobre el canónico de
 * `{op:'app-request', text, ts}`, firma base64 de r||s — el formato del vault).
 *
 * La comprobación es del pilar (`verifyDeviceSig` de `@dotrino/identity`), no
 * nuestra: antes esto era una copia a mano de `canonicalStringify` más un
 * `crypto.subtle.verify` suelto, y dos implementaciones de la misma firma se
 * separan en cuanto una de las dos cambia. El subpath `/capabilities` solo
 * arrastra `core.js` y `keyid.js`, así que el Worker no crece.
 */
async function verifyContentSig(pubkeyStr, text, ts, sigB64) {
  try {
    return await verifyDeviceSig({
      publickey: pubkeyStr,
      data: { op: 'app-request', text, ts },
      signature: sigB64,
    })
  } catch {
    return false
  }
}

/* ───────────────────────── helpers ───────────────────────── */

function corsHeaders(origin, env) {
  const allow = origin && originAllowed(origin, env) ? origin : firstOrigin(env)
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Dotrino-Feedback',
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
