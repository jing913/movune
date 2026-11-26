import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { User } from '../dist/models/userModel.js'
import {
  CASE_REVIEW_PERMISSION,
  CASE_REVIEW_MUTATION_PERMISSION,
  assertCaseReviewAuthorized,
  assertCaseReviewMutationAuthorized,
  deriveCaseReviewMutationCapabilities,
} from '../dist/policies/caseReviewAuthorizationPolicy.js'
import {
  REPORT_REVIEW_PERMISSION,
  assertReportReviewAuthorized,
} from '../dist/policies/reportReviewAuthorizationPolicy.js'

const evaluatedAt = new Date('2035-08-01T00:00:00.000Z')
const identity = (role = 'admin', caseReviewMutationEnabled = true) => ({
  _id: '507f1f77bcf86cd799439011',
  role,
  caseReviewMutationEnabled,
})
const activeState = () => ({
  status: 'active',
  evaluatedAt,
  governingDecisionId: null,
  activeRestrictionDecisionIds: [],
  restrictionEndsAt: null,
})

describe('Case review read and mutation authorization', () => {
  it('hydrates missing and invalid legacy capability values without granting mutation authority', () => {
    assert.equal(User.hydrate({ role: 'admin' }).caseReviewMutationEnabled, false)
    assert.equal(User.hydrate({ role: 'user' }).caseReviewMutationEnabled, false)
    assert.equal(
      User.hydrate({ role: 'admin', caseReviewMutationEnabled: false })
        .caseReviewMutationEnabled,
      false,
    )
    assert.equal(
      User.hydrate({ role: 'admin', caseReviewMutationEnabled: true })
        .caseReviewMutationEnabled,
      true,
    )
    for (const invalid of [null, 'true', 1, {}, []]) {
      assert.notEqual(
        User.hydrate({ role: 'admin', caseReviewMutationEnabled: invalid })
          .caseReviewMutationEnabled,
        true,
      )
    }
  })

  it('reuses Report Review for reads and keeps mutation as a separate capability', () => {
    assert.equal(CASE_REVIEW_PERMISSION, 'reports:review')
    assert.equal(CASE_REVIEW_PERMISSION, REPORT_REVIEW_PERMISSION)
    assert.equal(assertCaseReviewAuthorized, assertReportReviewAuthorized)
    assert.equal(CASE_REVIEW_MUTATION_PERMISSION, 'cases:review')
    assert.notEqual(CASE_REVIEW_MUTATION_PERMISSION, REPORT_REVIEW_PERMISSION)
  })

  it('allows an active Full Admin to read and mutate without reviewer ownership', async () => {
    await assert.doesNotReject(
      assertCaseReviewAuthorized(identity(), evaluatedAt, async () => activeState()),
    )
    await assert.doesNotReject(
      assertCaseReviewMutationAuthorized(identity(), evaluatedAt, async () => activeState()),
    )
    assert.deepEqual(
      await deriveCaseReviewMutationCapabilities(identity(), evaluatedAt, async () => activeState()),
      { reviewCases: true },
    )
  })

  it('allows Reports-only Admin reads but denies mutations by default', async () => {
    const reportsOnly = identity('admin', false)
    await assert.doesNotReject(
      assertCaseReviewAuthorized(reportsOnly, evaluatedAt, async () => activeState()),
    )
    await assert.rejects(
      assertCaseReviewMutationAuthorized(reportsOnly, evaluatedAt, async () => activeState()),
      (error) => error?.status === 403 && error?.code === 'CASE_REVIEW_FORBIDDEN',
    )
    await assert.rejects(
      assertCaseReviewMutationAuthorized(
        { _id: reportsOnly._id, role: 'admin' },
        evaluatedAt,
        async () => activeState(),
      ),
      (error) => error?.status === 403 && error?.code === 'CASE_REVIEW_FORBIDDEN',
    )
  })

  it('applies the same fail-closed rule to Passport-shaped hydrated Admin actors', async () => {
    const passportActor = (capability = Symbol.for('missing')) => {
      const raw = { _id: identity()._id, role: 'admin' }
      if (capability !== Symbol.for('missing')) raw.caseReviewMutationEnabled = capability
      return User.hydrate(raw)
    }

    for (const actor of [
      passportActor(),
      passportActor(false),
      passportActor(null),
      passportActor('true'),
      passportActor(1),
      passportActor({}),
    ]) {
      await assert.doesNotReject(
        assertCaseReviewAuthorized(actor, evaluatedAt, async () => activeState()),
      )
      await assert.rejects(
        assertCaseReviewMutationAuthorized(actor, evaluatedAt, async () => activeState()),
        (error) => error?.status === 403 && error?.code === 'CASE_REVIEW_FORBIDDEN',
      )
    }

    await assert.doesNotReject(
      assertCaseReviewMutationAuthorized(
        passportActor(true),
        evaluatedAt,
        async () => activeState(),
      ),
    )
  })

  it('preserves fail-closed behavior for non-Admin, inactive, or unavailable evidence', async () => {
    const suspendedState = () => ({
      status: 'suspended',
      evaluatedAt,
      governingDecisionId: 'decision-1',
      activeRestrictionDecisionIds: ['decision-1'],
      restrictionEndsAt: new Date('2035-08-02T00:00:00.000Z'),
    })

    await assert.rejects(
      assertCaseReviewAuthorized(identity('user'), evaluatedAt, async () => activeState()),
      (error) => error?.status === 403 && error?.code === 'REPORT_REVIEW_FORBIDDEN',
    )
    await assert.rejects(
      assertCaseReviewAuthorized(identity(), evaluatedAt, async () => suspendedState()),
      (error) => error?.status === 403 && error?.code === 'REPORT_REVIEW_FORBIDDEN',
    )
    await assert.rejects(
      assertCaseReviewAuthorized(identity(), evaluatedAt, async () => {
        throw new Error('ACCOUNT_ENFORCEMENT_HISTORY_INVALID')
      }),
      (error) => error?.status === 403 && error?.code === 'REPORT_REVIEW_FORBIDDEN',
    )
    await assert.rejects(
      assertCaseReviewMutationAuthorized(identity('user'), evaluatedAt, async () => activeState()),
      (error) => error?.status === 403 && error?.code === 'CASE_REVIEW_FORBIDDEN',
    )
  })
})
