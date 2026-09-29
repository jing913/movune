import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Types } from 'mongoose'
import {
  RegistrationConflictError,
  createRegistrationService,
} from '../dist/services/registrationService.js'
import { IdentifierPolicyError } from '../dist/utils/identifierPolicy.js'

const input = (overrides = {}) => ({
  account: 'Member_01',
  email: 'Member@Example.com',
  password: 'password123',
  ...overrides,
})

const duplicate = (keyPattern) => Object.assign(new Error('duplicate'), { code: 11000, keyPattern })

const captureWrites = (overrides = {}) => {
  const claims = []
  const users = []
  const session = { name: 'test-session' }
  const service = createRegistrationService({
    transactionRunner: async (operation) => operation(session),
    createClaim: async (claim, receivedSession) => {
      assert.equal(receivedSession, session)
      claims.push(claim)
    },
    createUserDocument: (user) => {
      const document = {
        source: user,
        async save({ session: receivedSession }) {
          assert.equal(receivedSession, session)
        },
      }
      users.push(document)
      return document
    },
    ...overrides,
  })
  return { service, claims, users, session }
}

const expectConflict = async (operation, field, code, message) => {
  await assert.rejects(
    operation,
    (error) =>
      error instanceof RegistrationConflictError &&
      error.field === field &&
      error.code === code &&
      error.message === message,
  )
}

describe('Claim-aware registration service', () => {
  it('uses one canonicalization result for stored representations and Claim keys', async () => {
    const fixedId = new Types.ObjectId()
    const { service, claims, users } = captureWrites({ generateUserId: () => fixedId })

    const result = await service(
      input({ account: 'Jose\u0301_01', email: '  Mixed.Case+Tag@Example.COM  ' }),
    )

    assert.equal(result.userId, fixedId)
    assert.deepEqual(
      claims.map(({ kind, canonicalKey, ownerUserId, state }) => ({
        kind,
        canonicalKey,
        ownerUserId,
        state,
      })),
      [
        {
          kind: 'email',
          canonicalKey: 'mixed.case+tag@example.com',
          ownerUserId: fixedId,
          state: 'active',
        },
        {
          kind: 'username',
          canonicalKey: 'jos\u00e9_01',
          ownerUserId: fixedId,
          state: 'active',
        },
      ],
    )
    assert.deepEqual(users[0].source, {
      _id: fixedId,
      account: 'Jos\u00e9_01',
      email: 'Mixed.Case+Tag@Example.COM',
      password: 'password123',
    })
  })

  it('keeps one ObjectId but creates a fresh plaintext User document on callback rerun', async () => {
    const fixedId = new Types.ObjectId()
    const users = []
    const sessions = [{ attempt: 1 }, { attempt: 2 }]
    const service = createRegistrationService({
      generateUserId: () => fixedId,
      transactionRunner: async (operation) => {
        await operation(sessions[0])
        await operation(sessions[1])
      },
      createClaim: async () => undefined,
      createUserDocument: (source) => {
        const document = { source, save: async () => undefined }
        users.push(document)
        return document
      },
    })

    await service(input())

    assert.equal(users.length, 2)
    assert.notEqual(users[0], users[1])
    assert.notEqual(users[0].source, users[1].source)
    assert.equal(users[0].source._id, fixedId)
    assert.equal(users[1].source._id, fixedId)
    assert.equal(users[0].source.password, 'password123')
    assert.equal(users[1].source.password, 'password123')
  })

  it('classifies email and username Claim duplicates by their exact write operation', async () => {
    for (const [failingKind, field, code, message] of [
      ['email', 'email', 'REGISTRATION_EMAIL_CONFLICT', 'Email already exists'],
      ['username', 'account', 'REGISTRATION_ACCOUNT_CONFLICT', 'Account already exists'],
    ]) {
      const { service } = captureWrites({
        createClaim: async ({ kind }) => {
          if (kind === failingKind) throw duplicate({ kind: 1, canonicalKey: 1 })
        },
      })
      await expectConflict(() => service(input()), field, code, message)
    }
  })

  it('maps only exact legacy User email and account duplicate key patterns', async () => {
    for (const [keyPattern, field, code, message] of [
      [{ email: 1 }, 'email', 'REGISTRATION_EMAIL_CONFLICT', 'Email already exists'],
      [{ account: 1 }, 'account', 'REGISTRATION_ACCOUNT_CONFLICT', 'Account already exists'],
    ]) {
      const { service } = captureWrites({
        createUserDocument: () => ({
          save: async () => {
            throw duplicate(keyPattern)
          },
        }),
      })
      await expectConflict(() => service(input()), field, code, message)
    }
  })

  it('does not guess an unknown duplicate-key source', async () => {
    const unexpected = duplicate({ role: 1 })
    const { service } = captureWrites({
      createUserDocument: () => ({
        save: async () => {
          throw unexpected
        },
      }),
    })

    await assert.rejects(
      () => service(input()),
      (error) => error === unexpected,
    )
  })

  it('keeps identifier-policy failures as domain validation failures before a transaction', async () => {
    let transactionCalls = 0
    const { service } = captureWrites({
      transactionRunner: async () => {
        transactionCalls += 1
      },
    })

    await assert.rejects(
      () => service(input({ account: 'invalid name' })),
      (error) => error instanceof IdentifierPolicyError && error.code === 'IDENTIFIER_INVALID',
    )
    assert.equal(transactionCalls, 0)
  })

  it('propagates exhausted transaction failures without retry or success read-back', async () => {
    const infrastructureFailure = new Error('transaction outcome unknown')
    let transactionCalls = 0
    const { service } = captureWrites({
      transactionRunner: async () => {
        transactionCalls += 1
        throw infrastructureFailure
      },
    })

    await assert.rejects(
      () => service(input()),
      (error) => error === infrastructureFailure,
    )
    assert.equal(transactionCalls, 1)
  })
})
