import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ApiProblem } from '../dist/utils/messagingPolicy.js'
import {
  announcementAdminSort,
  buildAnnouncementAdminCursorFilter,
  decodeAnnouncementAdminCursor,
  encodeAnnouncementAdminCursor,
  parseAnnouncementAdminId,
  parseAnnouncementAdminLimit,
  parseAnnouncementAdminQuery,
  parseAnnouncementCreateRequest,
  parseAnnouncementDeleteRequest,
  parseAnnouncementSaveRequest,
} from '../dist/utils/announcementAdminPolicy.js'

const id = '507f1f77bcf86cd799439011'
const updatedAt = new Date('2035-03-04T05:06:07.000Z')

const assertProblem = (operation, code) =>
  assert.throws(operation, (error) => error instanceof ApiProblem && error.code === code)

describe('P10-I4B Announcement admin policy', () => {
  it('accepts only the exact Create Draft request contract', () => {
    assert.deepEqual(
      parseAnnouncementCreateRequest({ category: 'feature_update', priority: 'normal' }),
      {
        category: 'feature_update',
        priority: 'normal',
      },
    )
    for (const invalid of [
      {},
      { category: 'feature_update' },
      { priority: 'normal' },
      { category: 'feature_update', priority: 'normal', title: 'Not allowed' },
      { category: 'feature_update', priority: 'normal', body: {} },
      { category: 'feature_update', priority: 'normal', maintenance: {} },
      { category: 'feature_update', priority: 'normal', revision: 0 },
      { category: 'feature_update', priority: 'normal', publicationStatus: 'draft' },
      { category: 'feature_update', priority: 'normal', governanceStatus: 'normal' },
      { category: 'feature_update', priority: 'normal', unknown: true },
      null,
      [],
    ]) {
      assertProblem(() => parseAnnouncementCreateRequest(invalid), 'ANNOUNCEMENT_REQUEST_INVALID')
    }
  })

  it('parses only full-snapshot Save requests and never coerces revisions', () => {
    const parsed = parseAnnouncementSaveRequest({
      expectedRevision: 2,
      category: 'system_maintenance',
      priority: 'important',
      maintenance: {
        status: 'scheduled',
        startsAt: '2035-03-04T05:06:07.000Z',
      },
    })
    assert.equal(parsed.expectedRevision, 2)
    assert.ok(parsed.maintenance.startsAt instanceof Date)
    for (const invalid of [
      { category: 'feature_update', priority: 'normal' },
      { expectedRevision: 0, priority: 'normal' },
      { expectedRevision: 0, category: 'feature_update' },
      { expectedRevision: -1, category: 'feature_update', priority: 'normal' },
      { expectedRevision: 1.5, category: 'feature_update', priority: 'normal' },
      { expectedRevision: '1', category: 'feature_update', priority: 'normal' },
      { expectedRevision: 0, category: 'feature_update', priority: 'normal', revision: 0 },
      { expectedRevision: 0, category: 'feature_update', priority: 'normal', extra: true },
    ]) {
      assertProblem(() => parseAnnouncementSaveRequest(invalid), 'ANNOUNCEMENT_REQUEST_INVALID')
    }
  })

  it('accepts only expectedRevision for Delete Draft', () => {
    assert.deepEqual(parseAnnouncementDeleteRequest({ expectedRevision: 0 }), {
      expectedRevision: 0,
    })
    for (const invalid of [
      {},
      { expectedRevision: -1 },
      { expectedRevision: 1.5 },
      { expectedRevision: '0' },
      { expectedRevision: 0, extra: true },
    ]) {
      assertProblem(() => parseAnnouncementDeleteRequest(invalid), 'ANNOUNCEMENT_REQUEST_INVALID')
    }
  })

  it('enforces the locked admin limit and query shape', () => {
    assert.equal(parseAnnouncementAdminLimit(undefined), 20)
    assert.equal(parseAnnouncementAdminLimit('1'), 1)
    assert.equal(parseAnnouncementAdminLimit('50'), 50)
    for (const invalid of ['0', '51', '1.5', 'abc', ['20']]) {
      assertProblem(() => parseAnnouncementAdminLimit(invalid), 'ANNOUNCEMENT_ADMIN_LIMIT_INVALID')
    }
    assert.deepEqual(parseAnnouncementAdminQuery({}), { limit: 20, cursor: null })
    assertProblem(
      () => parseAnnouncementAdminQuery({ search: 'x' }),
      'ANNOUNCEMENT_REQUEST_INVALID',
    )
  })

  it('round-trips only canonical unpadded base64url admin cursors', () => {
    const encoded = encodeAnnouncementAdminCursor({ updatedAt, id })
    assert.deepEqual(decodeAnnouncementAdminCursor(encoded), { updatedAt, id })
    for (const invalid of [
      `${encoded}!`,
      `${encoded}***`,
      `${encoded} `,
      `${encoded}\n`,
      `${encoded}=`,
      `${encoded}+`,
      `${encoded}/`,
      'not-a-cursor',
      Buffer.from(JSON.stringify({ updatedAt: 'invalid', id })).toString('base64url'),
      Buffer.from(JSON.stringify({ updatedAt: updatedAt.toISOString(), id: 'invalid' })).toString(
        'base64url',
      ),
      Buffer.from(JSON.stringify({ updatedAt: updatedAt.toISOString(), id, extra: true })).toString(
        'base64url',
      ),
    ]) {
      assertProblem(
        () => decodeAnnouncementAdminCursor(invalid),
        'ANNOUNCEMENT_ADMIN_CURSOR_INVALID',
      )
    }
  })

  it('uses updatedAt and ObjectId descending cursor semantics', () => {
    assert.deepEqual(announcementAdminSort, { updatedAt: -1, _id: -1 })
    const filter = buildAnnouncementAdminCursorFilter({ updatedAt, id })
    assert.equal(filter.$or[0].updatedAt.$lt, updatedAt)
    assert.equal(filter.$or[1].updatedAt, updatedAt)
    assert.equal(filter.$or[1]._id.$lt.toString(), id)
    assert.deepEqual(buildAnnouncementAdminCursorFilter(null), {})
  })

  it('validates Announcement ids with the stable code', () => {
    assert.equal(parseAnnouncementAdminId(id), id)
    assertProblem(() => parseAnnouncementAdminId('bad'), 'ANNOUNCEMENT_ID_INVALID')
  })
})
