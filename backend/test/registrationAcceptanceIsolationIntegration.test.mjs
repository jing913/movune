import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { after, before, describe, it } from 'node:test'
import { Types } from 'mongoose'
import { IdentifierClaim } from '../dist/models/identifierClaimModel.js'
import { RegistrationAcceptanceRun } from '../dist/models/registrationAcceptanceRunModel.js'
import { User } from '../dist/models/userModel.js'
import { RegistrationAcceptanceError } from '../dist/services/registrationAcceptanceService.js'
import {
  P7_EXECUTION_ACKNOWLEDGEMENT,
  P7_TEST_DATABASE,
} from '../dist/tools/registrationAcceptanceIsolatedConfiguration.js'
import { runP7IsolatedOperation } from '../dist/tools/runRegistrationAcceptanceIsolated.js'
import { runP7ProductionVerification } from '../dist/tools/runRegistrationAcceptanceProductionVerification.js'
import {
  createRegistrationAcceptanceFixtureBinding,
  signRegistrationAcceptanceManifest,
} from '../dist/utils/registrationAcceptanceManifest.js'
import { createDatabaseTestHarness } from './helpers/databaseHarness.mjs'

describe('P7 isolated worker dedicated-database acceptance', { timeout: 180_000 }, () => {
  const harness = createDatabaseTestHarness()
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const runId = `run_${randomUUID()}`
  const suffix = harness.runId.replaceAll('-', '').slice(0, 10)
  const success = {
    account: `p7${suffix}`.slice(0, 20),
    email: `p7-isolated-success-${suffix}@example.invalid`,
    password: `success-${randomUUID()}-password`,
  }
  const conflict = {
    account: success.account.toUpperCase(),
    email: `p7-isolated-conflict-${suffix}@example.invalid`,
    password: `conflict-${randomUUID()}-password`,
  }
  const context = {
    environment: 'production',
    serviceId: 'srv-p7-isolated-safe-test',
    releaseSha: 'd'.repeat(40),
    keyId: 'p7-isolated-safe-test-key',
  }

  const target = (prefix) => ({
    [`${prefix}_DB_URL`]: process.env.MOVUNE_TEST_DB_URL,
    [`${prefix}_DB_NAME`]: P7_TEST_DATABASE,
    [`${prefix}_EXPECTED_USERNAME`]: process.env.MOVUNE_TEST_DB_EXPECTED_USERNAME,
    [`${prefix}_TARGET_ID`]: process.env.MOVUNE_TEST_DB_TARGET_ID,
    [`${prefix}_TARGET_PROFILE`]: 'dedicated-test',
    [`${prefix}_ENVIRONMENT`]: context.environment,
    [`${prefix}_RENDER_SERVICE_ID`]: context.serviceId,
    [`${prefix}_RELEASE_SHA`]: context.releaseSha,
  })

  const manifest = (operation, expectedState, extra = {}) => ({
    version: 1,
    keyId: context.keyId,
    runId,
    operationId: `op_${randomUUID()}`,
    operation,
    issuedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    environment: context.environment,
    serviceId: context.serviceId,
    releaseSha: context.releaseSha,
    expectedState,
    successBinding: createRegistrationAcceptanceFixtureBinding(success),
    conflictBinding: createRegistrationAcceptanceFixtureBinding(conflict),
    ...extra,
  })

  const executeEnvironment = (value, body) => ({
    ...target('MOVUNE_P7'),
    MOVUNE_P7_EXECUTION_ACK: P7_EXECUTION_ACKNOWLEDGEMENT,
    MOVUNE_P7_KEY_ID: context.keyId,
    MOVUNE_P7_PUBLIC_KEY: publicKeyPem,
    MOVUNE_P7_CAPABILITY: signRegistrationAcceptanceManifest(value, privateKeyPem),
    MOVUNE_P7_REQUEST_JSON: JSON.stringify({
      runId: value.runId,
      operationId: value.operationId,
      ...body,
    }),
  })

  before(async () => {
    await harness.connect()
    await harness.prepareIndexes([User, IdentifierClaim, RegistrationAcceptanceRun])
    harness.registerCleanup(async () => {
      const run = await RegistrationAcceptanceRun.findById(runId).lean()
      const ids = run?.fixtureUserId ? [new Types.ObjectId(run.fixtureUserId)] : []
      await IdentifierClaim.deleteMany({ ownerUserId: { $in: ids } })
      await User.deleteMany({ _id: { $in: ids } })
      await RegistrationAcceptanceRun.deleteMany({ _id: runId })
    })
  })

  after(async () => {
    try {
      if (harness.ready) await harness.runCleanup()
    } finally {
      await harness.close()
    }
  })

  it('preflights, commits atomically, rejects replay, rolls conflict back, and verifies read-only', async () => {
    const preflight = await runP7IsolatedOperation('preflight', target('MOVUNE_P7'))
    assert.equal(preflight.outcome, 'PASS')
    assert.equal(preflight.infrastructure.databaseName, P7_TEST_DATABASE)

    const prepared = manifest('prepare', 'none')
    assert.equal(
      (await runP7IsolatedOperation('prepare', executeEnvironment(prepared, {}))).state,
      'prepared',
    )

    const successful = manifest('success', 'prepared')
    const successResult = await runP7IsolatedOperation(
      'success',
      executeEnvironment(successful, { registration: success }),
    )
    assert.equal(successResult.state, 'success_completed')
    assert.equal('userId' in successResult, false)

    await assert.rejects(
      () =>
        runP7IsolatedOperation(
          'success',
          executeEnvironment(successful, { registration: success }),
        ),
      (error) =>
        error instanceof RegistrationAcceptanceError &&
        error.code === 'ACCEPTANCE_OPERATION_CONSUMED',
    )

    const conflictManifest = manifest('conflict', 'success_completed')
    const conflictResult = await runP7IsolatedOperation(
      'conflict',
      executeEnvironment(conflictManifest, { registration: conflict, success }),
    )
    assert.equal(conflictResult.state, 'conflict_verified')
    assert.equal(conflictResult.classification, 'REGISTRATION_ACCOUNT_CONFLICT')

    const verification = await runP7ProductionVerification({
      ...target('MOVUNE_P7_VERIFY'),
      MOVUNE_P7_VERIFY_EVIDENCE_JSON: JSON.stringify({ runId, success, conflict }),
    })
    assert.equal(verification.outcome, 'PASS')
    assert.equal(verification.success.userCount, 1)
    assert.equal(verification.success.activeEmailClaimCount, 1)
    assert.equal(verification.success.activeUsernameClaimCount, 1)
    assert.equal(verification.success.commonOwner, true)
    assert.equal(verification.conflict.userResidueCount, 0)
    assert.equal(verification.conflict.emailClaimResidueCount, 0)

    const run = await RegistrationAcceptanceRun.findById(runId).lean()
    assert.equal(run.state, 'conflict_verified')
    assert.equal(await User.countDocuments({ _id: run.fixtureUserId }), 1)
    assert.equal(
      await IdentifierClaim.countDocuments({ ownerUserId: run.fixtureUserId, state: 'active' }),
      2,
    )
  })
})
