import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  validateAnnouncementDraft,
  validateAnnouncementForPublication,
} from '../dist/policies/announcementValidationPolicy.js'

const body = {
  type: 'document',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Announcement body.' }] }],
}
const malformedBody = { type: 'document', content: [{ type: 'image' }] }
const startsAt = new Date('2035-01-01T00:00:00.000Z')
const endsAt = new Date('2035-01-01T02:00:00.000Z')
const completion = new Date('2035-01-01T01:30:00.000Z')
const completeMaintenance = (status = 'scheduled', overrides = {}) => ({
  status,
  startsAt,
  endsAt,
  affectedAreas: ['Movie discovery'],
  expectedImpact: 'Brief unavailability.',
  ...(status === 'completed' ? { actualCompletionTime: completion } : {}),
  ...overrides,
})
const draft = (overrides = {}) => ({
  category: 'platform_announcement',
  priority: 'normal',
  publicationStatus: 'draft',
  governanceStatus: 'normal',
  revision: 0,
  ...overrides,
})
const complete = (overrides = {}) => ({
  ...draft(),
  title: 'Platform news',
  body,
  ...overrides,
})
const fields = (result) => result.issues.map(({ field }) => field)

describe('P10-I4A Draft validation boundary', () => {
  it('accepts an incomplete Draft with no title, body, or maintenance', () => {
    assert.deepEqual(validateAnnouncementDraft(draft()), { valid: true, issues: [] })
  })

  it('accepts a valid present title and rejects empty or untrimmed titles without normalization', () => {
    assert.equal(validateAnnouncementDraft(draft({ title: 'Draft title' })).valid, true)
    for (const title of ['', ' Draft title ', 42]) {
      const result = validateAnnouncementDraft(draft({ title }))
      assert.equal(result.valid, false)
      assert.ok(fields(result).includes('title'))
    }
  })

  it('accepts a valid present body and rejects malformed restricted rich text', () => {
    assert.equal(validateAnnouncementDraft(draft({ body })).valid, true)
    const result = validateAnnouncementDraft(draft({ body: malformedBody }))
    assert.equal(result.valid, false)
    assert.ok(fields(result).includes('body'))
  })

  it('accepts absent and locally valid partial system maintenance', () => {
    assert.equal(validateAnnouncementDraft(draft({ category: 'system_maintenance' })).valid, true)
    for (const maintenance of [
      { status: 'scheduled' },
      { startsAt },
      { status: 'scheduled', startsAt },
      { startsAt, endsAt },
      { affectedAreas: ['Profiles'] },
      { expectedImpact: 'Brief interruption.' },
    ]) {
      assert.equal(
        validateAnnouncementDraft(draft({ category: 'system_maintenance', maintenance })).valid,
        true,
      )
    }
  })

  it('rejects invalid maintenance status and dates', () => {
    for (const maintenance of [
      { status: 'invalid' },
      { startsAt: new Date('invalid') },
      { endsAt: '2035-01-01T02:00:00.000Z' },
    ]) {
      assert.equal(
        validateAnnouncementDraft(draft({ category: 'system_maintenance', maintenance })).valid,
        false,
      )
    }
  })

  it('rejects equal or reversed maintenance windows', () => {
    for (const invalidEnd of [startsAt, new Date('2034-12-31T23:00:00.000Z')]) {
      const result = validateAnnouncementDraft(
        draft({ category: 'system_maintenance', maintenance: { startsAt, endsAt: invalidEnd } }),
      )
      assert.equal(result.valid, false)
      assert.ok(fields(result).includes('maintenance.endsAt'))
    }
  })

  it('validates present affected areas and expected impact', () => {
    for (const maintenance of [
      { affectedAreas: [] },
      { affectedAreas: [' untrimmed '] },
      { affectedAreas: 'Profiles' },
      { expectedImpact: '' },
      { expectedImpact: ' untrimmed ' },
    ]) {
      assert.equal(
        validateAnnouncementDraft(draft({ category: 'system_maintenance', maintenance })).valid,
        false,
      )
    }
  })

  it('enforces completion-time semantics on partial maintenance', () => {
    for (const status of [undefined, 'scheduled', 'in_progress']) {
      const result = validateAnnouncementDraft(
        draft({
          category: 'system_maintenance',
          maintenance: { status, actualCompletionTime: completion },
        }),
      )
      assert.equal(result.valid, false)
      assert.ok(fields(result).includes('maintenance.actualCompletionTime'))
    }
    assert.equal(
      validateAnnouncementDraft(
        draft({
          category: 'system_maintenance',
          maintenance: { status: 'completed', actualCompletionTime: completion },
        }),
      ).valid,
      true,
    )
  })

  it('rejects maintenance on non-maintenance categories and unknown maintenance fields', () => {
    assert.equal(
      validateAnnouncementDraft(draft({ maintenance: { status: 'scheduled' } })).valid,
      false,
    )
    const result = validateAnnouncementDraft(
      draft({ category: 'system_maintenance', maintenance: { status: 'scheduled', extra: true } }),
    )
    assert.equal(result.valid, false)
    assert.ok(result.issues.some(({ code }) => code === 'unsupported'))
  })

  it('rejects invalid root enums, Draft state, governance, and revisions', () => {
    for (const overrides of [
      { category: 'other' },
      { priority: 'urgent' },
      { publicationStatus: 'published' },
      { governanceStatus: 'exceptionally_removed' },
      { revision: -1 },
      { revision: 1.5 },
    ]) {
      assert.equal(validateAnnouncementDraft(draft(overrides)).valid, false)
    }
  })

  it('requires a non-negative integer revision in whole-state validation', () => {
    const withoutRevision = {
      category: 'platform_announcement',
      priority: 'normal',
      publicationStatus: 'draft',
      governanceStatus: 'normal',
    }
    const missing = validateAnnouncementDraft(withoutRevision)
    assert.equal(missing.valid, false)
    assert.deepEqual(
      missing.issues.find(({ field }) => field === 'revision'),
      { field: 'revision', code: 'required', message: 'revision is required' },
    )
    assert.equal(validateAnnouncementDraft(draft({ revision: 0 })).valid, true)
    assert.equal(validateAnnouncementDraft(draft({ revision: 7 })).valid, true)
    assert.equal(validateAnnouncementDraft(draft({ revision: -1 })).valid, false)
    assert.equal(validateAnnouncementDraft(draft({ revision: 1.5 })).valid, false)

    const publication = validateAnnouncementForPublication({
      ...withoutRevision,
      title: 'Platform news',
      body,
    })
    assert.equal(publication.valid, false)
    assert.ok(
      publication.issues.some(({ field, code }) => field === 'revision' && code === 'required'),
    )
  })
})

describe('P10-I4A Publication validation boundary', () => {
  it('requires title and body', () => {
    const missingTitle = validateAnnouncementForPublication(complete({ title: undefined }))
    const missingBody = validateAnnouncementForPublication(complete({ body: undefined }))
    assert.equal(missingTitle.valid, false)
    assert.ok(fields(missingTitle).includes('title'))
    assert.equal(missingBody.valid, false)
    assert.ok(fields(missingBody).includes('body'))
  })

  it('rejects invalid title and malformed body', () => {
    assert.equal(
      validateAnnouncementForPublication(complete({ title: ' untrimmed ' })).valid,
      false,
    )
    assert.equal(validateAnnouncementForPublication(complete({ body: malformedBody })).valid, false)
  })

  it('accepts complete platform announcements and feature updates', () => {
    assert.equal(validateAnnouncementForPublication(complete()).valid, true)
    assert.equal(
      validateAnnouncementForPublication(complete({ category: 'feature_update' })).valid,
      true,
    )
  })

  it('requires complete system maintenance data', () => {
    assert.equal(
      validateAnnouncementForPublication(complete({ category: 'system_maintenance' })).valid,
      false,
    )
    const incomplete = validateAnnouncementForPublication(
      complete({ category: 'system_maintenance', maintenance: { status: 'scheduled' } }),
    )
    assert.equal(incomplete.valid, false)
    assert.ok(fields(incomplete).includes('maintenance.startsAt'))
    assert.ok(fields(incomplete).includes('maintenance.endsAt'))
  })

  it('rejects invalid complete maintenance windows', () => {
    assert.equal(
      validateAnnouncementForPublication(
        complete({
          category: 'system_maintenance',
          maintenance: completeMaintenance('scheduled', { endsAt: startsAt }),
        }),
      ).valid,
      false,
    )
  })

  it('requires completion time exactly for completed maintenance', () => {
    assert.equal(
      validateAnnouncementForPublication(
        complete({
          category: 'system_maintenance',
          maintenance: completeMaintenance('completed', { actualCompletionTime: undefined }),
        }),
      ).valid,
      false,
    )
    assert.equal(
      validateAnnouncementForPublication(
        complete({ category: 'system_maintenance', maintenance: completeMaintenance('completed') }),
      ).valid,
      true,
    )
    for (const status of ['scheduled', 'in_progress']) {
      assert.equal(
        validateAnnouncementForPublication(
          complete({
            category: 'system_maintenance',
            maintenance: completeMaintenance(status, { actualCompletionTime: completion }),
          }),
        ).valid,
        false,
      )
    }
  })

  it('rejects maintenance data on non-maintenance announcements', () => {
    assert.equal(
      validateAnnouncementForPublication(
        complete({ maintenance: completeMaintenance('scheduled') }),
      ).valid,
      false,
    )
  })

  it('accepts complete scheduled and in-progress maintenance announcements', () => {
    for (const status of ['scheduled', 'in_progress']) {
      assert.equal(
        validateAnnouncementForPublication(
          complete({ category: 'system_maintenance', maintenance: completeMaintenance(status) }),
        ).valid,
        true,
      )
    }
  })
})
