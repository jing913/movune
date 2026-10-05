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
const publishedAt = new Date('2035-01-02T03:04:05.000Z')

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

  it('round-trips an opaque publishedAt and ObjectId cursor', () => {
    const encoded = encodeAnnouncementPublicCursor({ publishedAt, id: objectId })
    assert.notEqual(encoded.includes(publishedAt.toISOString()), true)
    assert.deepEqual(decodeAnnouncementPublicCursor(encoded), { publishedAt, id: objectId })
  })

  it('accepts only the canonical base64url representation of a valid cursor', () => {
    const encoded = encodeAnnouncementPublicCursor({ publishedAt, id: objectId })
    assert.deepEqual(decodeAnnouncementPublicCursor(encoded), { publishedAt, id: objectId })
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
      encoded({ publishedAt: publishedAt.toISOString() }),
      encoded({ publishedAt: publishedAt.toISOString(), id: objectId, extra: true }),
      encoded({ publishedAt: 'not-a-date', id: objectId }),
      encoded({ publishedAt: publishedAt.toISOString(), id: 'invalid' }),
    ]) {
      assertProblem(() => decodeAnnouncementPublicCursor(invalid), 'ANNOUNCEMENT_CURSOR_INVALID')
    }
  })

  it('uses stable descending publishedAt and ObjectId ordering', () => {
    assert.deepEqual(announcementPublicSort, { publishedAt: -1, _id: -1 })
  })

  it('builds the descending earlier-time or same-time lower-id boundary', () => {
    const cursor = { publishedAt, id: objectId }
    const filter = buildAnnouncementPublicCursorFilter(cursor)
    assert.equal(filter.$or[0].publishedAt.$lt, publishedAt)
    assert.equal(filter.$or[1].publishedAt, publishedAt)
    assert.equal(filter.$or[1]._id.$lt.toString(), objectId)
    assert.deepEqual(buildAnnouncementPublicCursorFilter(null), {})
  })
})
