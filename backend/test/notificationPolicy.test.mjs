import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  buildNotificationCursorFilter,
  decodeNotificationCursor,
  encodeNotificationCursor,
  NotificationInputError,
  notificationSort,
  parseNotificationLimit,
} from '../dist/utils/notificationPolicy.js'

describe('Notification pagination policy', () => {
  it('uses deterministic newest-first ordering', () => {
    assert.deepEqual(notificationSort, { createdAt: -1, _id: -1 })
  })

  it('round-trips an opaque createdAt and id cursor', () => {
    const createdAt = new Date('2026-09-04T08:30:00.000Z')
    const id = '64b64c0a4f4c6a2e9c6d1001'
    const encoded = encodeNotificationCursor({ createdAt, id })

    assert.deepEqual(decodeNotificationCursor(encoded), { createdAt, id })
  })

  it('builds a tie-safe cursor boundary', () => {
    const cursor = {
      createdAt: new Date('2026-09-04T08:30:00.000Z'),
      id: '64b64c0a4f4c6a2e9c6d1001',
    }
    const filter = buildNotificationCursorFilter(cursor)

    assert.equal(filter.$or[0].createdAt.$lt, cursor.createdAt)
    assert.equal(filter.$or[1].createdAt, cursor.createdAt)
    assert.equal(filter.$or[1]._id.$lt.toString(), cursor.id)
  })

  it('rejects malformed cursors', () => {
    assert.throws(() => decodeNotificationCursor('not-a-cursor'), NotificationInputError)
    const invalidId = Buffer.from(
      JSON.stringify({ createdAt: '2026-09-04T08:30:00.000Z', id: 'invalid' }),
    ).toString('base64url')
    assert.throws(() => decodeNotificationCursor(invalidId), NotificationInputError)
  })

  it('validates limits without accepting arrays or partial numbers', () => {
    assert.equal(parseNotificationLimit(undefined), 20)
    assert.equal(parseNotificationLimit('5'), 5)
    assert.throws(() => parseNotificationLimit('20items'), NotificationInputError)
    assert.throws(() => parseNotificationLimit(['5']), NotificationInputError)
    assert.throws(() => parseNotificationLimit('51'), NotificationInputError)
  })
})
