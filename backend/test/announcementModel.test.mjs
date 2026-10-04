import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Announcement } from '../dist/models/announcementModel.js'

const body = {
  type: 'document',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Announcement body.' }] }],
}

const maintenance = (status = 'scheduled', overrides = {}) => ({
  status,
  startsAt: new Date('2035-01-01T00:00:00.000Z'),
  endsAt: new Date('2035-01-01T02:00:00.000Z'),
  affectedAreas: ['Movie discovery'],
  expectedImpact: 'Brief unavailability.',
  ...(status === 'completed' ? { actualCompletionTime: new Date('2035-01-01T01:30:00.000Z') } : {}),
  ...overrides,
})

const announcement = (overrides = {}) =>
  new Announcement({
    category: 'platform_announcement',
    priority: 'normal',
    title: 'Platform news',
    body,
    publicationStatus: 'draft',
    governanceStatus: 'normal',
    ...overrides,
  })

describe('P10-I1 Announcement persistence contract', () => {
  it('accepts a valid Draft Announcement and defaults the Movune revision to zero', async () => {
    const document = announcement()
    await assert.doesNotReject(() => document.validate())
    assert.equal(document.revision, 0)
  })

  it('rejects invalid root enums and invalid revisions', async () => {
    for (const overrides of [
      { category: 'other' },
      { priority: 'urgent' },
      { publicationStatus: 'archived' },
      { governanceStatus: 'removed' },
      { revision: -1 },
      { revision: 1.5 },
    ]) {
      await assert.rejects(() => announcement(overrides).validate())
    }
  })

  it('accepts structurally complete Scheduled maintenance', async () => {
    await assert.doesNotReject(() =>
      announcement({ category: 'system_maintenance', maintenance: maintenance() }).validate(),
    )
  })

  it('requires maintenance only for system_maintenance Announcements', async () => {
    await assert.rejects(() =>
      announcement({ category: 'system_maintenance', maintenance: undefined }).validate(),
    )
    await assert.rejects(() => announcement({ maintenance: maintenance() }).validate())
    await assert.rejects(() =>
      announcement({ category: 'feature_update', maintenance: maintenance() }).validate(),
    )
  })

  it('requires actualCompletionTime exactly for Completed maintenance', async () => {
    await assert.rejects(() =>
      announcement({
        category: 'system_maintenance',
        maintenance: maintenance('completed', { actualCompletionTime: undefined }),
      }).validate(),
    )
    for (const status of ['scheduled', 'in_progress']) {
      await assert.rejects(() =>
        announcement({
          category: 'system_maintenance',
          maintenance: maintenance(status, {
            actualCompletionTime: new Date('2035-01-01T01:30:00.000Z'),
          }),
        }).validate(),
      )
    }
  })

  it('requires startsAt to be earlier than endsAt', async () => {
    for (const startsAt of [
      new Date('2035-01-01T02:00:00.000Z'),
      new Date('2035-01-01T03:00:00.000Z'),
    ]) {
      await assert.rejects(() =>
        announcement({
          category: 'system_maintenance',
          maintenance: maintenance('scheduled', { startsAt }),
        }).validate(),
      )
    }
  })

  it('validates the Rich Text body through the persistence model', async () => {
    await assert.rejects(() =>
      announcement({ body: { type: 'document', content: [{ type: 'image' }] } }).validate(),
    )
  })

  it('contains only the locked Announcement root fields', () => {
    assert.deepEqual(
      Object.keys(Announcement.schema.paths).sort(),
      [
        '__v',
        '_id',
        'body',
        'category',
        'createdAt',
        'governanceStatus',
        'importantUpdate',
        'maintenance',
        'priority',
        'publicationStatus',
        'publishedAt',
        'revision',
        'title',
        'updatedAt',
      ].sort(),
    )
  })
})
