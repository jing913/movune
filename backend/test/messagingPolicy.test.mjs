import test from 'node:test'
import assert from 'node:assert/strict'
import { Types } from 'mongoose'
import {
  decodeMessageCursor,
  encodeMessageCursor,
  isAfter,
  normalizeMessageContent,
  participantKey,
} from '../dist/utils/messagingPolicy.js'

test('participant key is canonical and message content is normalized', () => {
  assert.equal(participantKey('b', 'a'), participantKey('a', 'b'))
  assert.equal(normalizeMessageContent('  hello\r\nworld  '), 'hello\nworld')
  assert.throws(() => normalizeMessageContent('   '), { code: 'MESSAGE_EMPTY' })
})

test('message cursor round trips the canonical order', () => {
  const cursor = { createdAt: new Date('2026-09-06T00:00:00.000Z'), id: new Types.ObjectId() }
  const decoded = decodeMessageCursor(encodeMessageCursor(cursor))
  assert.equal(decoded.createdAt.toISOString(), cursor.createdAt.toISOString())
  assert.equal(decoded.id.toString(), cursor.id.toString())
  assert.equal(
    isAfter(
      { createdAt: cursor.createdAt, id: new Types.ObjectId('ffffffffffffffffffffffff') },
      cursor,
    ),
    true,
  )
})
