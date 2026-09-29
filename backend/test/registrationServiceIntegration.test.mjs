import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { compare } from 'bcrypt'
import mongoose, { Types } from 'mongoose'
import { IdentifierClaim } from '../dist/models/identifierClaimModel.js'
import { User } from '../dist/models/userModel.js'
import {
  RegistrationConflictError,
  createRegistrationService,
  registerUser,
} from '../dist/services/registrationService.js'
import {
  canonicalizeEmailIdentifier,
  canonicalizeUsernameIdentifier,
} from '../dist/utils/identifierPolicy.js'
import { createDatabaseTestHarness } from './helpers/databaseHarness.mjs'

describe('Claim-aware registration dedicated-database acceptance', { timeout: 120_000 }, () => {
  const harness = createDatabaseTestHarness()
  const accounts = new Set()
  const emails = new Set()
  const canonicalKeys = new Set()
  let sequence = 0
  let prefix

  const remember = (value) => {
    accounts.add(canonicalizeUsernameIdentifier(value.account).representation)
    emails.add(canonicalizeEmailIdentifier(value.email).representation)
    canonicalKeys.add(canonicalizeUsernameIdentifier(value.account).canonicalKey)
    canonicalKeys.add(canonicalizeEmailIdentifier(value.email).canonicalKey)
    return value
  }

  const registration = (label, overrides = {}) => {
    sequence += 1
    return remember({
      account: `${label}${prefix}${sequence}`,
      email: `${label}-${prefix}-${sequence}@test.invalid`,
      password: 'password123',
      ...overrides,
    })
  }

  const userCohortFilter = () => ({
    $or: [{ account: { $in: [...accounts] } }, { email: { $in: [...emails] } }],
  })
  const claimCohortFilter = () => ({ canonicalKey: { $in: [...canonicalKeys] } })

  const assertNoRegistration = async (value) => {
    const email = canonicalizeEmailIdentifier(value.email)
    const username = canonicalizeUsernameIdentifier(value.account)
    assert.equal(
      await User.countDocuments({
        $or: [{ email: email.representation }, { account: username.representation }],
      }),
      0,
    )
    assert.equal(
      await IdentifierClaim.countDocuments({
        canonicalKey: { $in: [email.canonicalKey, username.canonicalKey] },
      }),
      0,
    )
  }

  before(async () => {
    await harness.connect()
    await harness.prepareIndexes([User, IdentifierClaim])
    prefix = harness.runId.replaceAll('-', '').slice(0, 6)
    harness.registerCleanup(async () => {
      if (canonicalKeys.size > 0) await IdentifierClaim.deleteMany(claimCohortFilter())
      if (accounts.size > 0) await User.deleteMany(userCohortFilter())
      assert.equal(await IdentifierClaim.countDocuments(claimCohortFilter()), 0)
      assert.equal(await User.countDocuments(userCohortFilter()), 0)
    })
  })

  after(async () => {
    try {
      if (harness.ready) await harness.runCleanup()
    } finally {
      await harness.close()
    }
  })

  it('atomically creates one User and two active Claims with locked representations', async () => {
    const value = registration('ok', {
      account: `Jose\u0301${prefix}${sequence}`,
      email: `  Mixed.Case-${prefix}-${sequence}@Example.COM  `,
    })
    const email = canonicalizeEmailIdentifier(value.email)
    const username = canonicalizeUsernameIdentifier(value.account)

    const result = await registerUser(value)
    const user = await User.findById(result.userId).select('+password').lean()
    const claims = await IdentifierClaim.find({ ownerUserId: result.userId })
      .sort({ kind: 1 })
      .lean()

    assert.ok(user)
    assert.equal(user.email, email.representation)
    assert.equal(user.account, username.representation)
    assert.notEqual(user.password, value.password)
    assert.equal(await compare(value.password, user.password), true)
    assert.deepEqual(
      claims.map(({ kind, canonicalKey, ownerUserId, state }) => ({
        kind,
        canonicalKey,
        ownerUserId: ownerUserId.toString(),
        state,
      })),
      [
        {
          kind: 'email',
          canonicalKey: email.canonicalKey,
          ownerUserId: user._id.toString(),
          state: 'active',
        },
        {
          kind: 'username',
          canonicalKey: username.canonicalKey,
          ownerUserId: user._id.toString(),
          state: 'active',
        },
      ],
    )
  })

  it('maps an email Claim conflict and leaves no User or username Claim', async () => {
    const value = registration('ec')
    const emailKey = canonicalizeEmailIdentifier(value.email).canonicalKey
    await IdentifierClaim.create({
      kind: 'email',
      canonicalKey: emailKey,
      ownerUserId: new Types.ObjectId(),
      state: 'active',
    })

    await assert.rejects(
      () => registerUser(value),
      (error) =>
        error instanceof RegistrationConflictError && error.code === 'REGISTRATION_EMAIL_CONFLICT',
    )
    assert.equal(await User.countDocuments({ account: value.account }), 0)
    assert.equal(
      await IdentifierClaim.countDocuments({
        kind: 'username',
        canonicalKey: canonicalizeUsernameIdentifier(value.account).canonicalKey,
      }),
      0,
    )
  })

  it('rolls back the email Claim when the username Claim conflicts', async () => {
    const value = registration('uc')
    const usernameKey = canonicalizeUsernameIdentifier(value.account).canonicalKey
    await IdentifierClaim.create({
      kind: 'username',
      canonicalKey: usernameKey,
      ownerUserId: new Types.ObjectId(),
      state: 'active',
    })

    await assert.rejects(
      () => registerUser(value),
      (error) =>
        error instanceof RegistrationConflictError &&
        error.code === 'REGISTRATION_ACCOUNT_CONFLICT',
    )
    assert.equal(await User.countDocuments({ email: value.email }), 0)
    assert.equal(
      await IdentifierClaim.countDocuments({
        kind: 'email',
        canonicalKey: canonicalizeEmailIdentifier(value.email).canonicalKey,
      }),
      0,
    )
  })

  it('rolls back both Claims on legacy User email and account index conflicts', async () => {
    for (const field of ['email', 'account']) {
      const existing = registration(`l${field[0]}`)
      await User.create(existing)
      const candidate = registration(`n${field[0]}`, { [field]: existing[field] })

      await assert.rejects(
        () => registerUser(candidate),
        (error) => error instanceof RegistrationConflictError && error.field === field,
      )
      assert.equal(
        await IdentifierClaim.countDocuments({
          canonicalKey: {
            $in: [
              canonicalizeEmailIdentifier(candidate.email).canonicalKey,
              canonicalizeUsernameIdentifier(candidate.account).canonicalKey,
            ],
          },
        }),
        0,
      )
    }
  })

  it('allows one owner for concurrent registrations sharing a canonical email', async () => {
    const first = registration('ce')
    const second = registration('ce', { email: first.email.toUpperCase() })
    const results = await Promise.allSettled([registerUser(first), registerUser(second)])
    const fulfilled = results.filter(({ status }) => status === 'fulfilled')
    const rejected = results.filter(({ status }) => status === 'rejected')

    assert.equal(fulfilled.length, 1)
    assert.equal(rejected.length, 1)
    assert.equal(rejected[0].reason.code, 'REGISTRATION_EMAIL_CONFLICT')
    const ownerId = fulfilled[0].value.userId
    assert.equal(
      await IdentifierClaim.countDocuments({
        kind: 'email',
        canonicalKey: canonicalizeEmailIdentifier(first.email).canonicalKey,
        ownerUserId: ownerId,
      }),
      1,
    )
    assert.equal(await User.countDocuments({ _id: ownerId }), 1)
    assert.equal(await IdentifierClaim.countDocuments({ ownerUserId: ownerId }), 2)
  })

  it('allows one owner for concurrent canonical-equivalent usernames', async () => {
    const first = registration('cu', { account: `Jos\u00e9${prefix}${sequence}` })
    const second = registration('cu', { account: `Jose\u0301${prefix}${sequence - 1}` })
    assert.equal(
      canonicalizeUsernameIdentifier(first.account).canonicalKey,
      canonicalizeUsernameIdentifier(second.account).canonicalKey,
    )
    const results = await Promise.allSettled([registerUser(first), registerUser(second)])
    const fulfilled = results.filter(({ status }) => status === 'fulfilled')
    const rejected = results.filter(({ status }) => status === 'rejected')

    assert.equal(fulfilled.length, 1)
    assert.equal(rejected.length, 1)
    assert.equal(rejected[0].reason.code, 'REGISTRATION_ACCOUNT_CONFLICT')
    const ownerId = fulfilled[0].value.userId
    assert.equal(await User.countDocuments({ _id: ownerId }), 1)
    assert.equal(await IdentifierClaim.countDocuments({ ownerUserId: ownerId }), 2)
  })

  it('rolls back fully after either Claim boundary', async () => {
    for (const failureKind of ['email', 'username']) {
      const value = registration(`f${failureKind[0]}`)
      const failure = new Error(`failure-after-${failureKind}`)
      const service = createRegistrationService({
        afterClaimCreated: (kind) => {
          if (kind === failureKind) throw failure
        },
      })

      await assert.rejects(
        () => service(value),
        (error) => error === failure,
      )
      await assertNoRegistration(value)
    }
  })

  it('uses fresh User documents and avoids double hashing on an internal transaction retry', async () => {
    const value = registration('rt')
    const documents = []
    let attempts = 0
    const service = createRegistrationService({
      transactionRunner: (operation) =>
        mongoose.connection.transaction(async (session) => {
          await operation(session)
          attempts += 1
          if (attempts === 1) {
            const error = new mongoose.mongo.MongoServerError({
              errmsg: 'injected transient transaction failure',
              code: 112,
              codeName: 'WriteConflict',
            })
            error.addErrorLabel('TransientTransactionError')
            throw error
          }
        }),
      createUserDocument: (source) => {
        const document = new User(source)
        documents.push(document)
        return document
      },
    })

    const result = await service(value)
    const stored = await User.findById(result.userId).select('+password').lean()

    assert.equal(attempts, 2)
    assert.equal(documents.length, 2)
    assert.notEqual(documents[0], documents[1])
    assert.equal(documents[0]._id.toString(), result.userId.toString())
    assert.equal(documents[1]._id.toString(), result.userId.toString())
    assert.equal(await compare(value.password, documents[0].password), true)
    assert.equal(await compare(value.password, documents[1].password), true)
    assert.ok(stored)
    assert.equal(await compare(value.password, stored.password), true)
    assert.equal(await compare(documents[0].password, stored.password), false)
  })
})
