import { test } from 'node:test'
import assert from 'node:assert/strict'
import { replyLink, cardOf } from '../src/index.js'

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

test('la tarjeta de perfil viaja en el enlace, y solo si tiene forma de tarjeta', () => {
  const card = { v: 1, profileId: '{"x":"a"}', sealedBy: '{"x":"a"}', seq: 1, keys: [{ pub: '{"x":"a"}', encPub: '{"x":"e"}' }], sig: 's' }
  const url = replyLink({ pubkey: '{}', card: cardOf(card) })
  const params = new URLSearchParams(url.split('#')[1])
  assert.deepEqual(JSON.parse(Buffer.from(params.get('card'), 'base64url').toString()), card)
  assert.equal(cardOf({ keys: [] }), null)
  assert.equal(cardOf('x'), null)
  assert.equal(cardOf({ profileId: 'p', keys: ['k'.repeat(7000)] }), null)
})
