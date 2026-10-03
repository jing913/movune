import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import cookieParser from 'cookie-parser'
import express from 'express'
import { register } from '../dist/controllers/authController.js'
import { errorHandler } from '../dist/middlewares/errorHandler.js'
import {
  createRegistrationMigrationGate,
  REGISTRATION_MIGRATION_GATE_RESPONSE,
  REGISTRATION_MIGRATION_GATE_STATUS,
  REGISTRATION_RELEASE_STATE,
  registrationMigrationGate,
} from '../dist/middlewares/registrationMigrationGate.js'
import authRouter from '../dist/routes/auth.js'

const lockedResponse = {
  error: {
    code: 'REGISTRATION_TEMPORARILY_UNAVAILABLE',
    message: 'Registration is temporarily unavailable.',
  },
}

const invokeGate = (state) => {
  const recorded = { nextCalls: 0, status: undefined, body: undefined }
  const response = {
    status(value) {
      recorded.status = value
      return this
    },
    json(value) {
      recorded.body = value
      return this
    },
  }
  createRegistrationMigrationGate(state)({}, response, () => {
    recorded.nextCalls += 1
  })
  return recorded
}

const postJson = (baseUrl, path, body) =>
  fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

describe('Registration migration gate', () => {
  let server
  let baseUrl

  before(async () => {
    const app = express()
    app.use(express.json())
    app.use(cookieParser())
    app.use('/api/auth', authRouter)
    app.use(errorHandler)
    server = app.listen(0, '127.0.0.1')
    await new Promise((resolve) => server.once('listening', resolve))
    const address = server.address()
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve))
  })

  it('checks in the Stage 4 Gate-OFF release state', () => {
    assert.equal(REGISTRATION_RELEASE_STATE, 'stage4-gate-off')
  })

  it('blocks legacy and Stage 4 Gate-ON without calling next', () => {
    for (const state of ['legacy-gate-on', 'stage4-gate-on']) {
      const result = invokeGate(state)
      assert.equal(result.status, REGISTRATION_MIGRATION_GATE_STATUS)
      assert.equal(result.status, 503)
      assert.deepEqual(result.body, lockedResponse)
      assert.deepEqual(result.body, REGISTRATION_MIGRATION_GATE_RESPONSE)
      assert.equal(result.nextCalls, 0)
    }
  })

  it('passes Stage 4 Gate-OFF through exactly once without writing a response', () => {
    const result = invokeGate('stage4-gate-off')
    assert.equal(result.nextCalls, 1)
    assert.equal(result.status, undefined)
    assert.equal(result.body, undefined)
  })

  it('fails closed for an unsupported runtime state', () => {
    const result = invokeGate('unsupported-release-state')
    assert.equal(result.status, 503)
    assert.deepEqual(result.body, lockedResponse)
    assert.equal(result.nextCalls, 0)
  })

  it('places the production gate immediately before the sole registration writer', () => {
    const registrationLayer = authRouter.stack.find((layer) => layer.route?.path === '/register')
    assert.ok(registrationLayer)
    assert.equal(registrationLayer.route.methods.post, true)
    assert.deepEqual(
      registrationLayer.route.stack.map((layer) => layer.handle),
      [registrationMigrationGate, register],
    )
  })

  it('allows the production Gate-OFF route to reach registration validation', async () => {
    const response = await postJson(baseUrl, '/api/auth/register', {})
    assert.equal(response.status, 400)
    assert.notEqual((await response.json()).error?.code, lockedResponse.error.code)
  })

  it('retains the exact Gate-ON contract before registration validation', async () => {
    const app = express()
    app.use(express.json())
    app.post('/register', createRegistrationMigrationGate('stage4-gate-on'), register)
    app.use(errorHandler)
    const gateOnServer = app.listen(0, '127.0.0.1')
    await new Promise((resolve) => gateOnServer.once('listening', resolve))
    try {
      const address = gateOnServer.address()
      for (const body of [
        { account: 'gateProbe', email: 'gate-probe@test.invalid', password: 'password123' },
        {},
      ]) {
        const response = await postJson(`http://127.0.0.1:${address.port}`, '/register', body)
        assert.equal(response.status, 503)
        assert.equal(response.headers.get('retry-after'), null)
        assert.deepEqual(await response.json(), lockedResponse)
      }
    } finally {
      await new Promise((resolve) => gateOnServer.close(resolve))
    }
  })

  it('does not gate the other auth routes', async () => {
    const login = await postJson(baseUrl, '/api/auth/login', {})
    assert.equal(login.status, 400)
    assert.notEqual((await login.json()).error?.code, lockedResponse.error.code)

    const refresh = await postJson(baseUrl, '/api/auth/refresh', {})
    assert.equal(refresh.status, 401)
    assert.notEqual((await refresh.json()).error?.code, lockedResponse.error.code)

    const logout = await postJson(baseUrl, '/api/auth/logout', {})
    assert.equal(logout.status, 200)
    assert.notEqual((await logout.json()).error?.code, lockedResponse.error.code)

    const forgotPassword = await postJson(baseUrl, '/api/auth/forgot-password', {})
    assert.equal(forgotPassword.status, 400)
    assert.notEqual((await forgotPassword.json()).error?.code, lockedResponse.error.code)

    const resetPassword = await postJson(baseUrl, '/api/auth/reset-password', {})
    assert.equal(resetPassword.status, 400)
    assert.notEqual((await resetPassword.json()).error?.code, lockedResponse.error.code)
  })

  it('keeps the gate writer-independent and allows test-only Stage 4 Gate-OFF pass-through', async () => {
    let writerCalls = 0
    const app = express()
    app.post('/register', createRegistrationMigrationGate('stage4-gate-off'), (_req, res) => {
      writerCalls += 1
      res.status(204).end()
    })
    const passThroughServer = app.listen(0, '127.0.0.1')
    await new Promise((resolve) => passThroughServer.once('listening', resolve))
    try {
      const address = passThroughServer.address()
      const response = await fetch(`http://127.0.0.1:${address.port}/register`, { method: 'POST' })
      assert.equal(response.status, 204)
      assert.equal(writerCalls, 1)
    } finally {
      await new Promise((resolve) => passThroughServer.close(resolve))
    }
  })
})
