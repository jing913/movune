import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Types } from 'mongoose'
import {
  deriveAnnouncementGovernanceChanges,
  parseAnnouncementHistoricalPublishRequest,
  parseAnnouncementMaintenanceTransitionRequest,
  parseAnnouncementPublishedEditRequest,
  parseAnnouncementRevisionRequest,
} from '../dist/utils/announcementGovernancePolicy.js'
import { ApiProblem } from '../dist/utils/messagingPolicy.js'

const body = {
  type: 'document',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Body' }] }],
}
const id = new Types.ObjectId('907f1f77bcf86cd799439011')
const current = {
  _id: id,
  category: 'platform_announcement',
  priority: 'normal',
  title: 'Title',
  body,
  publicationStatus: 'published',
  governanceStatus: 'normal',
  publishedAt: new Date('2035-06-01T00:00:00.000Z'),
  revision: 2,
  createdAt: new Date('2035-05-01T00:00:00.000Z'),
  updatedAt: new Date('2035-06-01T00:00:00.000Z'),
}

const assertRequestInvalid = (operation) =>
  assert.throws(
    operation,
    (error) => error instanceof ApiProblem && error.code === 'ANNOUNCEMENT_REQUEST_INVALID',
  )

describe('P10-I5 Announcement governance policy', () => {
  it('accepts only the exact historical-publish request and normalizes its logical date', () => {
    const parsed = parseAnnouncementHistoricalPublishRequest({
      expectedRevision: 0,
      effectiveAt: '2026-10-06',
      effectiveAtBasis: 'production_verified_no_later_than',
    })
    assert.equal(parsed.expectedRevision, 0)
    assert.equal(parsed.effectiveAt.toISOString(), '2026-10-05T16:00:00.000Z')
    assert.equal(parsed.effectiveAtBasis, 'production_verified_no_later_than')

    for (const invalid of [
      {},
      { effectiveAt: '2026-10-06', effectiveAtBasis: 'production_verified_no_later_than' },
      {
        expectedRevision: -1,
        effectiveAt: '2026-10-06',
        effectiveAtBasis: 'production_verified_no_later_than',
      },
      {
        expectedRevision: 0,
        effectiveAt: '2026-02-29',
        effectiveAtBasis: 'production_verified_no_later_than',
      },
      {
        expectedRevision: 0,
        effectiveAt: '2026-10-06T00:00:00.000Z',
        effectiveAtBasis: 'production_verified_no_later_than',
      },
      { expectedRevision: 0, effectiveAt: '2026-10-06', effectiveAtBasis: 'exact_release_time' },
      {
        expectedRevision: 0,
        effectiveAt: '2026-10-06',
        effectiveAtBasis: 'production_verified_no_later_than',
        extra: true,
      },
    ]) {
      assertRequestInvalid(() => parseAnnouncementHistoricalPublishRequest(invalid))
    }
  })

  it('accepts only the exact revision command request', () => {
    assert.deepEqual(parseAnnouncementRevisionRequest({ expectedRevision: 0 }), {
      expectedRevision: 0,
    })
    for (const invalid of [
      {},
      { expectedRevision: -1 },
      { expectedRevision: 1.5 },
      { expectedRevision: '1' },
      { expectedRevision: 1, extra: true },
    ]) {
      assertRequestInvalid(() => parseAnnouncementRevisionRequest(invalid))
    }
  })

  it('parses complete Published snapshots and canonical maintenance dates', () => {
    const parsed = parseAnnouncementPublishedEditRequest({
      expectedRevision: 2,
      editIntent: 'general_correction',
      category: 'system_maintenance',
      priority: 'normal',
      title: 'Title',
      body,
      maintenance: {
        status: 'scheduled',
        startsAt: '2035-06-02T00:00:00.000Z',
        endsAt: '2035-06-02T01:00:00.000Z',
        affectedAreas: ['Discovery'],
        expectedImpact: 'Brief impact',
      },
    })
    assert.ok(parsed.maintenance.startsAt instanceof Date)
    assert.ok(parsed.maintenance.endsAt instanceof Date)
  })

  it('enforces edit intent and Important Update note rules', () => {
    const base = {
      expectedRevision: 2,
      category: 'feature_update',
      priority: 'important',
      title: 'Title',
      body,
    }
    assert.equal(
      parseAnnouncementPublishedEditRequest({
        ...base,
        editIntent: 'important_update',
        updateNote: 'Meaningful change',
      }).updateNote,
      'Meaningful change',
    )
    for (const invalid of [
      { ...base, editIntent: 'unknown' },
      { ...base, editIntent: 'important_update' },
      { ...base, editIntent: 'important_update', updateNote: '' },
      { ...base, editIntent: 'important_update', updateNote: ' untrimmed ' },
      { ...base, editIntent: 'general_correction', updateNote: 'Forbidden' },
      { ...base, editIntent: 'general_correction', extra: true },
    ]) {
      assertRequestInvalid(() => parseAnnouncementPublishedEditRequest(invalid))
    }
  })

  it('enforces maintenance transition completion-time semantics', () => {
    assert.deepEqual(
      parseAnnouncementMaintenanceTransitionRequest({ expectedRevision: 1, status: 'in_progress' }),
      { expectedRevision: 1, status: 'in_progress' },
    )
    const completed = parseAnnouncementMaintenanceTransitionRequest({
      expectedRevision: 1,
      status: 'completed',
      actualCompletionTime: '2035-06-02T00:30:00.000Z',
    })
    assert.ok(completed.actualCompletionTime instanceof Date)
    for (const invalid of [
      { expectedRevision: 1, status: 'completed' },
      {
        expectedRevision: 1,
        status: 'in_progress',
        actualCompletionTime: '2035-06-02T00:00:00.000Z',
      },
      { expectedRevision: 1, status: 'invalid' },
      { expectedRevision: 1, status: { toString: () => 'in_progress' } },
      { expectedRevision: 1, status: 'completed', actualCompletionTime: 'not-a-date' },
      { expectedRevision: 1, status: 'completed', actualCompletionTime: '2035-06-02' },
      {
        expectedRevision: 1,
        status: 'completed',
        actualCompletionTime: '2035-06-02T00:30:00.000Z',
        extra: true,
      },
    ]) {
      assertRequestInvalid(() => parseAnnouncementMaintenanceTransitionRequest(invalid))
    }
  })

  it('derives safe structured metadata without retaining content values', () => {
    const maintenance = {
      status: 'scheduled',
      startsAt: new Date('2035-06-02T00:00:00.000Z'),
      endsAt: new Date('2035-06-02T01:00:00.000Z'),
      affectedAreas: ['Discovery'],
      expectedImpact: 'Brief impact',
    }
    const changes = deriveAnnouncementGovernanceChanges(current, {
      ...current,
      category: 'system_maintenance',
      priority: 'important',
      title: 'Changed secret title',
      body: { ...body, content: [] },
      maintenance,
    })
    assert.deepEqual(changes.category, {
      from: 'platform_announcement',
      to: 'system_maintenance',
    })
    assert.deepEqual(changes.priority, { from: 'normal', to: 'important' })
    assert.ok(changes.fields.includes('title'))
    assert.ok(changes.fields.includes('body'))
    assert.ok(changes.fields.includes('maintenance.expectedImpact'))
    assert.equal(JSON.stringify(changes).includes('Changed secret title'), false)
    assert.equal(JSON.stringify(changes).includes('Brief impact'), false)
  })
})
