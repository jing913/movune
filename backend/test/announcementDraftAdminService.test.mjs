import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Types } from 'mongoose'
import {
  createAnnouncementDraft,
  deleteAnnouncementDraft,
  getAdminAnnouncement,
  listAdminAnnouncements,
  saveAnnouncementDraft,
} from '../dist/services/announcementDraftAdminService.js'
import { decodeAnnouncementAdminCursor } from '../dist/utils/announcementAdminPolicy.js'
import { ApiProblem } from '../dist/utils/messagingPolicy.js'

const body = {
  type: 'document',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Admin body' }] }],
}
const time = (day) => new Date(`2035-04-${String(day).padStart(2, '0')}T00:00:00.000Z`)
const id = (suffix) => new Types.ObjectId(`707f1f77bcf86cd7994390${suffix}`)
const record = (suffix, overrides = {}) => ({
  _id: id(suffix),
  category: 'platform_announcement',
  priority: 'normal',
  title: `Announcement ${suffix}`,
  body,
  publicationStatus: 'draft',
  governanceStatus: 'normal',
  revision: 0,
  createdAt: time(1),
  updatedAt: time(10),
  __v: 8,
  ...overrides,
})

const matchesCursor = (candidate, filter) => {
  if (!filter.$or) return true
  const cursorTime = filter.$or[0].updatedAt.$lt
  const cursorId = filter.$or[1]._id.$lt.toString()
  return (
    candidate.updatedAt < cursorTime ||
    (candidate.updatedAt.valueOf() === cursorTime.valueOf() && candidate._id.toString() < cursorId)
  )
}

const repositoryFor = (initial = []) => {
  const records = [...initial]
  const calls = []
  return {
    records,
    calls,
    async list(filter, sort, limit) {
      calls.push({ operation: 'list', filter, sort, limit })
      return records
        .filter((candidate) => matchesCursor(candidate, filter))
        .sort(
          (left, right) =>
            right.updatedAt.valueOf() - left.updatedAt.valueOf() ||
            right._id.toString().localeCompare(left._id.toString()),
        )
        .slice(0, limit)
    },
    async findById(announcementId) {
      calls.push({ operation: 'findById', announcementId })
      return records.find(({ _id }) => _id.toString() === announcementId) ?? null
    },
    async findStateById(announcementId) {
      calls.push({ operation: 'findStateById', announcementId })
      return records.find(({ _id }) => _id.toString() === announcementId) ?? null
    },
    async create(value) {
      calls.push({ operation: 'create', value })
      const created = record('99', {
        ...value,
        title: undefined,
        body: undefined,
        updatedAt: time(2),
      })
      records.push(created)
      return created
    },
    async save(filter, update) {
      calls.push({ operation: 'save', filter, update })
      const current = records.find(
        (candidate) =>
          candidate._id.toString() === filter._id &&
          candidate.revision === filter.revision &&
          candidate.publicationStatus === filter.publicationStatus &&
          candidate.governanceStatus === filter.governanceStatus,
      )
      if (!current) return null
      Object.assign(current, update.$set)
      for (const field of Object.keys(update.$unset ?? {})) delete current[field]
      current.revision += update.$inc.revision
      current.updatedAt = new Date(current.updatedAt.valueOf() + 1)
      return current
    },
    async delete(filter) {
      calls.push({ operation: 'delete', filter })
      const index = records.findIndex(
        (candidate) =>
          candidate._id.toString() === filter._id &&
          candidate.revision === filter.revision &&
          candidate.publicationStatus === filter.publicationStatus &&
          candidate.governanceStatus === filter.governanceStatus,
      )
      if (index < 0) return false
      records.splice(index, 1)
      return true
    },
  }
}

const rejectsCode = (operation, code) =>
  assert.rejects(operation, (error) => error instanceof ApiProblem && error.code === code)

describe('P10-I4B Announcement Draft admin service', () => {
  it('lists all lifecycle states with stable pagination, explicit DTOs, and removed privacy', async () => {
    const records = [
      record('11', { updatedAt: time(12), publicationStatus: 'published' }),
      record('12', { updatedAt: time(11), title: undefined, body: undefined }),
      record('13', { updatedAt: time(11) }),
      record('14', {
        updatedAt: time(10),
        governanceStatus: 'exceptionally_removed',
        title: 'Protected',
        body,
        maintenance: { status: 'scheduled' },
        importantUpdate: { at: time(9), note: 'Protected' },
      }),
    ]
    const repository = repositoryFor(records)
    const first = await listAdminAnnouncements({ cursor: null, limit: 2 }, repository)
    assert.ok(first.nextCursor)
    const second = await listAdminAnnouncements(
      { cursor: decodeAnnouncementAdminCursor(first.nextCursor), limit: 2 },
      repository,
    )
    const all = [...first.announcements, ...second.announcements]
    assert.equal(new Set(all.map(({ id }) => id)).size, 4)
    assert.deepEqual(
      all.map(({ id: announcementId }) => announcementId),
      [...records]
        .sort(
          (left, right) =>
            right.updatedAt.valueOf() - left.updatedAt.valueOf() ||
            right._id.toString().localeCompare(left._id.toString()),
        )
        .map(({ _id }) => _id.toString()),
    )
    assert.equal(repository.calls[0].limit, 3)
    assert.deepEqual(repository.calls[0].sort, { updatedAt: -1, _id: -1 })
    assert.equal(
      all.some((item) => 'body' in item),
      false,
    )
    const untitled = all.find(
      ({ id: announcementId }) => announcementId === records[1]._id.toString(),
    )
    assert.equal('title' in untitled, false)
    const removed = all.find(
      ({ id: announcementId }) => announcementId === records[3]._id.toString(),
    )
    for (const protectedField of ['title', 'body', 'maintenance', 'importantUpdate']) {
      assert.equal(protectedField in removed, false)
    }
    assert.equal('__v' in all[0], false)
  })

  it('returns full ordinary detail but redacts removed content and classifies missing records', async () => {
    const ordinary = record('11', { maintenance: undefined })
    const removed = record('12', {
      governanceStatus: 'exceptionally_removed',
      maintenance: { status: 'scheduled' },
      importantUpdate: { at: time(9), note: 'Protected' },
    })
    const repository = repositoryFor([ordinary, removed])
    const detail = await getAdminAnnouncement(ordinary._id.toString(), repository)
    assert.deepEqual(detail.body, body)
    assert.equal(detail.title, ordinary.title)
    assert.equal('__v' in detail, false)
    const redacted = await getAdminAnnouncement(removed._id.toString(), repository)
    for (const field of ['title', 'body', 'maintenance', 'importantUpdate']) {
      assert.equal(field in redacted, false)
    }
    await rejectsCode(
      () => getAdminAnnouncement(id('13').toString(), repository),
      'ANNOUNCEMENT_NOT_FOUND',
    )
  })

  it('creates only authoritative Draft + Normal revision-zero records', async () => {
    const repository = repositoryFor()
    const created = await createAnnouncementDraft(
      { category: 'feature_update', priority: 'important' },
      repository,
    )
    assert.equal(created.publicationStatus, 'draft')
    assert.equal(created.governanceStatus, 'normal')
    assert.equal(created.revision, 0)
    assert.equal('title' in created, false)
    assert.deepEqual(repository.calls[0].value, {
      category: 'feature_update',
      priority: 'important',
      publicationStatus: 'draft',
      governanceStatus: 'normal',
      revision: 0,
    })
    await rejectsCode(
      () => createAnnouncementDraft({ category: 'bad', priority: 'normal' }, repository),
      'ANNOUNCEMENT_DRAFT_INVALID',
    )
  })

  it('saves a validated full snapshot with atomic filter, clearing, and one revision increment', async () => {
    const current = record('11', {
      revision: 4,
      title: 'Old title',
      body,
      category: 'system_maintenance',
      maintenance: { status: 'scheduled', startsAt: time(11), expectedImpact: 'Old impact' },
    })
    const repository = repositoryFor([current])
    const saved = await saveAnnouncementDraft(
      current._id.toString(),
      {
        expectedRevision: 4,
        category: 'system_maintenance',
        priority: 'important',
        maintenance: { status: 'scheduled', startsAt: time(11) },
      },
      repository,
    )
    assert.equal(saved.revision, 5)
    assert.equal('title' in saved, false)
    assert.equal('body' in saved, false)
    assert.equal('expectedImpact' in saved.maintenance, false)
    const call = repository.calls.find(({ operation }) => operation === 'save')
    assert.deepEqual(call.filter, {
      _id: current._id.toString(),
      revision: 4,
      publicationStatus: 'draft',
      governanceStatus: 'normal',
    })
    assert.equal(call.update.$inc.revision, 1)
    assert.deepEqual(Object.keys(call.update.$unset).sort(), ['body', 'title'])
  })

  it('adds/removes editable content and clears maintenance on category change', async () => {
    const current = record('11', { revision: 1, title: undefined, body: undefined })
    const repository = repositoryFor([current])
    const added = await saveAnnouncementDraft(
      current._id.toString(),
      {
        expectedRevision: 1,
        category: 'system_maintenance',
        priority: 'normal',
        title: 'Draft title',
        body,
        maintenance: { status: 'scheduled' },
      },
      repository,
    )
    assert.equal(added.title, 'Draft title')
    assert.deepEqual(added.body, body)
    const cleared = await saveAnnouncementDraft(
      current._id.toString(),
      { expectedRevision: 2, category: 'feature_update', priority: 'normal' },
      repository,
    )
    assert.equal(cleared.revision, 3)
    for (const field of ['title', 'body', 'maintenance']) assert.equal(field in cleared, false)
  })

  it('rejects malformed Drafts before persistence with structured I4A issues', async () => {
    const current = record('11')
    const repository = repositoryFor([current])
    await assert.rejects(
      () =>
        saveAnnouncementDraft(
          current._id.toString(),
          {
            expectedRevision: 0,
            category: 'platform_announcement',
            priority: 'normal',
            title: ' untrimmed ',
          },
          repository,
        ),
      (error) =>
        error instanceof ApiProblem &&
        error.code === 'ANNOUNCEMENT_DRAFT_INVALID' &&
        error.details.issues.some(({ field }) => field === 'title'),
    )
    assert.equal(
      repository.calls.some(({ operation }) => operation === 'save'),
      false,
    )
  })

  it('enforces save OCC races and classifies only after failed atomic writes', async () => {
    const current = record('11', { revision: 2 })
    const repository = repositoryFor([current])
    const input = { expectedRevision: 2, category: 'feature_update', priority: 'normal' }
    await saveAnnouncementDraft(current._id.toString(), input, repository)
    assert.equal(
      repository.calls.filter(({ operation }) => operation === 'findStateById').length,
      0,
    )
    await rejectsCode(
      () => saveAnnouncementDraft(current._id.toString(), input, repository),
      'ANNOUNCEMENT_REVISION_CONFLICT',
    )
    assert.equal(repository.calls.at(-1).operation, 'findStateById')

    current.publicationStatus = 'published'
    await rejectsCode(
      () =>
        saveAnnouncementDraft(
          current._id.toString(),
          { ...input, expectedRevision: 3 },
          repository,
        ),
      'ANNOUNCEMENT_STATE_CONFLICT',
    )
    await rejectsCode(
      () => saveAnnouncementDraft(id('12').toString(), input, repository),
      'ANNOUNCEMENT_NOT_FOUND',
    )
  })

  it('physically deletes only Draft + Normal at the expected revision and returns no content', async () => {
    const draftRecord = record('11', { revision: 3 })
    const published = record('12', { publicationStatus: 'published' })
    const withdrawn = record('13', { publicationStatus: 'withdrawn' })
    const removed = record('14', { governanceStatus: 'exceptionally_removed' })
    const stale = record('15', { revision: 2 })
    const repository = repositoryFor([draftRecord, published, withdrawn, removed, stale])
    assert.deepEqual(await deleteAnnouncementDraft(draftRecord._id.toString(), 3, repository), {
      deleted: true,
      id: draftRecord._id.toString(),
    })
    const deletion = repository.calls.find(({ operation }) => operation === 'delete')
    assert.deepEqual(deletion.filter, {
      _id: draftRecord._id.toString(),
      revision: 3,
      publicationStatus: 'draft',
      governanceStatus: 'normal',
    })
    await rejectsCode(
      () => deleteAnnouncementDraft(stale._id.toString(), 1, repository),
      'ANNOUNCEMENT_REVISION_CONFLICT',
    )
    for (const state of [published, withdrawn, removed]) {
      await rejectsCode(
        () => deleteAnnouncementDraft(state._id.toString(), state.revision, repository),
        'ANNOUNCEMENT_STATE_CONFLICT',
      )
    }
    await rejectsCode(
      () => deleteAnnouncementDraft(id('16').toString(), 0, repository),
      'ANNOUNCEMENT_NOT_FOUND',
    )
  })
})
