import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Types } from 'mongoose'
import {
  IDENTIFIER_MIGRATION_ACK,
  IDENTIFIER_MIGRATION_APPLY_ACK,
  IdentifierMigrationError,
  exitCodeForOutcome,
  parseIdentifierMigrationCli,
  validateIdentifierMigrationConfiguration,
} from '../dist/tools/identifierClaimMigrationConfig.js'
import {
  classifyAmbiguousUserResult,
  classifyStoredClaim,
  outcomePriority,
  scanEligibleUsers,
} from '../dist/tools/identifierClaimBackfill.js'

const loopbackEnvironment = (overrides = {}) => ({
  MOVUNE_IDENTIFIER_MIGRATION_DB_URL: 'mongodb://127.0.0.1:27017/movune_migration_test',
  MOVUNE_IDENTIFIER_MIGRATION_DB_NAME: 'movune_migration_test',
  MOVUNE_IDENTIFIER_MIGRATION_TARGET_ID: 'opaque-test-target',
  MOVUNE_IDENTIFIER_MIGRATION_ACK: IDENTIFIER_MIGRATION_ACK,
  ...overrides,
})

const remoteEnvironment = (overrides = {}) => ({
  MOVUNE_IDENTIFIER_MIGRATION_DB_URL:
    'mongodb://migration_user:test-only-password@db.example.test:27017/movune?tls=true',
  MOVUNE_IDENTIFIER_MIGRATION_DB_NAME: 'movune',
  MOVUNE_IDENTIFIER_MIGRATION_TARGET_ID: 'opaque-test-target',
  MOVUNE_IDENTIFIER_MIGRATION_EXPECTED_USERNAME: 'migration_user',
  MOVUNE_IDENTIFIER_MIGRATION_ACK: IDENTIFIER_MIGRATION_ACK,
  ...overrides,
})

const expectCode = (operation, code) => {
  assert.throws(
    operation,
    (error) => error instanceof IdentifierMigrationError && error.code === code,
  )
}

const queryModel = (users) => ({
  find: () => ({
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
        for (const user of users) yield user
      })()
    },
  }),
})

const claimModel = (claims) => ({
  findOne(filter) {
    const value = claims[filter.kind] ?? null
    return {
      select() {
        return this
      },
      lean() {
        return this
      },
      session() {
        return this
      },
      then(resolve, reject) {
        return Promise.resolve(value).then(resolve, reject)
      },
    }
  },
})

describe('IdentifierClaim migration CLI and configuration', () => {
  it('accepts exactly the frozen command surface', () => {
    assert.deepEqual(parseIdentifierMigrationCli(['backfill']), {
      operation: 'backfill',
      mode: 'dry-run',
      apply: false,
    })
    assert.deepEqual(parseIdentifierMigrationCli(['backfill', '--apply']), {
      operation: 'backfill',
      mode: 'apply',
      apply: true,
    })
    assert.deepEqual(parseIdentifierMigrationCli(['reconcile']), {
      operation: 'reconcile',
      mode: 'read-only',
      apply: false,
    })
  })

  it('rejects omitted, unknown, duplicate, extra, and reconcile write arguments', () => {
    for (const args of [
      [],
      ['unknown'],
      ['backfill', '--apply', '--apply'],
      ['backfill', '--unknown'],
      ['backfill', 'extra'],
      ['reconcile', '--apply'],
      ['reconcile', 'extra'],
    ]) {
      expectCode(() => parseIdentifierMigrationCli(args), 'CLI_INVALID')
    }
  })

  it('requires the general acknowledgement in every mode', () => {
    for (const cli of [
      parseIdentifierMigrationCli(['backfill']),
      parseIdentifierMigrationCli(['reconcile']),
    ]) {
      expectCode(
        () =>
          validateIdentifierMigrationConfiguration(
            loopbackEnvironment({ MOVUNE_IDENTIFIER_MIGRATION_ACK: undefined }),
            cli,
          ),
        'MIGRATION_ACK_REQUIRED',
      )
      expectCode(
        () =>
          validateIdentifierMigrationConfiguration(
            loopbackEnvironment({ MOVUNE_IDENTIFIER_MIGRATION_ACK: 'wrong' }),
            cli,
          ),
        'MIGRATION_ACK_INVALID',
      )
    }
  })

  it('requires both --apply and the exact apply acknowledgement', () => {
    const dryRun = parseIdentifierMigrationCli(['backfill'])
    const reconcile = parseIdentifierMigrationCli(['reconcile'])
    const apply = parseIdentifierMigrationCli(['backfill', '--apply'])
    for (const cli of [dryRun, reconcile]) {
      expectCode(
        () =>
          validateIdentifierMigrationConfiguration(
            loopbackEnvironment({ MOVUNE_IDENTIFIER_MIGRATION_APPLY_ACK: '' }),
            cli,
          ),
        'MIGRATION_APPLY_ACK_FORBIDDEN',
      )
    }
    expectCode(
      () => validateIdentifierMigrationConfiguration(loopbackEnvironment(), apply),
      'MIGRATION_APPLY_ACK_REQUIRED',
    )
    expectCode(
      () =>
        validateIdentifierMigrationConfiguration(
          loopbackEnvironment({ MOVUNE_IDENTIFIER_MIGRATION_APPLY_ACK: 'wrong' }),
          apply,
        ),
      'MIGRATION_APPLY_ACK_INVALID',
    )
    assert.equal(
      validateIdentifierMigrationConfiguration(
        loopbackEnvironment({
          MOVUNE_IDENTIFIER_MIGRATION_APPLY_ACK: IDENTIFIER_MIGRATION_APPLY_ACK,
        }),
        apply,
      ).databaseName,
      'movune_migration_test',
    )
  })

  it('rejects DB_URL by presence, including an empty value', () => {
    const cli = parseIdentifierMigrationCli(['backfill'])
    for (const value of ['', 'mongodb://application.invalid/test']) {
      expectCode(
        () => validateIdentifierMigrationConfiguration(loopbackEnvironment({ DB_URL: value }), cli),
        'APPLICATION_DB_URL_PRESENT',
      )
    }
  })

  it('rejects missing, malformed, and mismatched database configuration', () => {
    const cli = parseIdentifierMigrationCli(['backfill'])
    expectCode(
      () =>
        validateIdentifierMigrationConfiguration(
          loopbackEnvironment({ MOVUNE_IDENTIFIER_MIGRATION_DB_URL: undefined }),
          cli,
        ),
      'MIGRATION_DB_URL_REQUIRED',
    )
    expectCode(
      () =>
        validateIdentifierMigrationConfiguration(
          loopbackEnvironment({ MOVUNE_IDENTIFIER_MIGRATION_DB_URL: 'not-a-uri' }),
          cli,
        ),
      'MIGRATION_DB_URI_INVALID',
    )
    expectCode(
      () =>
        validateIdentifierMigrationConfiguration(
          loopbackEnvironment({ MOVUNE_IDENTIFIER_MIGRATION_DB_NAME: 'other' }),
          cli,
        ),
      'MIGRATION_DB_NAME_MISMATCH',
    )
  })

  it('rejects mixed hosts and enforces remote auth, TLS, and username', () => {
    const cli = parseIdentifierMigrationCli(['backfill'])
    expectCode(
      () =>
        validateIdentifierMigrationConfiguration(
          loopbackEnvironment({
            MOVUNE_IDENTIFIER_MIGRATION_DB_URL:
              'mongodb://127.0.0.1:27017,db.example.test:27017/movune_migration_test?replicaSet=test',
          }),
          cli,
        ),
      'MIGRATION_DB_MIXED_HOSTS',
    )
    expectCode(
      () =>
        validateIdentifierMigrationConfiguration(
          remoteEnvironment({
            MOVUNE_IDENTIFIER_MIGRATION_DB_URL: 'mongodb://db.example.test:27017/movune?tls=true',
          }),
          cli,
        ),
      'MIGRATION_DB_REMOTE_AUTH_REQUIRED',
    )
    expectCode(
      () =>
        validateIdentifierMigrationConfiguration(
          remoteEnvironment({
            MOVUNE_IDENTIFIER_MIGRATION_DB_URL:
              'mongodb://migration_user:test-only-password@db.example.test:27017/movune',
          }),
          cli,
        ),
      'MIGRATION_DB_REMOTE_TLS_REQUIRED',
    )
    expectCode(
      () =>
        validateIdentifierMigrationConfiguration(
          remoteEnvironment({ MOVUNE_IDENTIFIER_MIGRATION_EXPECTED_USERNAME: 'other' }),
          cli,
        ),
      'MIGRATION_DB_USERNAME_MISMATCH',
    )
    assert.equal(validateIdentifierMigrationConfiguration(remoteEnvironment(), cli).loopback, false)
    assert.equal(
      validateIdentifierMigrationConfiguration(loopbackEnvironment(), cli).loopback,
      true,
    )
  })

  it('never places supplied secrets or identifiers in configuration errors', () => {
    const environment = remoteEnvironment({
      MOVUNE_IDENTIFIER_MIGRATION_EXPECTED_USERNAME: 'wrong',
    })
    let caught
    try {
      validateIdentifierMigrationConfiguration(
        environment,
        parseIdentifierMigrationCli(['backfill']),
      )
    } catch (error) {
      caught = error
    }
    assert.ok(caught instanceof IdentifierMigrationError)
    const rendered = JSON.stringify(caught)
    for (const forbidden of [
      environment.MOVUNE_IDENTIFIER_MIGRATION_DB_URL,
      'test-only-password',
      'migration_user',
      environment.MOVUNE_IDENTIFIER_MIGRATION_TARGET_ID,
      environment.MOVUNE_IDENTIFIER_MIGRATION_ACK,
    ]) {
      assert.equal(rendered.includes(forbidden), false)
    }
  })

  it('maps frozen outcomes to stable process exit codes', () => {
    for (const outcome of ['COMPLETED', 'PASS', 'NO_OP'])
      assert.equal(exitCodeForOutcome(outcome), 0)
    assert.equal(exitCodeForOutcome('STOP'), 2)
    assert.equal(exitCodeForOutcome('PENDING'), 3)
    assert.equal(exitCodeForOutcome('RETRYABLE'), 4)
    assert.equal(outcomePriority(['NO_OP', 'COMPLETED', 'PENDING']), 'PENDING')
    assert.equal(outcomePriority(['RETRYABLE', 'STOP']), 'STOP')
  })
})

describe('IdentifierClaim migration eligibility and decisions', () => {
  it('performs a complete deterministic eligibility scan with Batch I1 canonicalization', async () => {
    const firstId = new Types.ObjectId('100000000000000000000001')
    const secondId = new Types.ObjectId('100000000000000000000002')
    const result = await scanEligibleUsers({
      userModel: queryModel([
        { _id: firstId, email: ' First@Example.COM ', account: 'First_01' },
        { _id: secondId, email: 'second@example.com', account: '電影02' },
      ]),
    })
    assert.deepEqual(
      result.map(({ userId, emailCanonicalKey, usernameCanonicalKey }) => ({
        userId: userId.toString(),
        emailCanonicalKey,
        usernameCanonicalKey,
      })),
      [
        {
          userId: firstId.toString(),
          emailCanonicalKey: 'first@example.com',
          usernameCanonicalKey: 'first_01',
        },
        {
          userId: secondId.toString(),
          emailCanonicalKey: 'second@example.com',
          usernameCanonicalKey: '電影02',
        },
      ],
    )
  })

  it('stops on missing, wrong-type, policy-invalid, and colliding legacy identifiers', async () => {
    const id = new Types.ObjectId()
    for (const user of [
      { _id: id, account: 'Valid_01' },
      { _id: id, email: 'member@example.com', account: null },
      { _id: id, email: 'member@example.com', account: 'invalid-name' },
    ]) {
      await assert.rejects(
        () => scanEligibleUsers({ userModel: queryModel([user]) }),
        (error) => error instanceof IdentifierMigrationError && error.outcome === 'STOP',
      )
    }
    await assert.rejects(
      () =>
        scanEligibleUsers({
          userModel: queryModel([
            { _id: new Types.ObjectId(), email: 'Member@Example.com', account: 'First_01' },
            { _id: new Types.ObjectId(), email: 'member@example.com', account: 'Second_02' },
          ]),
        }),
      (error) =>
        error instanceof IdentifierMigrationError && error.code === 'USER_CANONICAL_COLLISION',
    )
  })

  it('classifies only same-owner active Claims as NO_OP', () => {
    const owner = new Types.ObjectId()
    assert.equal(classifyStoredClaim(null, owner, 'email').outcome, 'PENDING')
    assert.equal(
      classifyStoredClaim({ ownerUserId: owner, state: 'active' }, owner, 'email').outcome,
      'NO_OP',
    )
    expectCode(
      () => classifyStoredClaim({ ownerUserId: owner, state: 'reserved' }, owner, 'email'),
      'CLAIM_STATE_CONFLICT',
    )
    expectCode(
      () =>
        classifyStoredClaim({ ownerUserId: new Types.ObjectId(), state: 'active' }, owner, 'email'),
      'CLAIM_OWNER_CONFLICT',
    )
  })

  it('classifies the frozen ambiguous-result matrix without repair', async () => {
    const owner = new Types.ObjectId()
    const user = {
      userId: owner,
      emailCanonicalKey: 'member@example.com',
      usernameCanonicalKey: 'member_01',
    }
    const active = { ownerUserId: owner, state: 'active' }
    assert.equal(
      await classifyAmbiguousUserResult(
        user,
        { email: false, username: false },
        {
          claimModel: claimModel({ email: active, username: active }),
        },
      ),
      'COMPLETED',
    )
    await assert.rejects(
      () =>
        classifyAmbiguousUserResult(
          user,
          { email: false, username: false },
          {
            claimModel: claimModel({}),
          },
        ),
      (error) => error instanceof IdentifierMigrationError && error.outcome === 'RETRYABLE',
    )
    await assert.rejects(
      () =>
        classifyAmbiguousUserResult(
          user,
          { email: true, username: false },
          {
            claimModel: claimModel({ email: active }),
          },
        ),
      (error) => error instanceof IdentifierMigrationError && error.outcome === 'RETRYABLE',
    )
    await assert.rejects(
      () =>
        classifyAmbiguousUserResult(
          user,
          { email: false, username: false },
          {
            claimModel: claimModel({ email: active }),
          },
        ),
      (error) =>
        error instanceof IdentifierMigrationError &&
        error.code === 'CLAIM_TRANSACTION_IMPOSSIBLE_PARTIAL',
    )
    await assert.rejects(
      () =>
        classifyAmbiguousUserResult(
          user,
          { email: false, username: false },
          {
            claimModel: claimModel({
              email: { ownerUserId: new Types.ObjectId(), state: 'active' },
              username: active,
            }),
          },
        ),
      (error) => error instanceof IdentifierMigrationError && error.code === 'CLAIM_OWNER_CONFLICT',
    )
  })
})
