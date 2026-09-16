// Envío con adjunto: ver el comentario de abajo. Va en su propio módulo porque el módulo de
// entrada de un Worker solo puede exportar manejadores.

import { Buffer } from 'node:buffer'

/*
 * ADJUNTO (opcional). Para pedir, p. ej., un importador y mandar un archivo de muestra.
 *
 *   POST /  Content-Type: application/octet-stream
 *           X-Dotrino-Feedback: base64url(JSON { text, app, locale, contact, pubkey,
 *                                                nickname, ts, signature, filename })
 *           cuerpo: los bytes del archivo, tal cual
 *
 * El archivo NO viaja dentro de un JSON a propósito: en el plan gratuito un Worker tiene
 * 10 ms de CPU por petición, y leer y volver a escribir un JSON con 1 MB de base64 ya
 * gasta unos 7 ms (medido). Aquí el cuerpo se lee por tramos, se pasa a base64 con el
 * Buffer nativo (décimas de ms por MB) y se pega al JSON de Resend sin interpretarlo.
 *
 * Límites: 5 MB de archivo (Resend admite 40 MB por correo ya en base64; Cloudflare,
 * 100 MB de cuerpo) y solo tipos de documento.
 */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024
export const ATTACHMENT_EXTENSIONS = ['xls', 'xlsx', 'xlsm', 'ods', 'csv', 'txt', 'xml', 'json', 'pdf', 'zip']
const MAX_META_HEADER = 12000

/** Los datos del envío con adjunto viajan en una cabecera, en base64url de un JSON. */
export function readMetaHeader(value) {
  if (!value || value.length > MAX_META_HEADER) throw new Error('bad_meta')
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
  const meta = JSON.parse(new TextDecoder().decode(bytes))
  if (!meta || typeof meta !== 'object') throw new Error('bad_meta')
  return meta
}

export function sanitizeFilename(name) {
  const clean = name.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_').trim().slice(0, 120)
  const ext = clean.includes('.') ? clean.split('.').pop().toLowerCase() : ''
  return clean && ATTACHMENT_EXTENSIONS.includes(ext) ? clean : ''
}

/**
 * Lee el cuerpo por tramos y lo devuelve en base64. Para en cuanto pasa del tope (no se
 * fía solo de Content-Length) y comprueba que llegó exactamente lo anunciado.
 */
export async function readBase64(stream, expected) {
  if (!stream) throw Object.assign(new Error('empty body'), { code: 'attachment_length_mismatch' })
  const reader = stream.getReader()
  const parts = []
  let carry = new Uint8Array(0)
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > MAX_ATTACHMENT_BYTES) {
      await reader.cancel()
      throw Object.assign(new Error('attachment too large'), { code: 'attachment_too_large' })
    }
    const joined = new Uint8Array(carry.length + value.length)
    joined.set(carry)
    joined.set(value, carry.length)
    // Se codifican múltiplos de 3 bytes: así los trozos de base64 se pegan sin relleno en medio.
    const whole = joined.length - (joined.length % 3)
    parts.push(Buffer.from(joined.buffer, joined.byteOffset, whole).toString('base64'))
    carry = joined.slice(whole)
  }
  if (carry.length) parts.push(Buffer.from(carry).toString('base64'))
  if (total !== expected) throw Object.assign(new Error('length mismatch'), { code: 'attachment_length_mismatch' })
  return parts.join('')
}
