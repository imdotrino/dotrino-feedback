import { test } from 'node:test'
import assert from 'node:assert/strict'
import { replyLink } from '../src/index.js'

test('el enlace de respuesta lleva la llave en base64url y el apodo, en el #fragment', () => {
  const pubkey = '{"crv":"P-256","ext":true,"key_ops":["verify"],"kty":"EC","x":"ab","y":"cd"}'
  const url = replyLink({ pubkey, nickname: 'Ana Pérez' })
  const [base, frag] = url.split('#')
  assert.equal(base, 'https://messenger.dotrino.com/')
  const params = new URLSearchParams(frag)
  assert.equal(Buffer.from(params.get('to'), 'base64url').toString(), pubkey)
  assert.equal(params.get('nick'), 'Ana Pérez')
})

test('sin apodo no hay nick', () => {
  assert.ok(!replyLink({ pubkey: '{}' }).includes('nick='))
})
