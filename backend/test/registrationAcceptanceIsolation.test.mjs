import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { Types } from 'mongoose'
import {
  P7_EXECUTION_ACKNOWLEDGEMENT,
  P7_LEAST_PRIVILEGE_CONTRACT,
  RegistrationAcceptanceIsolationError,
  validateP7TargetConfiguration,
} from '../dist/tools/registrationAcceptanceIsolatedConfiguration.js'
import { verifyP7Infrastructure } from '../dist/tools/registrationAcceptanceIsolatedRuntime.js'
import { runIdentifierClaimReconciliation } from '../dist/tools/identifierClaimReconciliation.js'
import {
  parseP7CliOperation,
  runP7IsolatedOperation,
} from '../dist/tools/runRegistrationAcceptanceIsolated.js'
import {
  parseP7VerificationInput,
  verifyP7Evidence,
} from '../dist/tools/runRegistrationAcceptanceProductionVerification.js'
import { createRegistrationAcceptanceFixtureBinding } from '../dist/utils/registrationAcceptanceManifest.js'
import {
  canonicalizeEmailIdentifier,
  canonicalizeUsernameIdentifier,
} from '../dist/utils/identifierPolicy.js'

const uri = [
  'mongodb',
  '://',
  'p7_test_runner',
  ':',
  'not-a-secret',
  '@ac-gqcm0hd-shard-00-00.ndbtzal.mongodb.net:27017/',
  'movune_phase9_test?tls=true&replicaSet=atlas-test&authSource=admin',
].join('')

const targetEnvironment = () => ({
  MOVUNE_P7_DB_URL: uri,
  MOVUNE_P7_DB_NAME: 'movune_phase9_test',
  MOVUNE_P7_EXPECTED_USERNAME: 'p7_test_runner',
  MOVUNE_P7_TARGET_ID: 'safe-target-id',
  MOVUNE_P7_TARGET_PROFILE: 'dedicated-test',
  MOVUNE_P7_ENVIRONMENT: 'production',
  MOVUNE_P7_RENDER_SERVICE_ID: 'srv-movune-test',
  MOVUNE_P7_RELEASE_SHA: 'a'.repeat(40),
})

const verificationEnvironment = () =>
  Object.fromEntries(
    Object.entries(targetEnvironment()).map(([name, value]) => [
      name.replace('MOVUNE_P7_', 'MOVUNE_P7_VERIFY_'),
      value,
    ]),
  )

const stopped = (operation, code) =>
  assert.throws(operation, (error) => {
    assert.ok(error instanceof RegistrationAcceptanceIsolationError)
    assert.equal(error.code, code)
    return true
  })

const fakeConnection = ({ collection = true, index = 'valid' } = {}) => ({
  db: {
    databaseName: 'movune_phase9_test',
    admin: () => ({
      command: async () => ({
        isWritablePrimary: true,
        setName: 'safe-test-rs',
        logicalSessionTimeoutMinutes: 30,
      }),
    }),
    collection: (name) => ({
      findOne: async () =>
        name === '__movune_test_target'
          ? {
              _id: 'movune-phase9-test-target',
              targetId: 'safe-target-id',
              purpose: 'movune-phase9-test',
            }
          : null,
      listIndexes: () => ({
        toArray: async () => [
          { name: '_id_', key: { _id: 1 } },
          index === 'valid'
            ? { name: 'consumedOperationIds_1', key: { consumedOperationIds: 1 }, unique: true }
            : { name: 'consumedOperationIds_1', key: { consumedOperationIds: 1 }, unique: false },
        ],
      }),
    }),
    listCollections: () => ({
      toArray: async () => (collection ? [{ name: 'registrationacceptanceruns' }] : []),
    }),
  },
})

const success = {
  account: 'p7isolation01',
  email: 'p7-isolation-success@example.invalid',
  password: 'non-production-password',
}
const conflict = {
  account: success.account.toUpperCase(),
  email: 'p7-isolation-conflict@example.invalid',
  password: 'different-non-production-password',
}

const query = (value) => ({
  select() {
    return this
  },
  lean: async () => value,
})

const evidenceModels = (overrides = {}) => {
  const userId = '507f1f77bcf86cd799439011'
  const username = canonicalizeUsernameIdentifier(success.account)
  const email = canonicalizeEmailIdentifier(success.email)
  const run = {
    _id: 'run_isolation_test',
    environment: 'production',
    serviceId: 'srv-movune-test',
    releaseSha: 'a'.repeat(40),
    state: 'conflict_verified',
    fixtureUserId: userId,
    successBinding: createRegistrationAcceptanceFixtureBinding(success),
    conflictBinding: createRegistrationAcceptanceFixtureBinding(conflict),
    auditEvents: [{ outcome: 'success_completed' }, { outcome: 'conflict_verified' }],
    ...overrides.run,
  }
  const users = [
    {
      _id: userId,
      account: username.representation,
      email: email.representation,
      role: 'user',
      favoritesPublic: false,
      messageRequestPreference: 'all_members',
      ...overrides.user,
    },
  ]
  const claims = [
    {
      kind: 'email',
      canonicalKey: email.canonicalKey,
      ownerUserId: userId,
      state: 'active',
      ...overrides.emailClaim,
    },
    {
      kind: 'username',
      canonicalKey: username.canonicalKey,
      ownerUserId: userId,
      state: 'active',
      ...overrides.usernameClaim,
    },
  ]
  return {
    RegistrationAcceptanceRun: { findById: () => ({ lean: async () => run }) },
    User: {
      find: () => query(users),
      countDocuments: async () => overrides.conflictUsers ?? 0,
    },
    IdentifierClaim: {
      find: () => query(claims),
      countDocuments: async () => overrides.conflictClaims ?? 0,
    },
  }
}

describe('P7 isolated configuration and execution boundary', () => {
  it('requires only the isolated URI and never falls back to DB_URL', () => {
    const base = targetEnvironment()
    assert.equal(
      validateP7TargetConfiguration(base, 'MOVUNE_P7').databaseName,
      'movune_phase9_test',
    )
    const { MOVUNE_P7_DB_URL: _removed, ...missing } = base
    stopped(() => validateP7TargetConfiguration(missing, 'MOVUNE_P7'), 'P7_DB_URL_REQUIRED')
    stopped(
      () => validateP7TargetConfiguration({ ...base, DB_URL: '' }, 'MOVUNE_P7'),
      'APPLICATION_DB_URL_PRESENT',
    )
  })

  it('fails closed for wrong database, username, cluster, and target profile', () => {
    const base = targetEnvironment()
    stopped(
      () => validateP7TargetConfiguration({ ...base, MOVUNE_P7_DB_NAME: 'test' }, 'MOVUNE_P7'),
      'P7_DB_NAME_INVALID_FOR_PROFILE',
    )
    stopped(
      () =>
        validateP7TargetConfiguration(
          { ...base, MOVUNE_P7_EXPECTED_USERNAME: 'wrong' },
          'MOVUNE_P7',
        ),
      'P7_DB_USERNAME_MISMATCH',
    )
    stopped(
      () =>
        validateP7TargetConfiguration(
          { ...base, MOVUNE_P7_DB_URL: uri.replace('ndbtzal.mongodb.net', 'example.invalid') },
          'MOVUNE_P7',
        ),
      'P7_CLUSTER_IDENTITY_MISMATCH',
    )
    stopped(
      () =>
        validateP7TargetConfiguration(
          { ...base, MOVUNE_P7_TARGET_PROFILE: 'arbitrary' },
          'MOVUNE_P7',
        ),
      'P7_TARGET_PROFILE_INVALID',
    )
  })

  it('has no default or combined mutating operation', () => {
    assert.equal(parseP7CliOperation(['prepare']), 'prepare')
    assert.equal(parseP7CliOperation(['preflight']), 'preflight')
    stopped(() => parseP7CliOperation([]), 'P7_CLI_INVALID')
    stopped(() => parseP7CliOperation(['run-all']), 'P7_CLI_INVALID')
    stopped(() => parseP7CliOperation(['success', 'conflict']), 'P7_CLI_INVALID')
  })

  it('defines normal P7 writes without delete or DDL privileges', () => {
    assert.deepEqual(P7_LEAST_PRIVILEGE_CONTRACT.actions.normalWrite, ['insert', 'update'])
    assert.deepEqual(P7_LEAST_PRIVILEGE_CONTRACT.deleteForNormalOperations, [])
    assert.ok(P7_LEAST_PRIVILEGE_CONTRACT.actions.explicitlyExcluded.includes('remove'))
    assert.ok(P7_LEAST_PRIVILEGE_CONTRACT.actions.explicitlyExcluded.includes('createIndex'))
  })

  it('requires the execution acknowledgement before opening a database connection', async () => {
    let opened = false
    await assert.rejects(
      () =>
        runP7IsolatedOperation('prepare', targetEnvironment(), async () => {
          opened = true
          return fakeConnection()
        }),
      (error) =>
        error instanceof RegistrationAcceptanceIsolationError &&
        error.code === 'P7_EXECUTION_ACK_REQUIRED',
    )
    assert.equal(opened, false)
    assert.equal(P7_EXECUTION_ACKNOWLEDGEMENT, 'movune-phase9-p7-controlled-acceptance')
  })

  it('imports a process-local worker without an HTTP or Socket.IO startup path', async () => {
    const source = await readFile(
      new URL('../src/tools/runRegistrationAcceptanceIsolated.ts', import.meta.url),
      'utf8',
    )
    assert.equal(source.includes("from 'express'"), false)
    assert.equal(source.includes('.listen('), false)
    assert.equal(source.includes('Socket'), false)
  })
})

describe('P7 read-only infrastructure preflight', () => {
  const configuration = () => validateP7TargetConfiguration(targetEnvironment(), 'MOVUNE_P7')

  it('accepts the exact existing collection and unique operation index', async () => {
    const result = await verifyP7Infrastructure(fakeConnection(), configuration())
    assert.equal(result.acceptanceCollection, 'PASS')
    assert.equal(result.operationIndex, 'PASS')
  })

  it('fails closed when the collection is absent', async () => {
    await assert.rejects(
      () => verifyP7Infrastructure(fakeConnection({ collection: false }), configuration()),
      (error) =>
        error instanceof RegistrationAcceptanceIsolationError &&
        error.code === 'P7_ACCEPTANCE_COLLECTION_MISSING',
    )
  })

  it('fails closed when the server-side target marker does not match', async () => {
    const wrongTarget = {
      ...targetEnvironment(),
      MOVUNE_P7_TARGET_ID: 'wrong-target-id',
    }
    await assert.rejects(
      () =>
        verifyP7Infrastructure(
          fakeConnection(),
          validateP7TargetConfiguration(wrongTarget, 'MOVUNE_P7'),
        ),
      (error) =>
        error instanceof RegistrationAcceptanceIsolationError &&
        error.code === 'P7_TARGET_MARKER_MISMATCH',
    )
  })

  it('fails closed when the unique operation index is wrong', async () => {
    await assert.rejects(
      () => verifyP7Infrastructure(fakeConnection({ index: 'wrong' }), configuration()),
      (error) =>
        error instanceof RegistrationAcceptanceIsolationError &&
        error.code === 'P7_ACCEPTANCE_INDEX_MISMATCH',
    )
  })
})

describe('P7 independent read-only evidence verifier', () => {
  const configuration = () => validateP7TargetConfiguration(targetEnvironment(), 'MOVUNE_P7')
  const input = { runId: 'run_isolation_test', success, conflict }

  it('uses only reads and emits sanitized exact ownership evidence', async () => {
    const result = await verifyP7Evidence({}, configuration(), input, evidenceModels())
    assert.equal(result.outcome, 'PASS')
    assert.equal(result.success.commonOwner, true)
    assert.equal(result.conflict.userResidueCount, 0)
    const output = JSON.stringify(result)
    for (const value of [success.account, success.email, success.password, conflict.email]) {
      assert.equal(output.includes(value), false)
    }
  })

  for (const [name, overrides, code] of [
    [
      'wrong owner',
      { usernameClaim: { ownerUserId: '507f191e810c19729de860ea' } },
      'P7_VERIFY_CLAIM_OWNERSHIP_INVALID',
    ],
    ['incorrect state', { emailClaim: { state: 'reserved' } }, 'P7_VERIFY_CLAIM_OWNERSHIP_INVALID'],
    [
      'wrong canonical key',
      { usernameClaim: { canonicalKey: 'wrong' } },
      'P7_VERIFY_CLAIM_OWNERSHIP_INVALID',
    ],
    ['conflict User residue', { conflictUsers: 1 }, 'P7_VERIFY_CONFLICT_RESIDUE_PRESENT'],
    ['conflict Claim residue', { conflictClaims: 1 }, 'P7_VERIFY_CONFLICT_RESIDUE_PRESENT'],
    ['wrong release', { run: { releaseSha: 'b'.repeat(40) } }, 'P7_VERIFY_RUN_SCOPE_INVALID'],
    [
      'wrong durable fixture owner',
      { run: { fixtureUserId: '507f191e810c19729de860ea' } },
      'P7_VERIFY_USER_STATE_INVALID',
    ],
  ]) {
    it(`detects ${name}`, async () => {
      await assert.rejects(
        () => verifyP7Evidence({}, configuration(), input, evidenceModels(overrides)),
        (error) => error instanceof RegistrationAcceptanceIsolationError && error.code === code,
      )
    })
  }

  it('forbids the mutating acknowledgement in the read-only verifier', () => {
    const environment = {
      ...verificationEnvironment(),
      MOVUNE_P7_EXECUTION_ACK: P7_EXECUTION_ACKNOWLEDGEMENT,
      MOVUNE_P7_VERIFY_EVIDENCE_JSON: JSON.stringify(input),
    }
    stopped(() => parseP7VerificationInput(environment), 'P7_EXECUTION_ACK_FORBIDDEN_FOR_VERIFIER')
  })
})

describe('P7 reconciliation compatibility', () => {
  const cursorQuery = (values) => ({
    select() {
      return this
    },
    sort() {
      return this
    },
    lean() {
      return this
    },
    cursor() {
      return (async function* () {
        for (const value of values) yield value
      })()
    },
  })

  it('recognizes one Stage 4 User plus the migrated baseline as 19 Users and 38 active Claims', async () => {
    const users = Array.from({ length: 19 }, (_, index) => ({
      _id: new Types.ObjectId(),
      account: `p7parity${index}`,
      email: `p7-parity-${index}@example.invalid`,
    }))
    const claims = users.flatMap((user) => [
      {
        kind: 'email',
        canonicalKey: canonicalizeEmailIdentifier(user.email).canonicalKey,
        ownerUserId: user._id,
        state: 'active',
      },
      {
        kind: 'username',
        canonicalKey: canonicalizeUsernameIdentifier(user.account).canonicalKey,
        ownerUserId: user._id,
        state: 'active',
      },
    ])
    const result = await runIdentifierClaimReconciliation({
      userModel: { find: () => cursorQuery(users) },
      claimModel: { find: () => cursorQuery(claims) },
    })
    assert.deepEqual(result, {
      outcome: 'PASS',
      usersExamined: 19,
      requiredEmailClaims: 19,
      requiredUsernameClaims: 19,
      matchedEmailClaims: 19,
      matchedUsernameClaims: 19,
      missingEmailClaims: 0,
      missingUsernameClaims: 0,
      wrongOwnerClaims: 0,
      incorrectStateClaims: 0,
      duplicateNamespaceGroups: 0,
      duplicateNamespaceDocuments: 0,
      orphanClaims: 0,
      unexpectedClaims: 0,
      invalidClaims: 0,
      coveragePercent: 100,
    })
  })
})
