import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { after, before, describe, it } from 'node:test'
import express from 'express'
import { Types } from 'mongoose'
import authRouter from '../dist/routes/auth.js'
import { createRegistrationAcceptanceRouter } from '../dist/routes/registrationAcceptance.js'
import { AccountEnforcementAction } from '../dist/models/accountEnforcementActionModel.js'
import { CollectionMembership } from '../dist/models/collectionMembershipModel.js'
import { Collection } from '../dist/models/collectionModel.js'
import { ContactPairGuard } from '../dist/models/contactPairGuardModel.js'
import { DirectConversation } from '../dist/models/directConversationModel.js'
import { DirectConversationState } from '../dist/models/directConversationStateModel.js'
import { DiscussionMembership } from '../dist/models/discussionMembershipModel.js'
import { DiscussionRoom } from '../dist/models/discussionRoomModel.js'
import { Favorite } from '../dist/models/favoriteModel.js'
import { Follow } from '../dist/models/followModel.js'
import { IdentifierClaim } from '../dist/models/identifierClaimModel.js'
import { Message } from '../dist/models/messageModel.js'
import { Notification } from '../dist/models/notificationModel.js'
import { PasswordResetToken } from '../dist/models/passwordResetTokenModel.js'
import { RegistrationAcceptanceRun } from '../dist/models/registrationAcceptanceRunModel.js'
import { RefreshToken } from '../dist/models/refreshTokenModel.js'
import { Report } from '../dist/models/reportModel.js'
import { UserBlock } from '../dist/models/userBlockModel.js'
import { User } from '../dist/models/userModel.js'
import {
  createRegistrationAcceptanceService,
  inspectRegistrationAcceptancePristineState,
} from '../dist/services/registrationAcceptanceService.js'
import { registerUser } from '../dist/services/registrationService.js'
import {
  canonicalizeEmailIdentifier,
  canonicalizeUsernameIdentifier,
} from '../dist/utils/identifierPolicy.js'
import { participantKey } from '../dist/utils/messagingPolicy.js'
import {
  createRegistrationAcceptanceFixtureBinding,
  parseRegistrationAcceptancePublicKey,
  signRegistrationAcceptanceManifest,
} from '../dist/utils/registrationAcceptanceManifest.js'
import { createDatabaseTestHarness } from './helpers/databaseHarness.mjs'

describe('I4C controlled registration dedicated-database acceptance', { timeout: 180_000 }, () => {
  const harness = createDatabaseTestHarness()
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const configuration = {
    environment: 'production',
    serviceId: 'srv-i4c-safe-test',
    releaseSha: 'c'.repeat(40),
    keyId: 'i4c-safe-test-key',
    publicKey: parseRegistrationAcceptancePublicKey(
      publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    ),
  }
  const trackedRunIds = new Set()
  const trackedUserIds = new Set()
  const servers = new Set()
  let counter = 0

  const fixture = () => {
    counter += 1
    const suffix = `${harness.runId.replaceAll('-', '').slice(0, 8)}${counter.toString(36)}`
    const success = {
      account: `p7${suffix}`.slice(0, 20),
      email: `p7-success-${suffix}@example.invalid`,
      password: `success-${randomUUID()}-password`,
    }
    const conflict = {
      account: success.account.toUpperCase(),
      email: `p7-conflict-${suffix}@example.invalid`,
      password: `conflict-${randomUUID()}-password`,
    }
    return { success, conflict }
  }

  const createManifest = (runId, operation, expectedState, values, extra = {}) => ({
    version: 1,
    keyId: configuration.keyId,
    runId,
    operationId: `op_${randomUUID()}`,
    operation,
    issuedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    environment: configuration.environment,
    serviceId: configuration.serviceId,
    releaseSha: configuration.releaseSha,
    expectedState,
    successBinding: createRegistrationAcceptanceFixtureBinding(values.success),
    conflictBinding: createRegistrationAcceptanceFixtureBinding(values.conflict),
    ...extra,
  })

  const token = (manifest) => signRegistrationAcceptanceManifest(manifest, privateKeyPem)

  const startApp = async (service = createRegistrationAcceptanceService()) => {
    const app = express()
    app.use(express.json())
    app.use('/api/auth', authRouter)
    app.use(
      '/api/operations/phase9/registration-acceptance',
      createRegistrationAcceptanceRouter({ configuration, service, disableRateLimit: true }),
    )
    const server = app.listen(0, '127.0.0.1')
    servers.add(server)
    await new Promise((resolve) => server.once('listening', resolve))
    const address = server.address()
    return { server, baseUrl: `http://127.0.0.1:${address.port}` }
  }

  const post = (baseUrl, operation, manifest, body = {}) =>
    fetch(`${baseUrl}/api/operations/phase9/registration-acceptance/${operation}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token(manifest)}` },
      body: JSON.stringify({
        runId: manifest.runId,
        operationId: manifest.operationId,
        ...body,
      }),
    })

  const prepare = async (baseUrl, values) => {
    const runId = `run_${randomUUID()}`
    trackedRunIds.add(runId)
    const prepared = createManifest(runId, 'prepare', 'none', values)
    const response = await post(baseUrl, 'prepare', prepared)
    assert.equal(response.status, 201)
    assert.equal((await response.json()).state, 'prepared')
    return runId
  }

  const succeed = async (baseUrl, runId, values) => {
    const successManifest = createManifest(runId, 'success', 'prepared', values)
    const response = await post(baseUrl, 'success', successManifest, {
      registration: values.success,
    })
    assert.equal(response.status, 201)
    const body = await response.json()
    assert.equal(body.state, 'success_completed')
    trackedUserIds.add(body.userId)
    return { successManifest, userId: body.userId }
  }

  const verifySuccess = async (runId, values) => {
    const run = await RegistrationAcceptanceRun.findById(runId).lean()
    assert.ok(run)
    const inspection = await inspectRegistrationAcceptancePristineState(run, values.success)
    assert.equal(inspection.outcome, 'pristine')
    assert.equal(inspection.userId, run.fixtureUserId.toString())
    return run
  }

  const verifyConflict = async (baseUrl, runId, values, expectedState = 'success_completed') => {
    const conflictManifest = createManifest(runId, 'conflict', expectedState, values)
    const response = await post(baseUrl, 'conflict', conflictManifest, {
      registration: values.conflict,
      success: values.success,
    })
    assert.equal(response.status, 409)
    assert.deepEqual(await response.json(), {
      message: 'Account already exists',
      code: 'REGISTRATION_ACCOUNT_CONFLICT',
    })
    assert.equal(
      (await RegistrationAcceptanceRun.findById(runId).lean()).state,
      'conflict_verified',
    )
    assert.equal(
      await User.countDocuments({
        email: canonicalizeEmailIdentifier(values.conflict.email).representation,
      }),
      0,
    )
    assert.equal(
      await IdentifierClaim.countDocuments({
        kind: 'email',
        canonicalKey: canonicalizeEmailIdentifier(values.conflict.email).canonicalKey,
      }),
      0,
    )
  }

  const cleanupTracked = async () => {
    const ids = [...trackedUserIds].map((id) => new Types.ObjectId(id))
    const ownedCollections = await Collection.find({ ownerId: { $in: ids } })
      .select('_id')
      .lean()
    const conversations = await DirectConversation.find({ participantIds: { $in: ids } })
      .select('_id')
      .lean()
    await Promise.all([
      RefreshToken.deleteMany({ user: { $in: ids } }),
      PasswordResetToken.deleteMany({ user: { $in: ids } }),
      Favorite.deleteMany({ userId: { $in: ids } }),
      CollectionMembership.deleteMany({
        collectionId: { $in: ownedCollections.map(({ _id }) => _id) },
      }),
      Collection.deleteMany({ ownerId: { $in: ids } }),
      Follow.deleteMany({ $or: [{ followerId: { $in: ids } }, { followingId: { $in: ids } }] }),
      UserBlock.deleteMany({
        $or: [{ blockerUserId: { $in: ids } }, { blockedUserId: { $in: ids } }],
      }),
      Notification.deleteMany({ $or: [{ recipientId: { $in: ids } }, { actorId: { $in: ids } }] }),
      DirectConversationState.deleteMany({
        $or: [
          { userId: { $in: ids } },
          { conversationId: { $in: conversations.map(({ _id }) => _id) } },
        ],
      }),
      DirectConversation.deleteMany({ participantIds: { $in: ids } }),
      ContactPairGuard.deleteMany({
        $or: ids.map((id) => ({ participantKey: new RegExp(`(?:^${id}:|:${id}$)`) })),
      }),
      DiscussionMembership.deleteMany({ userId: { $in: ids } }),
      DiscussionRoom.deleteMany({ 'lastMessage.senderId': { $in: ids } }),
      Message.deleteMany({ senderId: { $in: ids } }),
      Report.deleteMany({
        $or: [
          { reporterUserId: { $in: ids } },
          { reportedUserId: { $in: ids } },
          { 'messageEvidence.senderUserId': { $in: ids } },
        ],
      }),
      AccountEnforcementAction.deleteMany({
        $or: [{ targetUserId: { $in: ids } }, { performedByUserId: { $in: ids } }],
      }),
      IdentifierClaim.deleteMany({ ownerUserId: { $in: ids } }),
      User.deleteMany({ _id: { $in: ids } }),
      RegistrationAcceptanceRun.deleteMany({ _id: { $in: [...trackedRunIds] } }),
    ])
  }

  before(async () => {
    await harness.connect()
    await harness.prepareIndexes([User, IdentifierClaim, RegistrationAcceptanceRun])
    harness.registerCleanup(cleanupTracked)
  })

  after(async () => {
    try {
      await Promise.all(
        [...servers].map((server) => new Promise((resolve) => server.close(() => resolve()))),
      )
      if (harness.ready) await harness.runCleanup()
    } finally {
      await harness.close()
    }
  })

  it('keeps public registration at exact Gate-ON 503 with zero User/Claim writes', async () => {
    const { baseUrl } = await startApp()
    const values = fixture()
    const before = {
      users: await User.countDocuments({ account: values.success.account }),
      claims: await IdentifierClaim.countDocuments({
        canonicalKey: canonicalizeUsernameIdentifier(values.success.account).canonicalKey,
      }),
    }
    const response = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(values.success),
    })
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), {
      error: {
        code: 'REGISTRATION_TEMPORARILY_UNAVAILABLE',
        message: 'Registration is temporarily unavailable.',
      },
    })
    assert.deepEqual(
      {
        users: await User.countDocuments({ account: values.success.account }),
        claims: await IdentifierClaim.countDocuments({
          canonicalKey: canonicalizeUsernameIdentifier(values.success.account).canonicalKey,
        }),
      },
      before,
    )
  })

  it('creates one bounded run, invokes the same writer once, and durably denies replay/restart', async () => {
    const values = fixture()
    let writerCalls = 0
    const service = createRegistrationAcceptanceService({
      registrationWriter: async (input) => {
        writerCalls += 1
        return registerUser(input)
      },
    })
    const first = await startApp(service)
    const runId = await prepare(first.baseUrl, values)
    const { successManifest, userId } = await succeed(first.baseUrl, runId, values)
    assert.equal(writerCalls, 1)
    const run = await verifySuccess(runId, values)
    assert.equal(run.state, 'success_completed')
    assert.ok(run.consumedOperationIds.includes(successManifest.operationId))
    assert.equal(await User.countDocuments({ _id: userId }), 1)
    assert.equal(await IdentifierClaim.countDocuments({ ownerUserId: userId, state: 'active' }), 2)

    const replay = await post(first.baseUrl, 'success', successManifest, {
      registration: values.success,
    })
    assert.equal(replay.status, 409)
    assert.equal(writerCalls, 1)

    const restarted = await startApp(service)
    const restartedReplay = await post(restarted.baseUrl, 'success', successManifest, {
      registration: values.success,
    })
    assert.equal(restartedReplay.status, 409)
    assert.equal(writerCalls, 1)
  })

  it('allows at most one writer invocation across concurrent app instances', async () => {
    const values = fixture()
    let writerCalls = 0
    const makeService = () =>
      createRegistrationAcceptanceService({
        registrationWriter: async (input) => {
          writerCalls += 1
          return registerUser(input)
        },
      })
    const first = await startApp(makeService())
    const second = await startApp(makeService())
    const runId = await prepare(first.baseUrl, values)
    const value = createManifest(runId, 'success', 'prepared', values)
    const responses = await Promise.all([
      post(first.baseUrl, 'success', value, { registration: values.success }),
      post(second.baseUrl, 'success', value, { registration: values.success }),
    ])
    assert.deepEqual(responses.map(({ status }) => status).sort(), [201, 409])
    assert.equal(writerCalls, 1)
    const run = await RegistrationAcceptanceRun.findById(runId).lean()
    trackedUserIds.add(run.fixtureUserId.toString())
    assert.equal(await User.countDocuments({ _id: run.fixtureUserId }), 1)
    assert.equal(await IdentifierClaim.countDocuments({ ownerUserId: run.fixtureUserId }), 2)
  })

  it('proves controlled second-Claim conflict and zero loser residue', async () => {
    const { baseUrl } = await startApp()
    const values = fixture()
    const runId = await prepare(baseUrl, values)
    await succeed(baseUrl, runId, values)
    await verifyConflict(baseUrl, runId, values)
    await verifySuccess(runId, values)
  })

  it('reconciles committed and exact-zero success without a second writer invocation', async () => {
    const { baseUrl } = await startApp()
    const committedValues = fixture()
    const committedRunId = await prepare(baseUrl, committedValues)
    const { userId } = await succeed(baseUrl, committedRunId, committedValues)
    await RegistrationAcceptanceRun.updateOne(
      { _id: committedRunId },
      { $set: { state: 'success_executing' }, $unset: { fixtureUserId: 1 } },
    )
    const committedResolution = createManifest(
      committedRunId,
      'resolve',
      'success_executing',
      committedValues,
      { resolution: 'success_committed' },
    )
    const committedResponse = await post(baseUrl, 'resolve', committedResolution, {
      success: committedValues.success,
    })
    assert.equal(committedResponse.status, 200)
    const committedRun = await RegistrationAcceptanceRun.findById(committedRunId).lean()
    assert.equal(committedRun.state, 'success_completed')
    assert.equal(committedRun.fixtureUserId.toString(), userId)
    assert.equal(await User.countDocuments({ _id: userId }), 1)

    const zeroValues = fixture()
    const zeroRunId = await prepare(baseUrl, zeroValues)
    await RegistrationAcceptanceRun.updateOne(
      { _id: zeroRunId },
      {
        $set: { state: 'success_executing' },
        $addToSet: { consumedOperationIds: 'op_simulated_old' },
      },
    )
    const zeroResolution = createManifest(zeroRunId, 'resolve', 'success_executing', zeroValues, {
      resolution: 'success_no_effect',
    })
    const zeroResponse = await post(baseUrl, 'resolve', zeroResolution, {
      success: zeroValues.success,
    })
    assert.equal(zeroResponse.status, 200)
    assert.equal(
      (await RegistrationAcceptanceRun.findById(zeroRunId).lean()).state,
      'success_no_effect',
    )
    const replacement = createManifest(zeroRunId, 'success', 'success_no_effect', zeroValues)
    const replacementResponse = await post(baseUrl, 'success', replacement, {
      registration: zeroValues.success,
    })
    assert.equal(replacementResponse.status, 201)
    trackedUserIds.add((await replacementResponse.json()).userId)
  })

  it('stops partial durable success and cannot infer conflict verification from absence', async () => {
    const { baseUrl } = await startApp()
    const partialValues = fixture()
    const partialRunId = await prepare(baseUrl, partialValues)
    await RegistrationAcceptanceRun.updateOne(
      { _id: partialRunId },
      { $set: { state: 'success_executing' } },
    )
    await IdentifierClaim.create({
      kind: 'email',
      canonicalKey: canonicalizeEmailIdentifier(partialValues.success.email).canonicalKey,
      ownerUserId: new Types.ObjectId(),
      state: 'active',
    })
    const resolution = createManifest(partialRunId, 'resolve', 'success_executing', partialValues, {
      resolution: 'success_no_effect',
    })
    const response = await post(baseUrl, 'resolve', resolution, { success: partialValues.success })
    assert.equal(response.status, 409)
    assert.equal((await RegistrationAcceptanceRun.findById(partialRunId).lean()).state, 'stopped')
    await IdentifierClaim.deleteMany({
      canonicalKey: canonicalizeEmailIdentifier(partialValues.success.email).canonicalKey,
    })

    const conflictValues = fixture()
    const conflictRunId = await prepare(baseUrl, conflictValues)
    await succeed(baseUrl, conflictRunId, conflictValues)
    await RegistrationAcceptanceRun.updateOne(
      { _id: conflictRunId },
      { $set: { state: 'conflict_executing' } },
    )
    const conflictResolution = createManifest(
      conflictRunId,
      'resolve',
      'conflict_executing',
      conflictValues,
      { resolution: 'conflict_no_effect' },
    )
    const conflictResponse = await post(baseUrl, 'resolve', conflictResolution, {
      success: conflictValues.success,
      conflict: conflictValues.conflict,
    })
    assert.equal(conflictResponse.status, 200)
    assert.equal(
      (await RegistrationAcceptanceRun.findById(conflictRunId).lean()).state,
      'conflict_no_effect',
    )
  })

  it('durably revokes an otherwise valid unused operation', async () => {
    const { baseUrl } = await startApp()
    const values = fixture()
    const runId = await prepare(baseUrl, values)
    const successManifest = createManifest(runId, 'success', 'prepared', values)
    const revokeManifest = createManifest(runId, 'revoke', 'prepared', values, {
      targetOperationId: successManifest.operationId,
    })
    const revoked = await post(baseUrl, 'revoke', revokeManifest)
    assert.equal(revoked.status, 200)
    const denied = await post(baseUrl, 'success', successManifest, { registration: values.success })
    assert.equal(denied.status, 401)
    assert.equal(await User.countDocuments({ account: values.success.account }), 0)
  })

  it('refuses every dependent-resource contamination and performs exact transactional cleanup', async () => {
    const { baseUrl } = await startApp()
    const values = fixture()
    const runId = await prepare(baseUrl, values)
    const { userId } = await succeed(baseUrl, runId, values)
    await verifyConflict(baseUrl, runId, values)
    const fixtureId = new Types.ObjectId(userId)
    const other = await User.create({
      account: `o${harness.runId.replaceAll('-', '').slice(0, 10)}${counter}`.slice(0, 20),
      email: `other-${randomUUID()}@example.invalid`,
      password: `other-${randomUUID()}`,
    })
    trackedUserIds.add(other._id.toString())

    const cases = [
      [
        'refresh',
        async () =>
          RefreshToken.create({
            user: fixtureId,
            refreshToken: randomUUID(),
            expiresAt: new Date(Date.now() + 60_000),
            rememberMe: false,
          }),
        async () => RefreshToken.deleteMany({ user: fixtureId }),
      ],
      [
        'reset',
        async () =>
          PasswordResetToken.create({
            user: fixtureId,
            tokenHash: randomUUID(),
            expiresAt: new Date(Date.now() + 60_000),
          }),
        async () => PasswordResetToken.deleteMany({ user: fixtureId }),
      ],
      [
        'favorite',
        async () => Favorite.create({ userId: fixtureId, tmdbId: 900000 + counter }),
        async () => Favorite.deleteMany({ userId: fixtureId }),
      ],
      [
        'collection',
        async () => Collection.create({ ownerId: fixtureId, name: 'Synthetic' }),
        async () => Collection.deleteMany({ ownerId: fixtureId }),
      ],
      [
        'collection-membership',
        async () => {
          const collection = await Collection.create({ ownerId: fixtureId, name: 'Synthetic' })
          await CollectionMembership.create({
            collectionId: collection._id,
            tmdbId: 900001 + counter,
            position: 0,
          })
        },
        async () => {
          const ids = await Collection.find({ ownerId: fixtureId }).distinct('_id')
          await CollectionMembership.deleteMany({ collectionId: { $in: ids } })
          await Collection.deleteMany({ ownerId: fixtureId })
        },
      ],
      [
        'follow',
        async () => Follow.create({ followerId: other._id, followingId: fixtureId }),
        async () =>
          Follow.deleteMany({ $or: [{ followerId: fixtureId }, { followingId: fixtureId }] }),
      ],
      [
        'block',
        async () => UserBlock.create({ blockerUserId: other._id, blockedUserId: fixtureId }),
        async () =>
          UserBlock.deleteMany({
            $or: [{ blockerUserId: fixtureId }, { blockedUserId: fixtureId }],
          }),
      ],
      [
        'notification',
        async () =>
          Notification.create({ recipientId: fixtureId, actorId: other._id, type: 'follow' }),
        async () =>
          Notification.deleteMany({ $or: [{ recipientId: fixtureId }, { actorId: fixtureId }] }),
      ],
      [
        'direct-conversation',
        async () =>
          DirectConversation.create({
            participantIds: [other._id, fixtureId],
            participantKey: participantKey(other._id.toString(), userId),
            initiatedByUserId: other._id,
            state: 'pending',
          }),
        async () => DirectConversation.deleteMany({ participantIds: fixtureId }),
      ],
      [
        'direct-state',
        async () =>
          DirectConversationState.create({
            conversationId: new Types.ObjectId(),
            userId: fixtureId,
          }),
        async () => DirectConversationState.deleteMany({ userId: fixtureId }),
      ],
      [
        'pair-guard',
        async () =>
          ContactPairGuard.create({ participantKey: participantKey(other._id.toString(), userId) }),
        async () =>
          ContactPairGuard.deleteMany({
            participantKey: participantKey(other._id.toString(), userId),
          }),
      ],
      [
        'discussion-membership',
        async () => {
          const room = await DiscussionRoom.create({
            tmdbId: 910000 + counter,
            movieSnapshot: { title: 'Synthetic', posterPath: null },
          })
          await DiscussionMembership.create({
            roomId: room._id,
            userId: fixtureId,
            status: 'joined',
            joinedAt: new Date(),
          })
        },
        async () => {
          await DiscussionMembership.deleteMany({ userId: fixtureId })
          await DiscussionRoom.deleteMany({ tmdbId: 910000 + counter })
        },
      ],
      [
        'discussion-last-message',
        async () =>
          DiscussionRoom.create({
            tmdbId: 920000 + counter,
            movieSnapshot: { title: 'Synthetic', posterPath: null },
            lastMessage: {
              messageId: new Types.ObjectId(),
              senderId: fixtureId,
              preview: 'synthetic',
              createdAt: new Date(),
            },
          }),
        async () => DiscussionRoom.deleteMany({ 'lastMessage.senderId': fixtureId }),
      ],
      [
        'message',
        async () =>
          Message.create({
            senderId: fixtureId,
            clientMessageId: randomUUID(),
            contextType: 'discussion',
            contextId: new Types.ObjectId(),
            content: 'synthetic',
          }),
        async () => Message.deleteMany({ senderId: fixtureId }),
      ],
      [
        'report',
        async () =>
          Report.create({
            reporterUserId: other._id,
            reportedUserId: fixtureId,
            reason: 'other',
            sourceType: 'public_profile',
          }),
        async () =>
          Report.deleteMany({
            $or: [
              { reporterUserId: fixtureId },
              { reportedUserId: fixtureId },
              { 'messageEvidence.senderUserId': fixtureId },
            ],
          }),
      ],
      [
        'enforcement',
        async () =>
          AccountEnforcementAction.create({
            targetUserId: fixtureId,
            recordType: 'decision',
            effectiveAt: new Date(),
            performedByUserId: other._id,
            reasonCode: 'synthetic',
            reasonSummary: 'Synthetic acceptance contamination',
            decisionType: 'formal_warning',
            guidelineRuleId: 'synthetic-rule',
            guidelineVersion: 'v1',
          }),
        async () =>
          AccountEnforcementAction.deleteMany({
            $or: [{ targetUserId: fixtureId }, { performedByUserId: fixtureId }],
          }),
      ],
    ]

    for (const [name, contaminate, remove] of cases) {
      await contaminate()
      const run = await RegistrationAcceptanceRun.findById(runId).lean()
      const inspection = await inspectRegistrationAcceptancePristineState(run, values.success)
      assert.equal(inspection.outcome, 'partial', `${name} must violate pristine state`)
      const cleanupManifest = createManifest(runId, 'cleanup', 'conflict_verified', values)
      const response = await post(baseUrl, 'cleanup', cleanupManifest, { success: values.success })
      assert.equal(response.status, 409, `${name} must block cleanup`)
      assert.equal(await User.countDocuments({ _id: fixtureId }), 1)
      assert.equal(await IdentifierClaim.countDocuments({ ownerUserId: fixtureId }), 2)
      await remove()
    }

    const userBeforeMutation = await User.findById(fixtureId).lean()
    await User.updateOne({ _id: fixtureId }, { $set: { avatar: 'synthetic-change' } })
    let cleanupManifest = createManifest(runId, 'cleanup', 'conflict_verified', values)
    let response = await post(baseUrl, 'cleanup', cleanupManifest, { success: values.success })
    assert.equal(response.status, 409)
    await User.updateOne(
      { _id: fixtureId },
      { $unset: { avatar: 1 }, $set: { updatedAt: userBeforeMutation.createdAt } },
      { timestamps: false },
    )

    const originalDeleteOne = IdentifierClaim.deleteOne
    let claimDeleteCalls = 0
    IdentifierClaim.deleteOne = function (...args) {
      claimDeleteCalls += 1
      if (claimDeleteCalls === 2) return Promise.reject(new Error('synthetic cleanup failure'))
      return originalDeleteOne.apply(this, args)
    }
    try {
      cleanupManifest = createManifest(runId, 'cleanup', 'conflict_verified', values)
      response = await post(baseUrl, 'cleanup', cleanupManifest, { success: values.success })
      assert.equal(response.status, 503)
    } finally {
      IdentifierClaim.deleteOne = originalDeleteOne
    }
    assert.equal(await User.countDocuments({ _id: fixtureId }), 1)
    assert.equal(await IdentifierClaim.countDocuments({ ownerUserId: fixtureId }), 2)
    assert.equal(
      (await RegistrationAcceptanceRun.findById(runId).lean()).state,
      'conflict_verified',
    )

    cleanupManifest = createManifest(runId, 'cleanup', 'conflict_verified', values)
    response = await post(baseUrl, 'cleanup', cleanupManifest, {
      success: values.success,
      userId: other._id.toString(),
    })
    assert.equal(response.status, 200)
    assert.equal((await response.json()).state, 'cleaned')
    assert.equal(await User.countDocuments({ _id: fixtureId }), 0)
    assert.equal(await IdentifierClaim.countDocuments({ ownerUserId: fixtureId }), 0)
    const tombstone = await RegistrationAcceptanceRun.findById(runId).lean()
    assert.equal(tombstone.state, 'cleaned')
    assert.equal(tombstone.fixtureUserId.toString(), userId)
    assert.equal(await User.countDocuments({ _id: other._id }), 1)
  })
})
