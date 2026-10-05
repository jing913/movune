import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Types } from 'mongoose'
import { createAnnouncementGovernanceService } from '../dist/services/announcementGovernanceService.js'
import { ApiProblem } from '../dist/utils/messagingPolicy.js'

const body = {
  type: 'document',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Governance body' }] }],
}
const now = new Date('2035-07-10T12:00:00.000Z')
const publishedAt = new Date('2035-07-01T00:00:00.000Z')
const id = (suffix) => new Types.ObjectId(`a07f1f77bcf86cd7994390${suffix}`)
const maintenance = (status = 'scheduled', overrides = {}) => ({
  status,
  startsAt: new Date('2035-07-11T00:00:00.000Z'),
  endsAt: new Date('2035-07-11T02:00:00.000Z'),
  affectedAreas: ['Discovery'],
  expectedImpact: 'Brief impact',
  ...(status === 'completed' ? { actualCompletionTime: now } : {}),
  ...overrides,
})
const record = (suffix = '11', overrides = {}) => ({
  _id: id(suffix),
  category: 'platform_announcement',
  priority: 'normal',
  title: 'Governance title',
  body,
  publicationStatus: 'draft',
  governanceStatus: 'normal',
  revision: 0,
  createdAt: new Date('2035-06-01T00:00:00.000Z'),
  updatedAt: new Date('2035-07-01T00:00:00.000Z'),
  ...overrides,
})

const clone = (value) => {
  if (value instanceof Types.ObjectId) return new Types.ObjectId(value.toString())
  if (value instanceof Date) return new Date(value)
  if (Array.isArray(value)) return value.map(clone)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]))
  }
  return value
}
const matches = (candidate, filter) =>
  Object.entries(filter).every(([key, value]) => {
    const actual = key === 'maintenance.status' ? candidate.maintenance?.status : candidate[key]
    return actual?.toString?.() === value?.toString?.()
  })

const harness = (initial, { failEvent = false, failTransaction = false } = {}) => {
  const records = initial.map(clone)
  const events = []
  const calls = []
  const session = { transaction: 'test-session' }
  const repository = {
    async findById(announcementId, receivedSession) {
      calls.push({ operation: 'findById', announcementId, session: receivedSession })
      const found = records.find(({ _id }) => _id.toString() === announcementId)
      return found ? clone(found) : null
    },
    async mutate(filter, update, receivedSession) {
      calls.push({
        operation: 'mutate',
        filter: clone(filter),
        update: clone(update),
        session: receivedSession,
      })
      const index = records.findIndex((candidate) => matches(candidate, filter))
      if (index < 0) return null
      const next = clone(records[index])
      Object.assign(next, clone(update.$set ?? {}))
      for (const field of Object.keys(update.$unset ?? {})) delete next[field]
      next.revision += update.$inc?.revision ?? 0
      next.updatedAt = new Date(next.updatedAt.valueOf() + 1)
      records[index] = next
      return clone(next)
    },
    async createEvent(value, receivedSession) {
      calls.push({ operation: 'createEvent', value: clone(value), session: receivedSession })
      if (failEvent) throw new Error('private database detail')
      events.push(clone(value))
    },
  }
  const transactionRunner = async (operation) => {
    if (failTransaction) throw new Error('private topology detail')
    const recordSnapshot = clone(records)
    const eventSnapshot = clone(events)
    try {
      return await operation(session)
    } catch (error) {
      records.splice(0, records.length, ...recordSnapshot)
      events.splice(0, events.length, ...eventSnapshot)
      throw error
    }
  }
  return {
    records,
    events,
    calls,
    session,
    service: createAnnouncementGovernanceService({ repository, transactionRunner, now: () => now }),
  }
}

const rejectsCode = (operation, code) =>
  assert.rejects(operation, (error) => error instanceof ApiProblem && error.code === code)

const editInput = (expectedRevision, overrides = {}) => ({
  expectedRevision,
  editIntent: 'general_correction',
  category: 'platform_announcement',
  priority: 'normal',
  title: 'Governance title',
  body,
  ...overrides,
})

describe('P10-I5 Announcement governance service', () => {
  it('publishes a complete Draft atomically with server time, OCC, and audit', async () => {
    const draft = record()
    const h = harness([draft])
    const result = await h.service.publish(draft._id.toString(), id('91').toString(), {
      expectedRevision: 0,
    })
    assert.equal(result.publicationStatus, 'published')
    assert.deepEqual(result.publishedAt, now)
    assert.equal(result.revision, 1)
    const mutation = h.calls.find(({ operation }) => operation === 'mutate')
    assert.deepEqual(mutation.filter, {
      _id: draft._id.toString(),
      revision: 0,
      publicationStatus: 'draft',
      governanceStatus: 'normal',
    })
    assert.equal(mutation.update.$inc.revision, 1)
    assert.equal(h.events[0].action, 'publish')
    assert.deepEqual(h.events[0].occurredAt, now)
    assert.equal(
      h.calls.every((call) => call.session === h.session),
      true,
    )
  })

  it('rejects invalid publication and classifies failed OCC only after mutation', async () => {
    const incomplete = record('11', { title: undefined })
    const invalid = harness([incomplete])
    await rejectsCode(
      () =>
        invalid.service.publish(incomplete._id.toString(), id('91').toString(), {
          expectedRevision: 0,
        }),
      'ANNOUNCEMENT_PUBLICATION_INVALID',
    )
    assert.equal(
      invalid.calls.some(({ operation }) => operation === 'mutate'),
      false,
    )
    assert.equal(invalid.events.length, 0)

    const staleRecord = record('12', { revision: 1 })
    const stale = harness([staleRecord])
    await rejectsCode(
      () =>
        stale.service.publish(staleRecord._id.toString(), id('91').toString(), {
          expectedRevision: 0,
        }),
      'ANNOUNCEMENT_REVISION_CONFLICT',
    )
    assert.deepEqual(
      stale.calls.map(({ operation }) => operation),
      ['findById', 'mutate', 'findById'],
    )
    assert.equal(stale.events.length, 0)
    for (const state of ['published', 'withdrawn']) {
      const wrong = record('13', { publicationStatus: state })
      await rejectsCode(
        () =>
          harness([wrong]).service.publish(wrong._id.toString(), id('91').toString(), {
            expectedRevision: 0,
          }),
        'ANNOUNCEMENT_STATE_CONFLICT',
      )
    }
    const removed = record('14', { governanceStatus: 'exceptionally_removed' })
    await rejectsCode(
      () =>
        harness([removed]).service.publish(removed._id.toString(), id('91').toString(), {
          expectedRevision: 0,
        }),
      'ANNOUNCEMENT_STATE_CONFLICT',
    )
  })

  it('preserves Important Update on correction and replaces it only for a new Important Update', async () => {
    const previous = { at: new Date('2035-07-03T00:00:00.000Z'), note: 'Previous update' }
    const published = record('11', {
      publicationStatus: 'published',
      publishedAt,
      revision: 2,
      importantUpdate: previous,
    })
    const h = harness([published])
    const corrected = await h.service.editPublished(
      published._id.toString(),
      id('91').toString(),
      editInput(2, { title: 'Corrected title', priority: 'important' }),
    )
    assert.deepEqual(corrected.publishedAt, publishedAt)
    assert.deepEqual(corrected.importantUpdate, previous)
    assert.equal(corrected.revision, 3)
    assert.equal(h.events[0].action, 'published_edit')
    assert.equal('updateNote' in h.events[0], false)
    assert.ok(h.events[0].changes.fields.includes('title'))
    assert.deepEqual(h.events[0].changes.priority, { from: 'normal', to: 'important' })

    const important = await h.service.editPublished(
      published._id.toString(),
      id('91').toString(),
      editInput(3, {
        editIntent: 'important_update',
        title: 'Corrected title',
        priority: 'normal',
        updateNote: 'New operational information',
      }),
    )
    assert.deepEqual(important.publishedAt, publishedAt)
    assert.deepEqual(important.importantUpdate, {
      at: now,
      note: 'New operational information',
    })
    assert.equal(important.priority, 'normal')
    assert.equal(important.revision, 4)
    assert.equal(h.events[1].action, 'important_update')
    assert.equal(h.events[1].updateNote, 'New operational information')

    const invalidCandidate = record('12', {
      publicationStatus: 'published',
      publishedAt,
    })
    await rejectsCode(
      () =>
        harness([invalidCandidate]).service.editPublished(
          invalidCandidate._id.toString(),
          id('91').toString(),
          editInput(0, { title: ' untrimmed ' }),
        ),
      'ANNOUNCEMENT_PUBLICATION_INVALID',
    )
    for (const overrides of [
      { publicationStatus: 'draft' },
      { publicationStatus: 'withdrawn', publishedAt },
      { publicationStatus: 'published', publishedAt, governanceStatus: 'exceptionally_removed' },
    ]) {
      const wrongState = record('13', overrides)
      await rejectsCode(
        () =>
          harness([wrongState]).service.editPublished(
            wrongState._id.toString(),
            id('91').toString(),
            editInput(0),
          ),
        'ANNOUNCEMENT_STATE_CONFLICT',
      )
    }
  })

  it('enforces audited category correction through the lifecycle policy', async () => {
    const platform = record('11', { publicationStatus: 'published', publishedAt })
    const platformHarness = harness([platform])
    await platformHarness.service.editPublished(
      platform._id.toString(),
      id('91').toString(),
      editInput(0, { category: 'feature_update' }),
    )
    assert.deepEqual(platformHarness.events[0].changes.category, {
      from: 'platform_announcement',
      to: 'feature_update',
    })
    assert.equal(platformHarness.events[0].action, 'published_edit')

    const feature = record('12', {
      category: 'feature_update',
      publicationStatus: 'published',
      publishedAt,
    })
    await assert.doesNotReject(() =>
      harness([feature]).service.editPublished(
        feature._id.toString(),
        id('91').toString(),
        editInput(0),
      ),
    )

    const scheduled = maintenance()
    const toMaintenance = record('13', { publicationStatus: 'published', publishedAt })
    await assert.doesNotReject(() =>
      harness([toMaintenance]).service.editPublished(
        toMaintenance._id.toString(),
        id('91').toString(),
        editInput(0, { category: 'system_maintenance', maintenance: scheduled }),
      ),
    )
    for (const invalidMaintenance of [
      undefined,
      maintenance('in_progress'),
      { status: 'scheduled' },
    ]) {
      await rejectsCode(
        () =>
          harness([toMaintenance]).service.editPublished(
            toMaintenance._id.toString(),
            id('91').toString(),
            editInput(0, {
              category: 'system_maintenance',
              ...(invalidMaintenance ? { maintenance: invalidMaintenance } : {}),
            }),
          ),
        invalidMaintenance && Object.keys(invalidMaintenance).length === 1
          ? 'ANNOUNCEMENT_PUBLICATION_INVALID'
          : invalidMaintenance
            ? 'ANNOUNCEMENT_STATE_CONFLICT'
            : 'ANNOUNCEMENT_PUBLICATION_INVALID',
      )
    }

    for (const status of ['scheduled', 'in_progress', 'completed']) {
      const maintenanceRecord = record('14', {
        category: 'system_maintenance',
        maintenance: maintenance(status),
        publicationStatus: 'published',
        publishedAt,
      })
      const operation = () =>
        harness([maintenanceRecord]).service.editPublished(
          maintenanceRecord._id.toString(),
          id('91').toString(),
          editInput(0),
        )
      if (status === 'scheduled') await assert.doesNotReject(operation)
      else await rejectsCode(operation, 'ANNOUNCEMENT_STATE_CONFLICT')
    }
  })

  it('withdraws and restores while preserving publication content and timestamp', async () => {
    const published = record('11', {
      category: 'system_maintenance',
      maintenance: maintenance(),
      publicationStatus: 'published',
      publishedAt,
      revision: 4,
      importantUpdate: { at: now, note: 'Latest' },
    })
    const h = harness([published])
    const withdrawn = await h.service.withdraw(published._id.toString(), id('91').toString(), {
      expectedRevision: 4,
    })
    assert.equal(withdrawn.publicationStatus, 'withdrawn')
    assert.deepEqual(withdrawn.publishedAt, publishedAt)
    assert.deepEqual(withdrawn.body, body)
    assert.deepEqual(withdrawn.maintenance, published.maintenance)
    assert.deepEqual(withdrawn.importantUpdate, published.importantUpdate)
    assert.equal(withdrawn.revision, 5)
    assert.equal(h.events[0].action, 'withdraw')
    const restored = await h.service.restore(published._id.toString(), id('91').toString(), {
      expectedRevision: 5,
    })
    assert.equal(restored.publicationStatus, 'published')
    assert.deepEqual(restored.publishedAt, publishedAt)
    assert.deepEqual(restored.importantUpdate, published.importantUpdate)
    assert.equal(restored.revision, 6)
    assert.equal(h.events[1].action, 'restore')

    const stalePublished = record('15', {
      publicationStatus: 'published',
      publishedAt,
      revision: 2,
    })
    const stale = harness([stalePublished])
    await rejectsCode(
      () =>
        stale.service.withdraw(stalePublished._id.toString(), id('91').toString(), {
          expectedRevision: 1,
        }),
      'ANNOUNCEMENT_REVISION_CONFLICT',
    )
    assert.equal(stale.events.length, 0)

    for (const state of ['draft', 'withdrawn']) {
      const wrong = record('12', { publicationStatus: state })
      await rejectsCode(
        () =>
          harness([wrong]).service.withdraw(wrong._id.toString(), id('91').toString(), {
            expectedRevision: 0,
          }),
        'ANNOUNCEMENT_STATE_CONFLICT',
      )
    }
    const invalidWithdrawn = record('13', {
      publicationStatus: 'withdrawn',
      publishedAt,
      title: undefined,
    })
    await rejectsCode(
      () =>
        harness([invalidWithdrawn]).service.restore(
          invalidWithdrawn._id.toString(),
          id('91').toString(),
          { expectedRevision: 0 },
        ),
      'ANNOUNCEMENT_PUBLICATION_INVALID',
    )
    for (const state of ['draft', 'published']) {
      const wrong = record('14', { publicationStatus: state, publishedAt })
      await rejectsCode(
        () =>
          harness([wrong]).service.restore(wrong._id.toString(), id('91').toString(), {
            expectedRevision: 0,
          }),
        'ANNOUNCEMENT_STATE_CONFLICT',
      )
    }
  })

  it('supports only locked Published maintenance transitions and completion semantics', async () => {
    for (const [from, to] of [
      ['scheduled', 'in_progress'],
      ['scheduled', 'completed'],
      ['in_progress', 'completed'],
    ]) {
      const source = record('11', {
        category: 'system_maintenance',
        maintenance: maintenance(from),
        publicationStatus: 'published',
        publishedAt,
        importantUpdate: { at: publishedAt, note: 'Preserve' },
      })
      const h = harness([source])
      const result = await h.service.transitionMaintenance(
        source._id.toString(),
        id('91').toString(),
        {
          expectedRevision: 0,
          status: to,
          ...(to === 'completed' ? { actualCompletionTime: now } : {}),
        },
      )
      assert.equal(result.maintenance.status, to)
      assert.equal(result.revision, 1)
      assert.deepEqual(result.publishedAt, publishedAt)
      assert.deepEqual(result.importantUpdate, source.importantUpdate)
      if (to === 'completed') assert.deepEqual(result.maintenance.actualCompletionTime, now)
      assert.deepEqual(h.events[0].changes.maintenanceStatus, { from, to })
      const mutation = h.calls.find(({ operation }) => operation === 'mutate')
      assert.equal(mutation.filter['maintenance.status'], from)
    }

    for (const [from, to] of [
      ['in_progress', 'scheduled'],
      ['completed', 'scheduled'],
      ['completed', 'in_progress'],
      ['scheduled', 'scheduled'],
    ]) {
      const source = record('12', {
        category: 'system_maintenance',
        maintenance: maintenance(from),
        publicationStatus: 'published',
        publishedAt,
      })
      await rejectsCode(
        () =>
          harness([source]).service.transitionMaintenance(
            source._id.toString(),
            id('91').toString(),
            { expectedRevision: 0, status: to },
          ),
        'ANNOUNCEMENT_STATE_CONFLICT',
      )
    }
    for (const overrides of [
      { category: 'platform_announcement', maintenance: undefined },
      { publicationStatus: 'draft' },
      { publicationStatus: 'withdrawn' },
      { governanceStatus: 'exceptionally_removed' },
    ]) {
      const source = record('13', {
        category: 'system_maintenance',
        maintenance: maintenance(),
        publicationStatus: 'published',
        publishedAt,
        ...overrides,
      })
      await rejectsCode(
        () =>
          harness([source]).service.transitionMaintenance(
            source._id.toString(),
            id('91').toString(),
            { expectedRevision: 0, status: 'in_progress' },
          ),
        'ANNOUNCEMENT_STATE_CONFLICT',
      )
    }
  })

  it('allows only one same-revision writer and never audits failed mutations', async () => {
    const published = record('11', { publicationStatus: 'published', publishedAt, revision: 7 })
    const h = harness([published])
    await h.service.editPublished(
      published._id.toString(),
      id('91').toString(),
      editInput(7, { title: 'First writer' }),
    )
    await rejectsCode(
      () =>
        h.service.editPublished(
          published._id.toString(),
          id('92').toString(),
          editInput(7, { title: 'Second writer' }),
        ),
      'ANNOUNCEMENT_REVISION_CONFLICT',
    )
    assert.equal(h.records[0].revision, 8)
    assert.equal(h.records[0].title, 'First writer')
    assert.equal(h.events.length, 1)
  })

  it('rolls back audit failures, preserves known problems, and hides infrastructure details', async () => {
    const published = record('11', { publicationStatus: 'published', publishedAt })
    const failedAudit = harness([published], { failEvent: true })
    await rejectsCode(
      () =>
        failedAudit.service.withdraw(published._id.toString(), id('91').toString(), {
          expectedRevision: 0,
        }),
      'ANNOUNCEMENT_GOVERNANCE_TRANSACTION_FAILED',
    )
    assert.equal(failedAudit.records[0].publicationStatus, 'published')
    assert.equal(failedAudit.records[0].revision, 0)
    assert.equal(failedAudit.events.length, 0)

    const failedTransaction = harness([published], { failTransaction: true })
    await assert.rejects(
      () =>
        failedTransaction.service.withdraw(published._id.toString(), id('91').toString(), {
          expectedRevision: 0,
        }),
      (error) =>
        error instanceof ApiProblem &&
        error.code === 'ANNOUNCEMENT_GOVERNANCE_TRANSACTION_FAILED' &&
        !error.message.includes('topology'),
    )
    const wrongState = record('12')
    await rejectsCode(
      () =>
        harness([wrongState]).service.withdraw(wrongState._id.toString(), id('91').toString(), {
          expectedRevision: 0,
        }),
      'ANNOUNCEMENT_STATE_CONFLICT',
    )
  })
})
