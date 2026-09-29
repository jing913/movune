import assert from 'node:assert/strict'
import { after, afterEach, before, describe, it } from 'node:test'
import mongoose, { Types } from 'mongoose'
import { IdentifierClaim } from '../dist/models/identifierClaimModel.js'
import { User } from '../dist/models/userModel.js'
import {
  classifyAmbiguousUserResult,
  runIdentifierClaimBackfill,
} from '../dist/tools/identifierClaimBackfill.js'
import { runIdentifierClaimReconciliation } from '../dist/tools/identifierClaimReconciliation.js'
import { IdentifierMigrationError } from '../dist/tools/identifierClaimMigrationConfig.js'
import { createDatabaseTestHarness } from './helpers/databaseHarness.mjs'

describe('IdentifierClaim migration dedicated-database acceptance', { timeout: 120_000 }, () => {
  const harness = createDatabaseTestHarness()
  const userIds = new Set()
  const claimIds = new Set()
  let sequence = 0
  let prefix

  const rememberClaim = (claim) => {
    claimIds.add(claim._id)
    return claim
  }

  const createUser = async () => {
    sequence += 1
    const user = await User.create({
      account: `${prefix}${sequence}`,
      email: `${prefix}${sequence}@test.invalid`,
      password: 'not-used',
      role: 'user',
    })
    userIds.add(user._id)
    return user
  }

  const createClaim = async (user, kind, overrides = {}) => {
    const claim = await IdentifierClaim.create({
      kind,
      canonicalKey: kind === 'email' ? user.email.toLowerCase() : user.account.toLowerCase(),
      ownerUserId: user._id,
      state: 'active',
      ...overrides,
    })
    return rememberClaim(claim)
  }

  const clearCohort = async () => {
    const ids = [...userIds]
    const explicitClaimIds = [...claimIds]
    if (ids.length > 0) await IdentifierClaim.deleteMany({ ownerUserId: { $in: ids } })
    if (explicitClaimIds.length > 0)
      await IdentifierClaim.deleteMany({ _id: { $in: explicitClaimIds } })
    if (ids.length > 0) await User.deleteMany({ _id: { $in: ids } })
    userIds.clear()
    claimIds.clear()
  }

  before(async () => {
    await harness.connect()
    await harness.prepareIndexes([User, IdentifierClaim])
    prefix = `i3${harness.runId.replaceAll('-', '').slice(0, 6)}`
    harness.registerCleanup(async () => {
      await clearCohort()
      assert.equal(await User.countDocuments({ account: { $regex: `^${prefix}` } }), 0)
      assert.equal(
        await IdentifierClaim.countDocuments({
          $or: [
            { canonicalKey: { $regex: `^${prefix}` } },
            { canonicalKey: { $regex: `^${prefix}@` } },
          ],
        }),
        0,
      )
    })
  })

  afterEach(clearCohort)

  after(async () => {
    try {
      await harness.runCleanup()
    } finally {
      await harness.close()
    }
  })

  it('keeps dry-run at zero writes', async () => {
    await createUser()
    const beforeCount = await IdentifierClaim.countDocuments()
    const result = await runIdentifierClaimBackfill(false)
    assert.equal(result.outcome, 'PENDING')
    assert.equal(result.claimsPending, 2)
    assert.equal(await IdentifierClaim.countDocuments(), beforeCount)
  })

  it('applies both missing Claims as active and reruns idempotently', async () => {
    const user = await createUser()
    const applied = await runIdentifierClaimBackfill(true)
    assert.equal(applied.outcome, 'COMPLETED')
    assert.equal(applied.claimsCompleted, 2)
    const claims = await IdentifierClaim.find({ ownerUserId: user._id }).sort({ kind: 1 }).lean()
    for (const claim of claims) claimIds.add(claim._id)
    assert.equal(claims.length, 2)
    assert.ok(claims.every(({ state }) => state === 'active'))

    const rerun = await runIdentifierClaimBackfill(true)
    assert.equal(rerun.outcome, 'NO_OP')
    assert.equal(rerun.claimsNoOp, 2)
    assert.equal(await IdentifierClaim.countDocuments({ ownerUserId: user._id }), 2)
  })

  it('creates only the missing Claim when one active same-owner Claim exists', async () => {
    const user = await createUser()
    await createClaim(user, 'email')
    const result = await runIdentifierClaimBackfill(true)
    assert.equal(result.outcome, 'COMPLETED')
    assert.equal(result.claimsCompleted, 1)
    assert.equal(result.claimsNoOp, 1)
    const claims = await IdentifierClaim.find({ ownerUserId: user._id }).lean()
    for (const claim of claims) claimIds.add(claim._id)
    assert.equal(claims.length, 2)
  })

  it('stops on a different email owner without creating the username Claim', async () => {
    const target = await createUser()
    const other = await createUser()
    await createClaim(target, 'email', { ownerUserId: other._id })
    await assert.rejects(
      () => runIdentifierClaimBackfill(true),
      (error) => error instanceof IdentifierMigrationError && error.code === 'CLAIM_OWNER_CONFLICT',
    )
    assert.equal(
      await IdentifierClaim.countDocuments({
        kind: 'username',
        canonicalKey: target.account.toLowerCase(),
      }),
      0,
    )
  })

  it('stops on a different username owner without creating the email Claim', async () => {
    const target = await createUser()
    const other = await createUser()
    await createClaim(target, 'username', { ownerUserId: other._id })
    await assert.rejects(
      () => runIdentifierClaimBackfill(true),
      (error) => error instanceof IdentifierMigrationError && error.code === 'CLAIM_OWNER_CONFLICT',
    )
    assert.equal(
      await IdentifierClaim.countDocuments({
        kind: 'email',
        canonicalKey: target.email.toLowerCase(),
      }),
      0,
    )
  })

  it('stops on a reserved same-owner Claim', async () => {
    const user = await createUser()
    await createClaim(user, 'email', { state: 'reserved' })
    await assert.rejects(
      () => runIdentifierClaimBackfill(true),
      (error) => error instanceof IdentifierMigrationError && error.code === 'CLAIM_STATE_CONFLICT',
    )
  })

  it('rolls back the first Claim when the transaction fails before the second create', async () => {
    const user = await createUser()
    await assert.rejects(
      () => runIdentifierClaimBackfill(true, { failurePoint: 'after-email-create' }),
      (error) => error instanceof IdentifierMigrationError && error.outcome === 'RETRYABLE',
    )
    assert.equal(await IdentifierClaim.countDocuments({ ownerUserId: user._id }), 0)
  })

  it('classifies durable partial race states without repairing them', async () => {
    const user = await createUser()
    await createClaim(user, 'email')
    const expected = {
      userId: user._id,
      emailCanonicalKey: user.email.toLowerCase(),
      usernameCanonicalKey: user.account.toLowerCase(),
    }
    await assert.rejects(
      () => classifyAmbiguousUserResult(expected, { email: false, username: false }),
      (error) =>
        error instanceof IdentifierMigrationError &&
        error.code === 'CLAIM_TRANSACTION_IMPOSSIBLE_PARTIAL',
    )
    await assert.rejects(
      () => classifyAmbiguousUserResult(expected, { email: true, username: false }),
      (error) => error instanceof IdentifierMigrationError && error.outcome === 'RETRYABLE',
    )
  })

  it('reconciles complete active ownership to 100% PASS', async () => {
    await createUser()
    await runIdentifierClaimBackfill(true)
    const claims = await IdentifierClaim.find().lean()
    for (const claim of claims) claimIds.add(claim._id)
    const result = await runIdentifierClaimReconciliation()
    assert.equal(result.outcome, 'PASS')
    assert.equal(result.coveragePercent, 100)
    assert.equal(result.missingEmailClaims, 0)
    assert.equal(result.missingUsernameClaims, 0)
  })

  it('reports uniquely missing Claims as PENDING', async () => {
    await createUser()
    const result = await runIdentifierClaimReconciliation()
    assert.equal(result.outcome, 'PENDING')
    assert.equal(result.missingEmailClaims, 1)
    assert.equal(result.missingUsernameClaims, 1)
  })

  it('reports wrong ownership as STOP', async () => {
    const target = await createUser()
    const other = await createUser()
    await createClaim(target, 'email', { ownerUserId: other._id })
    const result = await runIdentifierClaimReconciliation()
    assert.equal(result.outcome, 'STOP')
    assert.equal(result.wrongOwnerClaims, 1)
  })

  it('reports orphan and unexpected Claims as STOP', async () => {
    const user = await createUser()
    const orphan = await IdentifierClaim.create({
      kind: 'email',
      canonicalKey: `${prefix}orphan@test.invalid`,
      ownerUserId: new Types.ObjectId(),
      state: 'active',
    })
    rememberClaim(orphan)
    const unexpected = await IdentifierClaim.create({
      kind: 'username',
      canonicalKey: `${prefix}unexpected`,
      ownerUserId: user._id,
      state: 'active',
    })
    rememberClaim(unexpected)
    const result = await runIdentifierClaimReconciliation()
    assert.equal(result.outcome, 'STOP')
    assert.equal(result.orphanClaims, 1)
    assert.equal(result.unexpectedClaims, 1)
  })

  it('reports incorrect active-state coverage as STOP', async () => {
    const user = await createUser()
    await createClaim(user, 'email', { state: 'reserved' })
    await createClaim(user, 'username')
    const result = await runIdentifierClaimReconciliation()
    assert.equal(result.outcome, 'STOP')
    assert.equal(result.incorrectStateClaims, 1)
  })
})
