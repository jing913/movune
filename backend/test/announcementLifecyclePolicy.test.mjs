import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  canOrdinarilyMutateAnnouncement,
  canTransitionAnnouncementCategory,
  canTransitionAnnouncementGovernance,
  canTransitionAnnouncementMaintenance,
  canTransitionAnnouncementPublication,
} from '../dist/policies/announcementLifecyclePolicy.js'

const maintenance = (status = 'scheduled', overrides = {}) => ({
  status,
  startsAt: new Date('2035-01-01T00:00:00.000Z'),
  endsAt: new Date('2035-01-01T02:00:00.000Z'),
  affectedAreas: ['Movie discovery'],
  expectedImpact: 'Brief unavailability.',
  ...(status === 'completed' ? { actualCompletionTime: new Date('2035-01-01T01:30:00.000Z') } : {}),
  ...overrides,
})

describe('P10-I1 Announcement lifecycle policy', () => {
  it('implements the complete locked governance transition matrix', () => {
    const expected = {
      normal: { normal: false, exceptionally_removed: true },
      exceptionally_removed: { normal: false, exceptionally_removed: false },
    }

    for (const [from, destinations] of Object.entries(expected)) {
      for (const [to, allowed] of Object.entries(destinations)) {
        assert.equal(canTransitionAnnouncementGovernance(from, to), allowed, `${from} -> ${to}`)
      }
    }
  })

  it('implements the complete locked publication transition matrix', () => {
    const expected = {
      draft: { draft: false, published: true, withdrawn: false },
      published: { draft: false, published: false, withdrawn: true },
      withdrawn: { draft: false, published: true, withdrawn: false },
    }

    for (const [from, destinations] of Object.entries(expected)) {
      for (const [to, allowed] of Object.entries(destinations)) {
        assert.equal(canTransitionAnnouncementPublication(from, to), allowed, `${from} -> ${to}`)
      }
    }
  })

  it('implements the complete locked maintenance transition matrix', () => {
    const expected = {
      scheduled: { scheduled: false, in_progress: true, completed: true },
      in_progress: { scheduled: false, in_progress: false, completed: true },
      completed: { scheduled: false, in_progress: false, completed: false },
    }

    for (const [from, destinations] of Object.entries(expected)) {
      for (const [to, allowed] of Object.entries(destinations)) {
        assert.equal(canTransitionAnnouncementMaintenance(from, to), allowed, `${from} -> ${to}`)
      }
    }
  })

  it('treats exceptionally_removed as terminal for ordinary behavior', () => {
    assert.equal(canOrdinarilyMutateAnnouncement('exceptionally_removed'), false)
    assert.equal(
      canTransitionAnnouncementPublication('withdrawn', 'published', 'exceptionally_removed'),
      false,
    )
    assert.equal(
      canTransitionAnnouncementMaintenance('scheduled', 'in_progress', 'exceptionally_removed'),
      false,
    )
    assert.equal(
      canTransitionAnnouncementCategory({
        from: 'platform_announcement',
        to: 'feature_update',
        governanceStatus: 'exceptionally_removed',
      }),
      false,
    )
  })

  it('allows transitions between non-maintenance categories without maintenance data', () => {
    assert.equal(
      canTransitionAnnouncementCategory({
        from: 'platform_announcement',
        to: 'feature_update',
      }),
      true,
    )
    assert.equal(
      canTransitionAnnouncementCategory({
        from: 'feature_update',
        to: 'platform_announcement',
      }),
      true,
    )
  })

  it('requires complete Scheduled data when entering maintenance', () => {
    const base = { from: 'platform_announcement', to: 'system_maintenance' }
    assert.equal(
      canTransitionAnnouncementCategory({ ...base, nextMaintenance: maintenance() }),
      true,
    )
    for (const nextMaintenance of [
      undefined,
      maintenance('in_progress'),
      maintenance('scheduled', { affectedAreas: [] }),
      maintenance('scheduled', { startsAt: new Date('2035-01-01T03:00:00.000Z') }),
    ]) {
      assert.equal(canTransitionAnnouncementCategory({ ...base, nextMaintenance }), false)
    }
  })

  it('allows leaving only Scheduled maintenance and requires the payload to be cleared', () => {
    const base = { from: 'system_maintenance', to: 'platform_announcement' }
    assert.equal(
      canTransitionAnnouncementCategory({ ...base, currentMaintenance: maintenance() }),
      true,
    )
    assert.equal(
      canTransitionAnnouncementCategory({
        ...base,
        currentMaintenance: maintenance(),
        nextMaintenance: maintenance(),
      }),
      false,
    )
    assert.equal(
      canTransitionAnnouncementCategory({
        ...base,
        currentMaintenance: maintenance('in_progress'),
      }),
      false,
    )
    assert.equal(
      canTransitionAnnouncementCategory({
        ...base,
        currentMaintenance: maintenance('completed'),
      }),
      false,
    )
  })
})
