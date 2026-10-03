import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import express from 'express'
import { register } from '../dist/controllers/authController.js'
import { errorHandler } from '../dist/middlewares/errorHandler.js'
import { createRegistrationMigrationGate } from '../dist/middlewares/registrationMigrationGate.js'
import { IdentifierClaim } from '../dist/models/identifierClaimModel.js'
import { User } from '../dist/models/userModel.js'
import authRouter from '../dist/routes/auth.js'
import {
  canonicalizeEmailIdentifier,
  canonicalizeUsernameIdentifier,
} from '../dist/utils/identifierPolicy.js'
import { createDatabaseTestHarness } from './helpers/databaseHarness.mjs'

const lockedResponse = {
  error: {
    code: 'REGISTRATION_TEMPORARILY_UNAVAILABLE',
    message: 'Registration is temporarily unavailable.',
  },
}

const startApp = async (configure) => {
  const app = express()
  app.use(express.json())
  configure(app)
  app.use(errorHandler)
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const address = server.address()
  return { server, baseUrl: `http://127.0.0.1:${address.port}` }
}

const closeServer = (server) => new Promise((resolve) => server.close(resolve))

const postRegistration = (baseUrl, body) =>
  fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

describe('Registration migration gate dedicated-database acceptance', { timeout: 120_000 }, () => {
  const harness = createDatabaseTestHarness()
  const accounts = new Set()
  const emails = new Set()
  const canonicalKeys = new Set()
  let gateOnServer
  let gateOnBaseUrl
  let productionServer
  let productionBaseUrl

  const rememberIdentity = (account, email) => {
    const username = canonicalizeUsernameIdentifier(account)
    const mailbox = canonicalizeEmailIdentifier(email)
    accounts.add(username.representation)
    emails.add(mailbox.representation)
    canonicalKeys.add(username.canonicalKey)
    canonicalKeys.add(mailbox.canonicalKey)
    return { account, email, password: 'password123' }
  }

  const userCohortFilter = () => ({
    $or: [{ account: { $in: [...accounts] } }, { email: { $in: [...emails] } }],
  })

  const claimCohortFilter = () => ({ canonicalKey: { $in: [...canonicalKeys] } })

  const cohortCounts = async () => ({
    users: await User.countDocuments(userCohortFilter()),
    claims: await IdentifierClaim.countDocuments(claimCohortFilter()),
  })

  before(async () => {
    await harness.connect()
    await harness.prepareIndexes([User, IdentifierClaim])
    harness.registerCleanup(async () => {
      if (canonicalKeys.size > 0) await IdentifierClaim.deleteMany(claimCohortFilter())
      if (accounts.size > 0) await User.deleteMany(userCohortFilter())
      assert.deepEqual(await cohortCounts(), { users: 0, claims: 0 })
    })

    ;({ server: gateOnServer, baseUrl: gateOnBaseUrl } = await startApp((app) => {
      app.post('/api/auth/register', createRegistrationMigrationGate('stage4-gate-on'), register)
    }))
    ;({ server: productionServer, baseUrl: productionBaseUrl } = await startApp((app) => {
      app.use('/api/auth', authRouter)
    }))
  })

  after(async () => {
    try {
      if (gateOnServer) await closeServer(gateOnServer)
      if (productionServer) await closeServer(productionServer)
      if (harness.ready) await harness.runCleanup()
    } finally {
      await harness.close()
    }
  })

  it('proves Gate-ON creates no User or IdentifierClaim', async () => {
    const suffix = harness.runId.replaceAll('-', '').slice(0, 12)
    const probe = rememberIdentity(`i4agate${suffix}`, `i4a-gate-${suffix}@test.invalid`)
    const beforeCounts = await cohortCounts()
    assert.deepEqual(beforeCounts, { users: 0, claims: 0 })

    const response = await postRegistration(gateOnBaseUrl, probe)
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), lockedResponse)
    assert.equal(await User.exists({ account: probe.account }), null)
    assert.equal(await User.exists({ email: probe.email }), null)
    assert.equal(
      await IdentifierClaim.exists({
        kind: 'email',
        canonicalKey: canonicalizeEmailIdentifier(probe.email).canonicalKey,
      }),
      null,
    )
    assert.equal(
      await IdentifierClaim.exists({
        kind: 'username',
        canonicalKey: canonicalizeUsernameIdentifier(probe.account).canonicalKey,
      }),
      null,
    )
    assert.deepEqual(await cohortCounts(), beforeCounts)
  })

  it('keeps the Stage 4 writer unreachable under Gate-ON', async () => {
    const suffix = harness.runId.replaceAll('-', '').slice(12, 24)
    const duplicate = rememberIdentity(`i4adup${suffix}`, `i4a-dup-${suffix}@test.invalid`)
    await User.create(duplicate)
    const beforeCounts = await cohortCounts()

    const response = await postRegistration(gateOnBaseUrl, duplicate)
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), lockedResponse)
    assert.deepEqual(await cohortCounts(), beforeCounts)
  })

  it('allows the Stage 4 writer through the production Gate-OFF router', async () => {
    const suffix = harness.runId.replaceAll('-', '').slice(0, 8)
    const passThrough = rememberIdentity(`i4apass${suffix}`, `  I4A-Pass-${suffix}@test.invalid  `)
    const response = await postRegistration(productionBaseUrl, passThrough)
    assert.equal(response.status, 201)
    assert.deepEqual(await response.json(), { message: 'Register successful' })
    const user = await User.findOne({ account: passThrough.account }).lean()
    assert.ok(user)
    assert.equal(user.email, canonicalizeEmailIdentifier(passThrough.email).representation)
    const claims = await IdentifierClaim.find({ ownerUserId: user._id }).sort({ kind: 1 }).lean()
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
          canonicalKey: canonicalizeEmailIdentifier(passThrough.email).canonicalKey,
          ownerUserId: user._id.toString(),
          state: 'active',
        },
        {
          kind: 'username',
          canonicalKey: canonicalizeUsernameIdentifier(passThrough.account).canonicalKey,
          ownerUserId: user._id.toString(),
          state: 'active',
        },
      ],
    )

    const emailConflict = rememberIdentity(
      `i4aemail${suffix}`,
      canonicalizeEmailIdentifier(passThrough.email).representation.toUpperCase(),
    )
    const emailResponse = await postRegistration(productionBaseUrl, emailConflict)
    assert.equal(emailResponse.status, 409)
    assert.deepEqual(await emailResponse.json(), {
      message: 'Email already exists',
      code: 'REGISTRATION_EMAIL_CONFLICT',
    })

    const accountConflict = rememberIdentity(
      passThrough.account.toUpperCase(),
      `i4a-account-${suffix}@test.invalid`,
    )
    const accountResponse = await postRegistration(productionBaseUrl, accountConflict)
    assert.equal(accountResponse.status, 409)
    assert.deepEqual(await accountResponse.json(), {
      message: 'Account already exists',
      code: 'REGISTRATION_ACCOUNT_CONFLICT',
    })
  })
})
