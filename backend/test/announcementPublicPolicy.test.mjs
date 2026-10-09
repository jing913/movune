import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ApiProblem } from '../dist/utils/messagingPolicy.js'
import {
  announcementPublicSort,
  buildAnnouncementPublicCursorFilter,
  decodeAnnouncementPublicCursor,
  encodeAnnouncementPublicCursor,
  parseAnnouncementCategory,
  parseAnnouncementPublicLimit,
} from '../dist/utils/announcementPublicPolicy.js'

const objectId = '507f1f77bcf86cd799439011'
const orderingAt = new Date('2035-01-02T03:04:05.000Z')

const assertProblem = (operation, code) =>
  assert.throws(
    operation,
    (error) => error instanceof ApiProblem && error.status === 400 && error.code === code,
  )

describe('P10-I3 Announcement public read policy', () => {
  it('accepts an omitted or locked category and rejects every other category', () => {
    assert.equal(parseAnnouncementCategory(undefined), undefined)
    for (const category of ['platform_announcement', 'feature_update', 'system_maintenance']) {
      assert.equal(parseAnnouncementCategory(category), category)
    }
    for (const invalid of ['all', 'other', '', ['feature_update']]) {
      assertProblem(() => parseAnnouncementCategory(invalid), 'ANNOUNCEMENT_CATEGORY_INVALID')
    }
  })

  it('uses the default and accepts only integer limits from 1 through 50', () => {
    assert.equal(parseAnnouncementPublicLimit(undefined), 20)
    assert.equal(parseAnnouncementPublicLimit('1'), 1)
    assert.equal(parseAnnouncementPublicLimit('20'), 20)
    assert.equal(parseAnnouncementPublicLimit('50'), 50)
    for (const invalid of ['0', '-1', 'abc', '1.5', '999', ['20']]) {
      assertProblem(() => parseAnnouncementPublicLimit(invalid), 'ANNOUNCEMENT_LIMIT_INVALID')
    }
  })

  it('round-trips an opaque orderingAt and ObjectId cursor', () => {
    const encoded = encodeAnnouncementPublicCursor({ orderingAt, id: objectId })
    assert.notEqual(encoded.includes(orderingAt.toISOString()), true)
    assert.deepEqual(decodeAnnouncementPublicCursor(encoded), { orderingAt, id: objectId })
  })

  it('accepts only the canonical base64url representation of a valid cursor', () => {
    const encoded = encodeAnnouncementPublicCursor({ orderingAt, id: objectId })
    assert.deepEqual(decodeAnnouncementPublicCursor(encoded), { orderingAt, id: objectId })
    for (const suffix of ['!', '***', ' ', '\n', '=']) {
      assertProblem(
        () => decodeAnnouncementPublicCursor(`${encoded}${suffix}`),
        'ANNOUNCEMENT_CURSOR_INVALID',
      )
    }
  })

  it('rejects malformed, structurally invalid, invalid-date, and invalid-id cursors', () => {
    const encoded = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
    for (const invalid of [
      'not-a-cursor',
      encoded({ orderingAt: orderingAt.toISOString() }),
      encoded({ orderingAt: orderingAt.toISOString(), id: objectId, extra: true }),
      encoded({ orderingAt: 'not-a-date', id: objectId }),
      encoded({ orderingAt: orderingAt.toISOString(), id: 'invalid' }),
    ]) {
      assertProblem(() => decodeAnnouncementPublicCursor(invalid), 'ANNOUNCEMENT_CURSOR_INVALID')
    }
  })

  it('uses stable descending orderingAt and ObjectId ordering', () => {
    assert.deepEqual(announcementPublicSort, { orderingAt: -1, _id: -1 })
  })

  it('builds the descending earlier-time or same-time lower-id boundary', () => {
    const cursor = { orderingAt, id: objectId }
    const filter = buildAnnouncementPublicCursorFilter(cursor)
    assert.equal(filter.$or[0].orderingAt.$lt, orderingAt)
    assert.equal(filter.$or[1].orderingAt, orderingAt)
    assert.equal(filter.$or[1]._id.$lt.toString(), objectId)
    assert.deepEqual(buildAnnouncementPublicCursorFilter(null), {})
  })

  it('accepts legacy opaque publishedAt cursors as the equivalent ordering tuple', () => {
    const legacy = Buffer.from(
      JSON.stringify({ publishedAt: orderingAt.toISOString(), id: objectId }),
    ).toString('base64url')
    assert.deepEqual(decodeAnnouncementPublicCursor(legacy), { orderingAt, id: objectId })
  })
})
