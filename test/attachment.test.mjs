// El envío con adjunto, contra un Resend falso: lo que importa es qué JSON le llega.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import worker from '../src/index.js'
import { MAX_ATTACHMENT_BYTES, readMetaHeader, sanitizeFilename } from '../src/attachment.js'
import { makeDeviceKey, signWithDevice } from '@dotrino/identity/capabilities'

// Desde 2026-09-24 toda solicitud va FIRMADA con la identidad de Dotrino: el arnés firma.
const yo = await makeDeviceKey()
async function signed (meta, { ts = Date.now(), key = yo } = {}) {
  const { signature } = await signWithDevice({ privateJwk: key.privateJwk, data: { op: 'app-request', text: meta.text, ts } })
  return { ...meta, pubkey: yo.publickey, nickname: 'yo', ts, signature }
}

const env = { RESEND_API_KEY: 'k', EMAIL_TO: 'to@example.com', EMAIL_FROM: 'Dotrino <from@example.com>', ALLOWED_ORIGINS: 'https://dotrino.com,https://*.dotrino.com' }
const ORIGIN = 'https://facturero.dotrino.com'

function captureResend () {
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: init.body })
    return new Response('{"id":"x"}', { status: 200 })
  }
  return calls
}

const b64url = (s) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

function fileRequest (bytes, meta, { length = bytes.length, chunks = 3 } = {}) {
  const size = Math.ceil(bytes.length / chunks)
  const body = new ReadableStream({
    start (c) {
      for (let i = 0; i < bytes.length; i += size) c.enqueue(bytes.subarray(i, i + size))
      c.close()
    },
  })
  return new Request('https://feedback.dotrino.com/', {
    method: 'POST',
    headers: {
      Origin: ORIGIN,
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(length),
      'X-Dotrino-Feedback': b64url(JSON.stringify(meta)),
    },
    body,
    duplex: 'half',
  })
}

test('text only: unchanged', async () => {
  const calls = captureResend()
  const res = await worker.fetch(new Request('https://feedback.dotrino.com/', {
    method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify(await signed({ text: 'hola', app: 'home', contact: 'a@example.com' })),
  }), env)
  assert.equal(res.status, 200)
  const sent = JSON.parse(calls[0].body)
  assert.equal(sent.reply_to, 'a@example.com')
  assert.equal(sent.attachments, undefined)
})

test('with a file: the attachment reaches Resend byte for byte, whatever the chunking', async () => {
  for (const size of [1, 2, 3, 4, 65537, 1024 * 1024 + 1]) {
    for (const chunks of [1, 3, 7]) {
      const calls = captureResend()
      const bytes = new Uint8Array(randomBytes(size))
      const res = await worker.fetch(fileRequest(bytes, await signed({ text: 'Necesito un importador de Contifico', app: 'facturero', contact: 'yo@example.com', filename: 'clientes "Q1".xlsx' }), { chunks }), env)
      assert.equal(res.status, 200, `size ${size} chunks ${chunks}`)
      const sent = JSON.parse(calls[0].body)
      assert.equal(sent.attachments.length, 1)
      assert.equal(sent.attachments[0].filename, 'clientes _Q1_.xlsx')
      assert.deepEqual(new Uint8Array(Buffer.from(sent.attachments[0].content, 'base64')), bytes)
      assert.match(sent.subject, /adjunto: clientes _Q1_\.xlsx/)
      assert.equal(sent.reply_to, 'yo@example.com')
    }
  }
})

test('limits and types are enforced before sending anything', async () => {
  const calls = captureResend()
  // Firmada: lo que se prueba aquí son los límites del adjunto, que van después de la firma.
  const meta = await signed({ text: 'x', app: 'facturero', filename: 'a.xls' })
  let res = await worker.fetch(fileRequest(new Uint8Array(10), meta, { length: MAX_ATTACHMENT_BYTES + 1 }), env)
  assert.equal(res.status, 413)
  res = await worker.fetch(fileRequest(new Uint8Array(10), { ...meta, filename: 'programa.exe' }), env)
  assert.equal(res.status, 400)
  assert.equal((await res.json()).error, 'bad_filename')
  res = await worker.fetch(fileRequest(new Uint8Array(10), meta, { length: 9 }), env)
  assert.equal(res.status, 400)
  assert.equal((await res.json()).error, 'attachment_length_mismatch')
  // Content-Length miente a la baja: el tope se aplica a lo que llega de verdad.
  res = await worker.fetch(fileRequest(new Uint8Array(MAX_ATTACHMENT_BYTES + 10), meta, { length: 100 }), env)
  assert.equal(res.status, 413)
  res = await worker.fetch(fileRequest(new Uint8Array(10), { ...meta, text: '' }), env)
  assert.equal(res.status, 400)
  assert.equal(calls.length, 0)
})

test('meta header and file names', () => {
  assert.deepEqual(readMetaHeader(b64url(JSON.stringify({ text: 'ñandú' }))), { text: 'ñandú' })
  assert.throws(() => readMetaHeader('x'.repeat(20000)))
  assert.equal(sanitizeFilename('../../etc/passwd'), '')
  assert.equal(sanitizeFilename('Reporte de clientes.XLS'), 'Reporte de clientes.XLS')
})


/* LA FIRMA ES OBLIGATORIA (2026-09-24): lo que no viene firmado con la identidad de Dotrino no
   se manda, y el que envía sabe por qué (el home lo dice en pantalla). */
const jsonReq = (body) => new Request('https://feedback.dotrino.com/', {
  method: 'POST', headers: { Origin: 'https://dotrino.com', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})

test('sin firma no se envía nada', async () => {
  const calls = captureResend()
  const res = await worker.fetch(jsonReq({ text: 'nfbuxq', app: 'home' }), env)
  assert.equal(res.status, 401)
  assert.equal((await res.json()).error, 'unsigned_request')
  assert.equal(calls.length, 0)
})

test('una firma que no es de esa llave, tampoco', async () => {
  const calls = captureResend()
  const otro = await makeDeviceKey()
  const res = await worker.fetch(jsonReq(await signed({ text: 'hola', app: 'home' }, { key: otro })), env)
  assert.equal(res.status, 401)
  assert.equal((await res.json()).error, 'bad_signature')
  assert.equal(calls.length, 0)
})

test('ni un texto cambiado después de firmar', async () => {
  const calls = captureResend()
  const firmado = await signed({ text: 'hola', app: 'home' })
  const res = await worker.fetch(jsonReq({ ...firmado, text: 'otra cosa' }), env)
  assert.equal((await res.json()).error, 'bad_signature')
  assert.equal(calls.length, 0)
})

test('una solicitud firmada de hace rato no se puede reenviar', async () => {
  const calls = captureResend()
  const res = await worker.fetch(jsonReq(await signed({ text: 'hola', app: 'home' }, { ts: Date.now() - 60 * 60 * 1000 })), env)
  assert.equal((await res.json()).error, 'stale_request')
  assert.equal(calls.length, 0)
})

test('un adjunto sin firma se rechaza sin leerlo', async () => {
  const calls = captureResend()
  const res = await worker.fetch(fileRequest(new Uint8Array(1024), { text: 'x', app: 'facturero', filename: 'a.xlsx' }), env)
  assert.equal(res.status, 401)
  assert.equal(calls.length, 0)
})

test('lo firmado llega con la marca de firma válida', async () => {
  const calls = captureResend()
  const res = await worker.fetch(jsonReq(await signed({ text: 'una app de notas', app: 'home' })), env)
  assert.equal(res.status, 200)
  assert.match(JSON.parse(calls[0].body).html, /Firmada con la identidad de Dotrino/)
})
