// El envío con adjunto, contra un Resend falso: lo que importa es qué JSON le llega.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import worker from '../src/index.js'
import { MAX_ATTACHMENT_BYTES, readMetaHeader, sanitizeFilename } from '../src/attachment.js'

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
    body: JSON.stringify({ text: 'hola', app: 'home', contact: 'a@example.com' }),
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
      const res = await worker.fetch(fileRequest(bytes, { text: 'Necesito un importador de Contifico', app: 'facturero', contact: 'yo@example.com', filename: 'clientes "Q1".xlsx' }, { chunks }), env)
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
  const meta = { text: 'x', app: 'facturero', filename: 'a.xls' }
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
  res = await worker.fetch(fileRequest(new Uint8Array(10), { app: 'facturero', filename: 'a.xls' }), env)
  assert.equal(res.status, 400)
  assert.equal(calls.length, 0)
})

test('meta header and file names', () => {
  assert.deepEqual(readMetaHeader(b64url(JSON.stringify({ text: 'ñandú' }))), { text: 'ñandú' })
  assert.throws(() => readMetaHeader('x'.repeat(20000)))
  assert.equal(sanitizeFilename('../../etc/passwd'), '')
  assert.equal(sanitizeFilename('Reporte de clientes.XLS'), 'Reporte de clientes.XLS')
})
