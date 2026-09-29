import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  DatabaseHarnessError,
  createDatabaseTestHarness,
  validateDatabaseTestConfiguration,
} from './helpers/databaseHarness.mjs'

const loopbackEnvironment = (overrides = {}) => ({
  MOVUNE_TEST_DB_URL: 'mongodb://127.0.0.1:27017/movune_phase9_test?directConnection=true',
  MOVUNE_TEST_DB_DESTRUCTIVE_ACK: 'movune-phase9-test',
  MOVUNE_TEST_DB_TARGET_ID: 'test-only-target-id',
  ...overrides,
})

const remoteEnvironment = (overrides = {}) => ({
  MOVUNE_TEST_DB_URL:
    'mongodb://dedicated_user:test-only-password@db.example.test:27017/movune_phase9_test?tls=true',
  MOVUNE_TEST_DB_DESTRUCTIVE_ACK: 'movune-phase9-test',
  MOVUNE_TEST_DB_TARGET_ID: 'test-only-target-id',
  MOVUNE_TEST_DB_EXPECTED_USERNAME: 'dedicated_user',
  ...overrides,
})

const rejectsWithCode = (environment, code) => {
  assert.throws(
    () => validateDatabaseTestConfiguration(environment),
    (error) => error instanceof DatabaseHarnessError && error.code === code,
  )
}

describe('safe database-test harness preflight', () => {
  it('requires the dedicated URI and never accepts DB_URL', () => {
    rejectsWithCode({}, 'TEST_DB_URL_REQUIRED')
    rejectsWithCode({ DB_URL: 'mongodb://application.invalid/test' }, 'APPLICATION_DB_URL_PRESENT')
    rejectsWithCode(loopbackEnvironment({ DB_URL: '' }), 'APPLICATION_DB_URL_PRESENT')
  })

  it('rejects malformed, database-less, application, and other database targets', () => {
    rejectsWithCode(
      loopbackEnvironment({ MOVUNE_TEST_DB_URL: 'not-a-mongodb-uri' }),
      'TEST_DB_URI_INVALID',
    )
    rejectsWithCode(
      loopbackEnvironment({ MOVUNE_TEST_DB_URL: 'mongodb://127.0.0.1:27017' }),
      'TEST_DB_DATABASE_UNSAFE',
    )
    rejectsWithCode(
      loopbackEnvironment({ MOVUNE_TEST_DB_URL: 'mongodb://127.0.0.1:27017/test' }),
      'TEST_DB_DATABASE_UNSAFE',
    )
    rejectsWithCode(
      loopbackEnvironment({ MOVUNE_TEST_DB_URL: 'mongodb://127.0.0.1:27017/other_test' }),
      'TEST_DB_DATABASE_UNSAFE',
    )
  })

  it('requires the exact destructive acknowledgement and a target identity', () => {
    rejectsWithCode(
      loopbackEnvironment({ MOVUNE_TEST_DB_DESTRUCTIVE_ACK: undefined }),
      'TEST_DB_ACK_REQUIRED',
    )
    rejectsWithCode(
      loopbackEnvironment({ MOVUNE_TEST_DB_DESTRUCTIVE_ACK: 'yes' }),
      'TEST_DB_ACK_INVALID',
    )
    rejectsWithCode(
      loopbackEnvironment({ MOVUNE_TEST_DB_TARGET_ID: undefined }),
      'TEST_DB_TARGET_ID_REQUIRED',
    )
  })

  it('requires remote authentication, TLS, and the expected dedicated username', () => {
    rejectsWithCode(
      remoteEnvironment({
        MOVUNE_TEST_DB_URL: 'mongodb://db.example.test:27017/movune_phase9_test?tls=true',
      }),
      'TEST_DB_REMOTE_AUTH_REQUIRED',
    )
    rejectsWithCode(
      remoteEnvironment({
        MOVUNE_TEST_DB_URL:
          'mongodb://dedicated_user:test-only-password@db.example.test:27017/movune_phase9_test',
      }),
      'TEST_DB_REMOTE_TLS_REQUIRED',
    )
    rejectsWithCode(
      remoteEnvironment({ MOVUNE_TEST_DB_EXPECTED_USERNAME: undefined }),
      'TEST_DB_EXPECTED_USERNAME_REQUIRED',
    )
    rejectsWithCode(
      remoteEnvironment({ MOVUNE_TEST_DB_EXPECTED_USERNAME: 'different_user' }),
      'TEST_DB_USERNAME_MISMATCH',
    )
  })

  it('accepts valid loopback and remote configurations without connecting', () => {
    const local = validateDatabaseTestConfiguration(loopbackEnvironment())
    const remote = validateDatabaseTestConfiguration(remoteEnvironment())

    assert.equal(local.databaseName, 'movune_phase9_test')
    assert.equal(local.loopback, true)
    assert.equal(remote.databaseName, 'movune_phase9_test')
    assert.equal(remote.loopback, false)
  })

  it('never exposes supplied URI, password, username, or target identity in errors', () => {
    const environment = remoteEnvironment({ MOVUNE_TEST_DB_EXPECTED_USERNAME: 'wrong_user' })
    let caught
    try {
      validateDatabaseTestConfiguration(environment)
    } catch (error) {
      caught = error
    }

    assert.ok(caught instanceof DatabaseHarnessError)
    const rendered = `${caught.name} ${caught.code} ${caught.message}`
    for (const secret of [
      environment.MOVUNE_TEST_DB_URL,
      'test-only-password',
      'dedicated_user',
      environment.MOVUNE_TEST_DB_TARGET_ID,
    ]) {
      assert.equal(rendered.includes(secret), false)
    }
  })

  it('keeps preflight non-ready and rejects index preparation and cleanup before ready', async () => {
    const harness = createDatabaseTestHarness({ environment: loopbackEnvironment() })

    harness.preflight()
    assert.equal(harness.state, 'preflightValidated')
    assert.equal(harness.ready, false)
    await assert.rejects(
      () => harness.prepareIndexes([{ createIndexes: async () => undefined }]),
      (error) => error instanceof DatabaseHarnessError && error.code === 'TEST_DB_NOT_READY',
    )
    assert.throws(
      () => harness.registerCleanup(async () => undefined),
      (error) => error instanceof DatabaseHarnessError && error.code === 'TEST_DB_NOT_READY',
    )
    await assert.rejects(
      () => harness.runCleanup(),
      (error) => error instanceof DatabaseHarnessError && error.code === 'TEST_DB_NOT_READY',
    )
  })
})
