import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Types } from 'mongoose'
import {
  getPublicAnnouncement,
  listPublicAnnouncements,
} from '../dist/services/announcementPublicService.js'
import { decodeAnnouncementPublicCursor } from '../dist/utils/announcementPublicPolicy.js'
import { ApiProblem } from '../dist/utils/messagingPolicy.js'

const body = {
  type: 'document',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Public body' }] }],
}
const time = (day) => new Date(`2035-01-${String(day).padStart(2, '0')}T00:00:00.000Z`)
const id = (suffix) => new Types.ObjectId(`507f1f77bcf86cd7994390${suffix}`)
const record = (suffix, overrides = {}) => ({
  _id: id(suffix),
  category: 'platform_announcement',
  priority: 'normal',
  title: `Announcement ${suffix}`,
  body,
  publicationStatus: 'published',
  governanceStatus: 'normal',
  publishedAt: time(10),
  revision: 9,
  createdAt: time(1),
  updatedAt: time(9),
  __v: 3,
  ...overrides,
})

const matches = (candidate, filter) => {
  if (candidate.publicationStatus !== filter.publicationStatus) return false
  if (candidate.governanceStatus !== filter.governanceStatus) return false
  if (filter.category && candidate.category !== filter.category) return false
  if (!filter.$or) return true
  const boundaryTime = filter.$or[0].publishedAt.$lt
  const boundaryId = filter.$or[1]._id.$lt.toString()
  return (
    candidate.publishedAt < boundaryTime ||
    (candidate.publishedAt.valueOf() === boundaryTime.valueOf() &&
      candidate._id.toString() < boundaryId)
  )
}

const repositoryFor = (records) => {
  const calls = []
  return {
    calls,
    async list(filter, sort, limit) {
      calls.push({ filter, sort, limit })
      return records
        .filter((candidate) => matches(candidate, filter))
        .sort(
          (left, right) =>
            right.publishedAt.valueOf() - left.publishedAt.valueOf() ||
            right._id.toString().localeCompare(left._id.toString()),
        )
        .slice(0, limit)
    },
    async findStateById(announcementId) {
      calls.push({ operation: 'findStateById', announcementId })
      return records.find((candidate) => candidate._id.toString() === announcementId) ?? null
    },
    async findAvailableById(announcementId) {
      calls.push({ operation: 'findAvailableById', announcementId })
      return (
        records.find(
          (candidate) =>
            candidate._id.toString() === announcementId &&
            candidate.publicationStatus === 'published' &&
            candidate.governanceStatus === 'normal',
        ) ?? null
      )
    },
  }
}

const assertNotFound = async (operation) => {
  await assert.rejects(
    operation,
    (error) =>
      error instanceof ApiProblem &&
      error.status === 404 &&
      error.code === 'ANNOUNCEMENT_NOT_FOUND' &&
      error.message === 'Announcement not found',
  )
}

describe('P10-I3 Announcement public service', () => {
  it('queries only Published + Normal, supports category, and requests limit + 1', async () => {
    const records = [
      record('11'),
      record('12', { publicationStatus: 'draft' }),
      record('13', { publicationStatus: 'withdrawn' }),
      record('14', { governanceStatus: 'exceptionally_removed' }),
      record('15', { category: 'feature_update' }),
    ]
    const repository = repositoryFor(records)
    const all = await listPublicAnnouncements({ cursor: null, limit: 20 }, repository)
    assert.deepEqual(
      all.announcements.map(({ id }) => id).sort(),
      [records[0]._id.toString(), records[4]._id.toString()].sort(),
    )
    assert.deepEqual(repository.calls[0].sort, { publishedAt: -1, _id: -1 })
    assert.equal(repository.calls[0].limit, 21)
    assert.equal(repository.calls[0].filter.publicationStatus, 'published')
    assert.equal(repository.calls[0].filter.governanceStatus, 'normal')
    assert.equal('category' in repository.calls[0].filter, false)

    const filtered = await listPublicAnnouncements(
      { category: 'feature_update', cursor: null, limit: 20 },
      repository,
    )
    assert.deepEqual(
      filtered.announcements.map(({ id }) => id),
      [records[4]._id.toString()],
    )
    assert.equal(repository.calls[1].filter.category, 'feature_update')
  })

  it('orders ties by descending id and paginates without duplicate or omission', async () => {
    const records = [
      record('11', { publishedAt: time(12) }),
      record('12', { publishedAt: time(11) }),
      record('13', { publishedAt: time(11) }),
      record('14', { publishedAt: time(10) }),
      record('15', { publishedAt: time(9) }),
    ]
    const repository = repositoryFor(records)
    const first = await listPublicAnnouncements({ cursor: null, limit: 2 }, repository)
    assert.ok(first.nextCursor)
    const second = await listPublicAnnouncements(
      { cursor: decodeAnnouncementPublicCursor(first.nextCursor), limit: 2 },
      repository,
    )
    assert.ok(second.nextCursor)
    const third = await listPublicAnnouncements(
      { cursor: decodeAnnouncementPublicCursor(second.nextCursor), limit: 2 },
      repository,
    )
    const actual = [...first.announcements, ...second.announcements, ...third.announcements].map(
      ({ id }) => id,
    )
    const expected = [...records]
      .sort(
        (left, right) =>
          right.publishedAt.valueOf() - left.publishedAt.valueOf() ||
          right._id.toString().localeCompare(left._id.toString()),
      )
      .map(({ _id }) => _id.toString())
    assert.deepEqual(actual, expected)
    assert.equal(new Set(actual).size, records.length)
    assert.equal(third.nextCursor, null)
  })

  it('uses an explicit list DTO with Important Update and category-safe maintenance', async () => {
    const importantUpdate = { at: time(9), note: 'Schedule clarified.' }
    const maintenance = {
      status: 'completed',
      startsAt: time(8),
      endsAt: time(9),
      affectedAreas: ['Movie discovery'],
      expectedImpact: 'Brief interruption.',
      actualCompletionTime: time(9),
    }
    const maintenanceRecord = record('11', {
      category: 'system_maintenance',
      priority: 'important',
      importantUpdate,
      maintenance,
    })
    const staleMaintenanceRecord = record('12', { maintenance })
    const result = await listPublicAnnouncements(
      { cursor: null, limit: 20 },
      repositoryFor([maintenanceRecord, staleMaintenanceRecord]),
    )
    const item = result.announcements.find(({ id }) => id === maintenanceRecord._id.toString())
    assert.deepEqual(item.importantUpdate, importantUpdate)
    assert.deepEqual(item.maintenance, maintenance)
    assert.equal('body' in item, false)
    for (const forbidden of [
      'publicationStatus',
      'governanceStatus',
      'revision',
      'createdAt',
      'updatedAt',
      '__v',
    ]) {
      assert.equal(forbidden in item, false)
    }
    const stale = result.announcements.find(
      ({ id }) => id === staleMaintenanceRecord._id.toString(),
    )
    assert.equal('maintenance' in stale, false)
  })

  it('returns an allowlisted Available detail with body and optional metadata', async () => {
    const importantUpdate = { at: time(9), note: 'Updated.' }
    const maintenance = {
      status: 'scheduled',
      startsAt: time(11),
      endsAt: time(12),
      affectedAreas: ['Profiles'],
      expectedImpact: 'Read-only window.',
    }
    const available = record('11', {
      category: 'system_maintenance',
      importantUpdate,
      maintenance,
    })
    const detail = await getPublicAnnouncement(available._id.toString(), repositoryFor([available]))
    assert.equal(detail.availability, 'available')
    assert.deepEqual(detail.body, body)
    assert.deepEqual(detail.importantUpdate, importantUpdate)
    assert.deepEqual(detail.maintenance, maintenance)
    for (const forbidden of [
      'publicationStatus',
      'governanceStatus',
      'revision',
      'createdAt',
      'updatedAt',
      '__v',
    ]) {
      assert.equal(forbidden in detail, false)
    }
  })

  it('returns minimal Withdrawn and Removed tombstones without protected content', async () => {
    const sensitive = {
      importantUpdate: { at: time(9), note: 'Secret update.' },
      maintenance: {
        status: 'scheduled',
        startsAt: time(11),
        endsAt: time(12),
        affectedAreas: ['Secret area'],
        expectedImpact: 'Secret impact.',
      },
      removalReason: 'private reason',
      audit: { actor: 'private actor' },
    }
    const withdrawn = record('11', { publicationStatus: 'withdrawn', ...sensitive })
    const removed = record('12', {
      publicationStatus: 'draft',
      governanceStatus: 'exceptionally_removed',
      ...sensitive,
    })
    const repository = repositoryFor([withdrawn, removed])
    assert.deepEqual(await getPublicAnnouncement(withdrawn._id.toString(), repository), {
      availability: 'withdrawn',
      id: withdrawn._id.toString(),
    })
    assert.deepEqual(await getPublicAnnouncement(removed._id.toString(), repository), {
      availability: 'removed',
      id: removed._id.toString(),
    })
    assert.equal(
      repository.calls.some(({ operation }) => operation === 'findAvailableById'),
      false,
    )
  })

  it('gives Draft and nonexistent records identical public not-found semantics', async () => {
    const draft = record('11', { publicationStatus: 'draft' })
    const repository = repositoryFor([draft])
    await assertNotFound(() => getPublicAnnouncement(draft._id.toString(), repository))
    await assertNotFound(() => getPublicAnnouncement(id('12').toString(), repository))
  })
})
