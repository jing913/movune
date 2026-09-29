import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { afterEach, describe, it } from 'node:test'
import express from 'express'
import {
  RegistrationAcceptanceConfigurationError,
  resolveRegistrationAcceptanceConfiguration,
} from '../dist/configs/registrationAcceptanceConfiguration.js'
import { RegistrationAcceptanceRun } from '../dist/models/registrationAcceptanceRunModel.js'
import { createRegistrationAcceptanceRouter } from '../dist/routes/registrationAcceptance.js'
import { createRegistrationAcceptanceCapability } from '../dist/tools/runRegistrationAcceptanceCapability.js'
import {
  RegistrationAcceptanceVerificationError,
  validateRegistrationAcceptanceVerificationConfiguration,
} from '../dist/tools/registrationAcceptanceVerification.js'
import {
  REGISTRATION_ACCEPTANCE_STATES,
  RegistrationAcceptanceManifestError,
  createRegistrationAcceptanceFixtureBinding,
  parseRegistrationAcceptancePublicKey,
  signRegistrationAcceptanceManifest,
  verifyRegistrationAcceptanceManifest,
} from '../dist/utils/registrationAcceptanceManifest.js'

const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
const now = new Date('2026-09-26T12:00:00.000Z')
const success = {
  account: 'p7testfixture00001',
  email: 'p7-success-00001@example.invalid',
  password: 'success-password-not-real',
}
const conflict = {
  account: success.account.toUpperCase(),
  email: 'p7-conflict-00001@example.invalid',
  password: 'conflict-password-not-real',
}
const configuration = {
  environment: 'production',
  serviceId: 'srv-movune-test',
  releaseSha: 'a'.repeat(40),
  keyId: 'i4c-test-key',
  publicKey: parseRegistrationAcceptancePublicKey(publicKeyPem),
}

let sequence = 0
const manifest = (overrides = {}) => {
  sequence += 1
  return {
    version: 1,
    keyId: configuration.keyId,
    runId: `run_${randomUUID()}`,
    operationId: `op_${randomUUID()}`,
    operation: 'prepare',
    issuedAt: new Date(now.getTime() - 1_000).toISOString(),
    expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
    environment: configuration.environment,
    serviceId: configuration.serviceId,
    releaseSha: configuration.releaseSha,
    expectedState: 'none',
    successBinding: createRegistrationAcceptanceFixtureBinding(success),
    conflictBinding: createRegistrationAcceptanceFixtureBinding(conflict),
    ...overrides,
  }
}

const capability = (value) => signRegistrationAcceptanceManifest(value, privateKeyPem)
const verify = (value, operation = value.operation, context = {}) =>
  verifyRegistrationAcceptanceManifest(capability(value), operation, {
    ...configuration,
    now,
    ...context,
  })

const rejectedCode = (operation, code) =>
  assert.throws(operation, (error) => {
    assert.ok(error instanceof RegistrationAcceptanceManifestError)
    assert.equal(error.code, code)
    return true
  })

const servers = new Set()
afterEach(async () => {
  await Promise.all(
    [...servers].map((server) => new Promise((resolve) => server.close(() => resolve()))),
  )
  servers.clear()
})

const start = async (router) => {
  const app = express()
  app.use(express.json())
  app.use('/api/operations/phase9/registration-acceptance', router)
  const server = app.listen(0, '127.0.0.1')
  servers.add(server)
  await new Promise((resolve) => server.once('listening', resolve))
  const address = server.address()
  return `http://127.0.0.1:${address.port}`
}

const post = (baseUrl, operation, body, token) =>
  fetch(`${baseUrl}/api/operations/phase9/registration-acceptance/${operation}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })

describe('I4C configuration and manifest authorization', () => {
  it('fails closed for missing and malformed runtime verification configuration', () => {
    assert.throws(
      () => resolveRegistrationAcceptanceConfiguration({}),
      (error) =>
        error instanceof RegistrationAcceptanceConfigurationError &&
        error.code === 'I4C_CONFIGURATION_MISSING',
    )
    assert.throws(
      () =>
        resolveRegistrationAcceptanceConfiguration({
          NODE_ENV: 'production',
          MOVUNE_I4C_ENVIRONMENT: 'production',
          MOVUNE_I4C_RENDER_SERVICE_ID: 'srv-movune-test',
          MOVUNE_I4C_RELEASE_SHA: 'a'.repeat(40),
          MOVUNE_I4C_KEY_ID: 'i4c-test-key',
          MOVUNE_I4C_PUBLIC_KEY: 'not-a-key',
          RENDER_SERVICE_ID: 'srv-movune-test',
          RENDER_GIT_COMMIT: 'a'.repeat(40),
        }),
      (error) => error instanceof RegistrationAcceptanceManifestError,
    )
  })

  it('accepts only a canonical, unaltered Ed25519 manifest with exact bindings', () => {
    const value = manifest()
    assert.deepEqual(verify(value), value)

    const signed = capability(value)
    const [payload, signature] = signed.split('.')
    const alteredPayload = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(payload, 'base64url').toString()),
        runId: 'run_altered',
      }),
    ).toString('base64url')
    rejectedCode(
      () =>
        verifyRegistrationAcceptanceManifest(`${alteredPayload}.${signature}`, 'prepare', {
          ...configuration,
          now,
        }),
      'CAPABILITY_SIGNATURE_INVALID',
    )
    rejectedCode(
      () =>
        verifyRegistrationAcceptanceManifest(`${signed.slice(0, -2)}xx`, 'prepare', {
          ...configuration,
          now,
        }),
      'CAPABILITY_SIGNATURE_INVALID',
    )
  })

  it('denies wrong key, operation, environment, service, release, and time claims', () => {
    const value = manifest()
    rejectedCode(() => verify(value, 'success'), 'CAPABILITY_OPERATION_MISMATCH')
    rejectedCode(
      () => verify(value, value.operation, { keyId: 'wrong-key' }),
      'CAPABILITY_KEY_ID_MISMATCH',
    )
    rejectedCode(
      () => verify(value, value.operation, { environment: 'staging' }),
      'CAPABILITY_ENVIRONMENT_MISMATCH',
    )
    rejectedCode(
      () => verify(value, value.operation, { serviceId: 'srv-other' }),
      'CAPABILITY_SERVICE_MISMATCH',
    )
    rejectedCode(
      () => verify(value, value.operation, { releaseSha: 'b'.repeat(40) }),
      'CAPABILITY_RELEASE_MISMATCH',
    )
    rejectedCode(
      () =>
        verify(
          manifest({
            issuedAt: new Date(now.getTime() - 10 * 60_000).toISOString(),
            expiresAt: new Date(now.getTime() - 61_001).toISOString(),
          }),
        ),
      'CAPABILITY_EXPIRED',
    )
    rejectedCode(
      () => verify(manifest({ issuedAt: new Date(now.getTime() + 60_001).toISOString() })),
      'CAPABILITY_NOT_YET_VALID',
    )
    rejectedCode(
      () =>
        verify(
          manifest({
            issuedAt: now.toISOString(),
            expiresAt: new Date(now.getTime() + 30 * 60_000 + 1).toISOString(),
          }),
        ),
      'CAPABILITY_LIFETIME_INVALID',
    )
  })

  it('rejects malformed, unsupported, and invalid bounded manifest fields', () => {
    rejectedCode(
      () =>
        verifyRegistrationAcceptanceManifest('not-a-capability', 'prepare', {
          ...configuration,
          now,
        }),
      'CAPABILITY_MALFORMED',
    )
    assert.throws(() => capability(manifest({ version: 2 })), /MANIFEST_VERSION_UNSUPPORTED/)
    assert.throws(
      () => capability(manifest({ operation: 'arbitrary' })),
      /MANIFEST_OPERATION_INVALID/,
    )
    assert.throws(() => capability(manifest({ runId: 'bad' })), /MANIFEST_RUN_ID_INVALID/)
    assert.throws(
      () => capability(manifest({ operationId: 'bad' })),
      /MANIFEST_OPERATION_ID_INVALID/,
    )
    assert.throws(
      () => capability(manifest({ expectedState: 'reusable' })),
      /MANIFEST_PREDECESSOR_INVALID/,
    )
  })

  it('detects fixture and password/request binding changes', () => {
    const expected = createRegistrationAcceptanceFixtureBinding(success)
    assert.notDeepEqual(
      createRegistrationAcceptanceFixtureBinding({ ...success, account: `${success.account}x` }),
      expected,
    )
    assert.notDeepEqual(
      createRegistrationAcceptanceFixtureBinding({ ...success, email: `x-${success.email}` }),
      expected,
    )
    assert.notDeepEqual(
      createRegistrationAcceptanceFixtureBinding({ ...success, password: `${success.password}x` }),
      expected,
    )
  })

  it('exposes exactly the accepted durable states and no reusable reset state', () => {
    assert.deepEqual(REGISTRATION_ACCEPTANCE_STATES, [
      'prepared',
      'success_executing',
      'success_no_effect',
      'success_completed',
      'conflict_executing',
      'conflict_no_effect',
      'conflict_verified',
      'cleaned',
      'stopped',
    ])
    assert.deepEqual(RegistrationAcceptanceRun.schema.path('state').options.enum, [
      ...REGISTRATION_ACCEPTANCE_STATES,
    ])
    const operationIndex = RegistrationAcceptanceRun.schema
      .indexes()
      .find(([keys]) => JSON.stringify(keys) === JSON.stringify({ consumedOperationIds: 1 }))
    assert.ok(operationIndex)
    assert.equal(operationIndex[1].unique, true)
  })

  it('uses the explicit operator signer without retaining the private key', () => {
    const value = manifest()
    const token = createRegistrationAcceptanceCapability(
      'prepare',
      JSON.stringify(value),
      privateKeyPem,
    )
    assert.equal(
      verifyRegistrationAcceptanceManifest(token, 'prepare', { ...configuration, now }).runId,
      value.runId,
    )
    assert.throws(
      () => createRegistrationAcceptanceCapability('success', JSON.stringify(value), privateKeyPem),
      /CAPABILITY_TOOL_OPERATION_MISMATCH/,
    )
  })

  it('keeps the operator verifier on an explicit TLS read-only target without DB_URL fallback', () => {
    const verificationUri = [
      'mongodb',
      '://',
      'i4c_reader',
      ':',
      'test-only',
      '@db.example.invalid:27017/',
    ].join('')
    const base = {
      MOVUNE_I4C_VERIFY_DB_URL: `${verificationUri}movune_production?tls=true`,
      MOVUNE_I4C_VERIFY_DB_NAME: 'movune_production',
      MOVUNE_I4C_VERIFY_EXPECTED_USERNAME: 'i4c_reader',
      MOVUNE_I4C_VERIFY_TARGET_ID: 'target-safe-test',
      MOVUNE_I4C_VERIFY_RUN_ID: 'run_safe_test',
    }
    const value = validateRegistrationAcceptanceVerificationConfiguration(base)
    assert.equal(value.databaseName, 'movune_production')
    assert.equal('username' in value, false)
    assert.equal('password' in value, false)
    assert.throws(
      () => validateRegistrationAcceptanceVerificationConfiguration({ ...base, DB_URL: '' }),
      (error) =>
        error instanceof RegistrationAcceptanceVerificationError &&
        error.code === 'APPLICATION_DB_URL_PRESENT',
    )
    assert.throws(
      () =>
        validateRegistrationAcceptanceVerificationConfiguration({
          ...base,
          MOVUNE_I4C_VERIFY_DB_URL: `${verificationUri}test?tls=true`,
        }),
      (error) =>
        error instanceof RegistrationAcceptanceVerificationError &&
        error.code === 'VERIFIER_DB_NAME_MISMATCH',
    )
  })
})

describe('I4C isolated HTTP boundary', () => {
  const stubService = (overrides = {}) => ({
    prepare: async () => ({ state: 'prepared' }),
    success: async () => ({ state: 'success_completed', userId: '000000000000000000000001' }),
    conflict: async () => ({ state: 'conflict_verified' }),
    resolve: async () => ({ state: 'success_no_effect' }),
    revoke: async () => ({ state: 'prepared', revoked: true }),
    cleanup: async () => ({ state: 'cleaned' }),
    verify: async () => ({ state: 'prepared', inspection: { outcome: 'zero', violations: [] } }),
    ...overrides,
  })

  it('returns fail-closed 503 when runtime verification configuration is absent', async () => {
    const baseUrl = await start(createRegistrationAcceptanceRouter({ disableRateLimit: true }))
    const response = await post(baseUrl, 'prepare', {}, undefined)
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), {
      error: {
        code: 'REGISTRATION_ACCEPTANCE_UNAVAILABLE',
        message: 'Registration acceptance is unavailable.',
      },
    })
  })

  it('denies missing/malformed authorization before any service or writer access', async () => {
    let calls = 0
    const service = stubService({
      success: async () => {
        calls += 1
        return { state: 'success_completed' }
      },
    })
    const baseUrl = await start(
      createRegistrationAcceptanceRouter({
        configuration,
        service,
        disableRateLimit: true,
        now: () => now,
      }),
    )
    for (const token of [undefined, 'malformed']) {
      const response = await post(baseUrl, 'success', {}, token)
      assert.equal(response.status, 401)
      assert.deepEqual(await response.json(), {
        error: {
          code: 'REGISTRATION_ACCEPTANCE_DENIED',
          message: 'Registration acceptance authorization failed.',
        },
      })
    }
    assert.equal(calls, 0)
  })

  it('routes each fixed operation only to its bounded service method', async () => {
    const calls = []
    const service = stubService({
      prepare: async (_manifest, body) => {
        calls.push(['prepare', body])
        return { state: 'prepared' }
      },
      success: async (_manifest, body) => {
        calls.push(['success', body])
        return { state: 'success_completed' }
      },
      resolve: async (_manifest, body) => {
        calls.push(['resolve', body])
        return { state: 'success_no_effect' }
      },
    })
    const baseUrl = await start(
      createRegistrationAcceptanceRouter({
        configuration,
        service,
        disableRateLimit: true,
        now: () => now,
      }),
    )
    for (const [operation, body, expected] of [
      ['prepare', {}, 201],
      ['success', { registration: success }, 201],
      ['resolve', { success }, 200],
    ]) {
      const value = manifest({
        operation,
        expectedState:
          operation === 'prepare'
            ? 'none'
            : operation === 'success'
              ? 'prepared'
              : 'success_executing',
        ...(operation === 'resolve' ? { resolution: 'success_no_effect' } : {}),
      })
      const response = await post(
        baseUrl,
        operation,
        { runId: value.runId, operationId: value.operationId, ...body },
        capability(value),
      )
      assert.equal(response.status, expected)
    }
    assert.deepEqual(
      calls.map(([name]) => name),
      ['prepare', 'success', 'resolve'],
    )
  })

  it('never logs capability, signature, password, or raw fixture values', async () => {
    const messages = []
    const originalLog = console.log
    const originalError = console.error
    console.log = (...values) => messages.push(values.join(' '))
    console.error = (...values) => messages.push(values.join(' '))
    try {
      const baseUrl = await start(
        createRegistrationAcceptanceRouter({
          configuration,
          service: stubService(),
          disableRateLimit: true,
          now: () => now,
        }),
      )
      const value = manifest({ operation: 'success', expectedState: 'prepared' })
      const token = capability(value)
      const response = await post(
        baseUrl,
        'success',
        { runId: value.runId, operationId: value.operationId, registration: success },
        token,
      )
      assert.equal(response.status, 201)
      const captured = messages.join('\n')
      for (const secret of [token, success.password, success.account, success.email]) {
        assert.equal(captured.includes(secret), false)
      }
    } finally {
      console.log = originalLog
      console.error = originalError
    }
  })
})
