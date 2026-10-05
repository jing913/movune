import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import mongoose, { Types } from 'mongoose'
import * as governanceEventModule from '../dist/models/announcementGovernanceEventModel.js'
import {
  ANNOUNCEMENT_GOVERNANCE_ACTIONS,
  appendAnnouncementGovernanceEvent,
} from '../dist/models/announcementGovernanceEventModel.js'

const originalInsertOne = mongoose.Collection.prototype.insertOne
const session = { transaction: 'governance-event-test-session' }
const occurredAt = new Date('2035-06-01T00:00:00.000Z')
const event = (overrides = {}) => ({
  announcementId: new Types.ObjectId(),
  actorUserId: new Types.ObjectId(),
  action: 'publish',
  occurredAt,
  outcome: 'succeeded',
  ...overrides,
})

const captureInserts = (
  operation = async (document) => ({ acknowledged: true, insertedId: document._id }),
) => {
  const inserts = []
  mongoose.Collection.prototype.insertOne = async function (document, options) {
    inserts.push({ document, options })
    return operation(document, options)
  }
  return inserts
}

afterEach(() => {
  mongoose.Collection.prototype.insertOne = originalInsertOne
})

describe('P10-I5 Announcement governance event model', () => {
  it('exports only the append boundary and safe runtime constants', () => {
    assert.deepEqual(Object.keys(governanceEventModule).sort(), [
      'ANNOUNCEMENT_GOVERNANCE_ACTIONS',
      'ANNOUNCEMENT_GOVERNANCE_EVENT_IMMUTABLE_MESSAGE',
      'appendAnnouncementGovernanceEvent',
    ])
    assert.equal('AnnouncementGovernanceEvent' in governanceEventModule, false)
    for (const mutation of [
      'model',
      'collection',
      'save',
      'updateOne',
      'updateMany',
      'findOneAndUpdate',
      'replaceOne',
      'deleteOne',
      'deleteMany',
      'findOneAndDelete',
      'bulkWrite',
    ]) {
      assert.equal(mutation in governanceEventModule, false, `${mutation} must not be exported`)
    }
  })

  it('accepts every locked action and structured safe change shape', async () => {
    const inserts = captureInserts()
    for (const action of ANNOUNCEMENT_GOVERNANCE_ACTIONS) {
      await assert.doesNotReject(() =>
        appendAnnouncementGovernanceEvent(
          event({
            action,
            changes: {
              fields: ['title', 'body', 'maintenance.expectedImpact'],
              category: { from: 'platform_announcement', to: 'feature_update' },
              priority: { from: 'normal', to: 'important' },
              maintenanceStatus: { from: 'scheduled', to: 'completed' },
            },
            ...(action === 'important_update' ? { updateNote: 'Important context' } : {}),
          }),
          session,
        ),
      )
    }
    assert.equal(inserts.length, ANNOUNCEMENT_GOVERNANCE_ACTIONS.length)
  })

  it('requires identities, action, occurredAt, and succeeded outcome', async () => {
    const inserts = captureInserts()
    for (const overrides of [
      { announcementId: undefined },
      { actorUserId: undefined },
      { action: undefined },
      { action: 'remove' },
      { occurredAt: undefined },
      { outcome: undefined },
      { outcome: 'failed' },
    ]) {
      await assert.rejects(() => appendAnnouncementGovernanceEvent(event(overrides), session))
    }
    assert.equal(inserts.length, 0)
  })

  it('validates Important Update notes and safe field names without content snapshots', async () => {
    const inserts = captureInserts()
    await assert.doesNotReject(() =>
      appendAnnouncementGovernanceEvent(
        event({ action: 'important_update', updateNote: 'Service impact changed' }),
        session,
      ),
    )
    for (const invalid of [
      event({ action: 'important_update' }),
      event({ action: 'important_update', updateNote: '' }),
      event({ action: 'important_update', updateNote: ' untrimmed ' }),
      event({ action: 'publish', updateNote: 'Not allowed' }),
      event({ changes: { fields: ['title: old secret -> new secret'] } }),
    ]) {
      await assert.rejects(() => appendAnnouncementGovernanceEvent(invalid, session))
    }
    assert.equal(inserts.length, 1)
    const retained = JSON.stringify(inserts[0].document)
    assert.equal(retained.includes('oldTitle'), false)
    assert.equal(retained.includes('newTitle'), false)
    assert.equal(retained.includes('before'), false)
    assert.equal(retained.includes('after'), false)
  })

  it('appends with the supplied transaction session and returns no writable document', async () => {
    const inserts = captureInserts()
    const result = await appendAnnouncementGovernanceEvent(event(), session)
    assert.equal(result, undefined)
    assert.equal(inserts.length, 1)
    assert.deepEqual(inserts[0].options.session, session)
    assert.ok(inserts[0].document.createdAt instanceof Date)
    assert.equal('updatedAt' in inserts[0].document, false)
  })

  it('propagates append failure to its transaction caller', async () => {
    captureInserts(async () => {
      throw new Error('test append failure')
    })
    await assert.rejects(
      () => appendAnnouncementGovernanceEvent(event(), session),
      /test append failure/,
    )
  })
})
