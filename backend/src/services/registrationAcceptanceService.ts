import mongoose, { Types, type ClientSession, type Connection } from 'mongoose'
import { AccountEnforcementAction } from '../models/accountEnforcementActionModel.js'
import { CollectionMembership } from '../models/collectionMembershipModel.js'
import { Collection } from '../models/collectionModel.js'
import { ContactPairGuard } from '../models/contactPairGuardModel.js'
import { DirectConversation } from '../models/directConversationModel.js'
import { DirectConversationState } from '../models/directConversationStateModel.js'
import { DiscussionMembership } from '../models/discussionMembershipModel.js'
import { DiscussionRoom } from '../models/discussionRoomModel.js'
import { Favorite } from '../models/favoriteModel.js'
import { Follow } from '../models/followModel.js'
import { IdentifierClaim } from '../models/identifierClaimModel.js'
import { Message } from '../models/messageModel.js'
import { Notification } from '../models/notificationModel.js'
import { PasswordResetToken } from '../models/passwordResetTokenModel.js'
import {
  RegistrationAcceptanceRun,
  type IRegistrationAcceptanceRun,
} from '../models/registrationAcceptanceRunModel.js'
import { RefreshToken } from '../models/refreshTokenModel.js'
import { Report } from '../models/reportModel.js'
import { UserBlock } from '../models/userBlockModel.js'
import { User } from '../models/userModel.js'
import {
  RegistrationConflictError,
  registerUser,
  type RegistrationInput,
} from './registrationService.js'
import {
  canonicalizeEmailIdentifier,
  canonicalizeUsernameIdentifier,
} from '../utils/identifierPolicy.js'
import {
  createRegistrationAcceptanceFixtureBinding,
  fingerprintRegistrationAcceptanceValue,
  fixtureBindingsEqual,
  type RegistrationAcceptanceManifest,
  type RegistrationAcceptanceState,
  type RegistrationRequest,
} from '../utils/registrationAcceptanceManifest.js'

export class RegistrationAcceptanceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code)
    this.name = 'RegistrationAcceptanceError'
  }
}

const reject = (status: number, code: string): never => {
  throw new RegistrationAcceptanceError(status, code)
}

const isDuplicateKey = (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 11000

type RequestEnvelope = Readonly<{
  runId: string
  operationId: string
}>

type RegistrationEnvelope = RequestEnvelope & RegistrationRequest

type RunDocument = IRegistrationAcceptanceRun & { _id: string }

// The acceptance service intentionally supports models bound to an explicit Mongoose connection.
// Mongoose's heterogeneous model overloads are not representable as one useful structural type.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AcceptanceModel = any

export type RegistrationAcceptanceModels = Readonly<{
  AccountEnforcementAction: AcceptanceModel
  CollectionMembership: AcceptanceModel
  Collection: AcceptanceModel
  ContactPairGuard: AcceptanceModel
  DirectConversation: AcceptanceModel
  DirectConversationState: AcceptanceModel
  DiscussionMembership: AcceptanceModel
  DiscussionRoom: AcceptanceModel
  Favorite: AcceptanceModel
  Follow: AcceptanceModel
  IdentifierClaim: AcceptanceModel
  Message: AcceptanceModel
  Notification: AcceptanceModel
  PasswordResetToken: AcceptanceModel
  RegistrationAcceptanceRun: AcceptanceModel
  RefreshToken: AcceptanceModel
  Report: AcceptanceModel
  UserBlock: AcceptanceModel
  User: AcceptanceModel
}>

const defaultModels: RegistrationAcceptanceModels = Object.freeze({
  AccountEnforcementAction,
  CollectionMembership,
  Collection,
  ContactPairGuard,
  DirectConversation,
  DirectConversationState,
  DiscussionMembership,
  DiscussionRoom,
  Favorite,
  Follow,
  IdentifierClaim,
  Message,
  Notification,
  PasswordResetToken,
  RegistrationAcceptanceRun,
  RefreshToken,
  Report,
  UserBlock,
  User,
})

const bindModel = (connection: Connection, source: AcceptanceModel) =>
  connection.models[source.modelName] ??
  connection.model(source.modelName, source.schema, source.collection.name)

export const createRegistrationAcceptanceModels = (
  connection: Connection,
): RegistrationAcceptanceModels =>
  Object.freeze(
    Object.fromEntries(
      Object.entries(defaultModels).map(([name, source]) => [name, bindModel(connection, source)]),
    ) as unknown as RegistrationAcceptanceModels,
  )

export type PristineInspection = Readonly<{
  outcome: 'pristine' | 'zero' | 'partial'
  userId?: string
  violations: readonly string[]
}>

export type RegistrationAcceptanceDependencies = Readonly<{
  registrationWriter?: (input: RegistrationInput) => Promise<Readonly<{ userId: Types.ObjectId }>>
  now?: () => Date
  models?: RegistrationAcceptanceModels
  transactionRunner?: (operation: (session: ClientSession) => Promise<void>) => Promise<unknown>
}>

const event = (manifest: RegistrationAcceptanceManifest, outcome: string, now: Date) => ({
  operationId: manifest.operationId,
  operation: manifest.operation,
  outcome,
  at: now,
})

const assertEnvelope = (manifest: RegistrationAcceptanceManifest, envelope: RequestEnvelope) => {
  if (envelope.runId !== manifest.runId) reject(401, 'ACCEPTANCE_RUN_MISMATCH')
  if (envelope.operationId !== manifest.operationId) reject(401, 'ACCEPTANCE_OPERATION_MISMATCH')
}

const assertRequestBinding = (
  request: RegistrationRequest,
  expected: ReturnType<typeof createRegistrationAcceptanceFixtureBinding>,
) => {
  let actual: ReturnType<typeof createRegistrationAcceptanceFixtureBinding>
  try {
    actual = createRegistrationAcceptanceFixtureBinding(request)
  } catch {
    return reject(401, 'ACCEPTANCE_FIXTURE_MISMATCH')
  }
  if (!fixtureBindingsEqual(actual, expected)) reject(401, 'ACCEPTANCE_FIXTURE_MISMATCH')
}

const assertRunScope = (run: RunDocument, manifest: RegistrationAcceptanceManifest) => {
  if (
    run.version !== manifest.version ||
    run.keyId !== manifest.keyId ||
    run.environment !== manifest.environment ||
    run.serviceId !== manifest.serviceId ||
    run.releaseSha !== manifest.releaseSha ||
    !fixtureBindingsEqual(run.successBinding, manifest.successBinding) ||
    !fixtureBindingsEqual(run.conflictBinding, manifest.conflictBinding)
  ) {
    reject(409, 'ACCEPTANCE_RUN_SCOPE_MISMATCH')
  }
}

const assertOperationAvailable = (run: RunDocument, manifest: RegistrationAcceptanceManifest) => {
  if (run.revokedOperationIds.includes(manifest.operationId)) {
    reject(401, 'ACCEPTANCE_OPERATION_REVOKED')
  }
  if (run.consumedOperationIds.includes(manifest.operationId)) {
    reject(409, 'ACCEPTANCE_OPERATION_CONSUMED')
  }
}

const queryWithSession = <T>(query: T, session?: ClientSession): T => {
  if (session && typeof (query as { session?: unknown }).session === 'function') {
    return (query as { session(value: ClientSession): T }).session(session)
  }
  return query
}

const loadRun = async (
  models: RegistrationAcceptanceModels,
  manifest: RegistrationAcceptanceManifest,
  session?: ClientSession,
) => {
  const query = models.RegistrationAcceptanceRun.findById(manifest.runId).lean()
  const run = (await queryWithSession(query, session)) as RunDocument | null
  if (!run) return reject(404, 'ACCEPTANCE_RUN_NOT_FOUND')
  assertRunScope(run, manifest)
  return run
}

const consumeTransition = async (
  models: RegistrationAcceptanceModels,
  manifest: RegistrationAcceptanceManifest,
  nextState: RegistrationAcceptanceState,
  now: Date,
) => {
  const run = await loadRun(models, manifest)
  assertOperationAvailable(run, manifest)
  if (run.state !== manifest.expectedState) reject(409, 'ACCEPTANCE_PREDECESSOR_MISMATCH')
  const updated = await models.RegistrationAcceptanceRun.findOneAndUpdate(
    {
      _id: manifest.runId,
      state: manifest.expectedState,
      consumedOperationIds: { $ne: manifest.operationId },
      revokedOperationIds: { $ne: manifest.operationId },
    },
    {
      $set: { state: nextState },
      $addToSet: { consumedOperationIds: manifest.operationId },
      $push: { auditEvents: event(manifest, nextState, now) },
    },
    { returnDocument: 'after' },
  )
  if (!updated) reject(409, 'ACCEPTANCE_OPERATION_NOT_AVAILABLE')
  return updated as unknown as RunDocument
}

const transitionResolution = async (
  models: RegistrationAcceptanceModels,
  manifest: RegistrationAcceptanceManifest,
  nextState: RegistrationAcceptanceState,
  now: Date,
  fixtureUserId?: Types.ObjectId,
) => {
  const update: Record<string, unknown> = { state: nextState }
  if (fixtureUserId) update.fixtureUserId = fixtureUserId
  const result = await models.RegistrationAcceptanceRun.findOneAndUpdate(
    {
      _id: manifest.runId,
      state: manifest.expectedState,
      consumedOperationIds: { $ne: manifest.operationId },
      revokedOperationIds: { $ne: manifest.operationId },
    },
    {
      $set: update,
      $addToSet: { consumedOperationIds: manifest.operationId },
      $push: { auditEvents: event(manifest, nextState, now) },
    },
    { returnDocument: 'after' },
  )
  if (!result) reject(409, 'ACCEPTANCE_RESOLUTION_NOT_AVAILABLE')
  return result as unknown as RunDocument
}

const inspectSuccessRecords = async (
  models: RegistrationAcceptanceModels,
  run: RunDocument,
  input: RegistrationRequest,
  session?: ClientSession,
): Promise<PristineInspection> => {
  assertRequestBinding(input, run.successBinding)
  const username = canonicalizeUsernameIdentifier(input.account)
  const email = canonicalizeEmailIdentifier(input.email)
  const users = (await queryWithSession(
    models.User.find({
      $or: [{ account: username.representation }, { email: email.representation }],
    })
      .select('+password')
      .lean(),
    session,
  )) as unknown as Record<string, unknown>[]
  const claims = (await queryWithSession(
    models.IdentifierClaim.find({
      $or: [
        { kind: 'username', canonicalKey: username.canonicalKey },
        { kind: 'email', canonicalKey: email.canonicalKey },
      ],
    }).lean(),
    session,
  )) as unknown as Record<string, unknown>[]
  if (users.length === 0 && claims.length === 0) return { outcome: 'zero', violations: [] }
  if (users.length !== 1 || claims.length !== 2) {
    return { outcome: 'partial', violations: ['FIXTURE_CARDINALITY_INVALID'] }
  }
  const user = users[0]
  if (!user) return { outcome: 'partial', violations: ['FIXTURE_USER_MISSING'] }
  const userId = String(user._id)
  const validUser =
    user.account === username.representation &&
    user.email === email.representation &&
    typeof user.password === 'string' &&
    user.role === 'user' &&
    user.favoritesPublic === false &&
    user.messageRequestPreference === 'all_members' &&
    user.displayName === undefined &&
    user.avatar === undefined &&
    user.bio === undefined &&
    user.createdAt instanceof Date &&
    user.updatedAt instanceof Date &&
    user.createdAt.getTime() === user.updatedAt.getTime()
  const claimSummary = claims
    .map((claim) => ({
      kind: claim.kind,
      canonicalKey: claim.canonicalKey,
      ownerUserId: String(claim.ownerUserId),
      state: claim.state,
    }))
    .sort((left, right) => String(left.kind).localeCompare(String(right.kind)))
  const validClaims =
    claimSummary.length === 2 &&
    claimSummary[0]?.kind === 'email' &&
    claimSummary[0].canonicalKey === email.canonicalKey &&
    claimSummary[0].ownerUserId === userId &&
    claimSummary[0].state === 'active' &&
    claimSummary[1]?.kind === 'username' &&
    claimSummary[1].canonicalKey === username.canonicalKey &&
    claimSummary[1].ownerUserId === userId &&
    claimSummary[1].state === 'active'
  if (!validUser || !validClaims) {
    return {
      outcome: 'partial',
      violations: [
        ...(validUser ? [] : ['FIXTURE_USER_STATE_INVALID']),
        ...(validClaims ? [] : ['FIXTURE_CLAIM_STATE_INVALID']),
      ],
    }
  }
  if (
    fingerprintRegistrationAcceptanceValue(username.canonicalKey) !==
      run.successBinding.usernameCanonicalFingerprint ||
    fingerprintRegistrationAcceptanceValue(email.canonicalKey) !==
      run.successBinding.emailCanonicalFingerprint
  ) {
    return { outcome: 'partial', violations: ['FIXTURE_CANONICAL_FINGERPRINT_INVALID'] }
  }
  return { outcome: 'pristine', userId, violations: [] }
}

export const inspectRegistrationAcceptancePristineState = async (
  run: RunDocument,
  input: RegistrationRequest,
  session?: ClientSession,
  models: RegistrationAcceptanceModels = defaultModels,
): Promise<PristineInspection> => {
  const base = await inspectSuccessRecords(models, run, input, session)
  if (base.outcome !== 'pristine' || !base.userId) return base
  const userId = new Types.ObjectId(base.userId)
  const ownedCollections = (await queryWithSession(
    models.Collection.find({ ownerId: userId }).select('_id').lean(),
    session,
  )) as unknown as { _id: Types.ObjectId }[]
  const conversations = (await queryWithSession(
    models.DirectConversation.find({
      $or: [
        { participantIds: userId },
        { initiatedByUserId: userId },
        { 'lastMessage.senderId': userId },
      ],
    })
      .select('_id')
      .lean(),
    session,
  )) as unknown as { _id: Types.ObjectId }[]
  const escapedId = userId.toString().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pairPattern = new RegExp(`(?:^${escapedId}:|:${escapedId}$)`)
  const collectionIds = ownedCollections.map(({ _id }) => _id)
  const conversationIds = conversations.map(({ _id }) => _id)
  const checks = await Promise.all([
    queryWithSession(models.RefreshToken.countDocuments({ user: userId }), session),
    queryWithSession(models.PasswordResetToken.countDocuments({ user: userId }), session),
    queryWithSession(models.Favorite.countDocuments({ userId }), session),
    Promise.resolve(ownedCollections.length),
    collectionIds.length === 0
      ? Promise.resolve(0)
      : queryWithSession(
          models.CollectionMembership.countDocuments({ collectionId: { $in: collectionIds } }),
          session,
        ),
    queryWithSession(
      models.Follow.countDocuments({ $or: [{ followerId: userId }, { followingId: userId }] }),
      session,
    ),
    queryWithSession(
      models.UserBlock.countDocuments({
        $or: [{ blockerUserId: userId }, { blockedUserId: userId }],
      }),
      session,
    ),
    queryWithSession(
      models.Notification.countDocuments({ $or: [{ recipientId: userId }, { actorId: userId }] }),
      session,
    ),
    Promise.resolve(conversations.length),
    queryWithSession(
      models.DirectConversationState.countDocuments({
        $or: [
          { userId },
          ...(conversationIds.length === 0 ? [] : [{ conversationId: { $in: conversationIds } }]),
        ],
      }),
      session,
    ),
    queryWithSession(
      models.ContactPairGuard.countDocuments({ participantKey: pairPattern }),
      session,
    ),
    queryWithSession(models.DiscussionMembership.countDocuments({ userId }), session),
    queryWithSession(
      models.DiscussionRoom.countDocuments({ 'lastMessage.senderId': userId }),
      session,
    ),
    queryWithSession(models.Message.countDocuments({ senderId: userId }), session),
    queryWithSession(
      models.Report.countDocuments({
        $or: [
          { reporterUserId: userId },
          { reportedUserId: userId },
          { 'messageEvidence.senderUserId': userId },
        ],
      }),
      session,
    ),
    queryWithSession(
      models.AccountEnforcementAction.countDocuments({
        $or: [{ targetUserId: userId }, { performedByUserId: userId }],
      }),
      session,
    ),
  ])
  const names = [
    'REFRESH_TOKEN_PRESENT',
    'PASSWORD_RESET_TOKEN_PRESENT',
    'FAVORITE_PRESENT',
    'COLLECTION_PRESENT',
    'COLLECTION_MEMBERSHIP_PRESENT',
    'FOLLOW_PRESENT',
    'BLOCK_PRESENT',
    'NOTIFICATION_PRESENT',
    'DIRECT_CONVERSATION_PRESENT',
    'DIRECT_CONVERSATION_STATE_PRESENT',
    'CONTACT_PAIR_GUARD_PRESENT',
    'DISCUSSION_MEMBERSHIP_PRESENT',
    'DISCUSSION_ROOM_SENDER_PRESENT',
    'MESSAGE_PRESENT',
    'REPORT_PRESENT',
    'ENFORCEMENT_ACTION_PRESENT',
  ]
  const violations = checks.flatMap((count, index) => (count === 0 ? [] : [names[index] as string]))
  return violations.length === 0 ? base : { outcome: 'partial', userId: base.userId, violations }
}

const inspectConflictResidue = async (
  models: RegistrationAcceptanceModels,
  run: RunDocument,
  successInput: RegistrationRequest,
  conflictInput: RegistrationRequest,
) => {
  assertRequestBinding(conflictInput, run.conflictBinding)
  const original = await inspectRegistrationAcceptancePristineState(
    run,
    successInput,
    undefined,
    models,
  )
  if (original.outcome !== 'pristine') return { safe: false, violations: original.violations }
  const conflictEmail = canonicalizeEmailIdentifier(conflictInput.email)
  const [users, claims] = await Promise.all([
    models.User.countDocuments({ email: conflictEmail.representation }),
    models.IdentifierClaim.countDocuments({
      kind: 'email',
      canonicalKey: conflictEmail.canonicalKey,
    }),
  ])
  return users === 0 && claims === 0
    ? { safe: true, violations: [] }
    : { safe: false, violations: ['CONFLICT_RESIDUE_PRESENT'] }
}

export const createRegistrationAcceptanceService = (
  dependencies: RegistrationAcceptanceDependencies = {},
) => {
  const registrationWriter = dependencies.registrationWriter ?? registerUser
  const now = dependencies.now ?? (() => new Date())
  const models = dependencies.models ?? defaultModels
  const transactionRunner =
    dependencies.transactionRunner ??
    ((operation: (session: ClientSession) => Promise<void>) =>
      mongoose.connection.transaction(operation))

  return {
    async prepare(manifest: RegistrationAcceptanceManifest, envelope: RequestEnvelope) {
      assertEnvelope(manifest, envelope)
      if (manifest.expectedState !== 'none') reject(409, 'ACCEPTANCE_PREDECESSOR_MISMATCH')
      try {
        await models.RegistrationAcceptanceRun.create({
          _id: manifest.runId,
          version: manifest.version,
          keyId: manifest.keyId,
          environment: manifest.environment,
          serviceId: manifest.serviceId,
          releaseSha: manifest.releaseSha,
          state: 'prepared',
          successBinding: manifest.successBinding,
          conflictBinding: manifest.conflictBinding,
          consumedOperationIds: [manifest.operationId],
          revokedOperationIds: [],
          auditEvents: [event(manifest, 'prepared', now())],
        })
      } catch (error) {
        if (isDuplicateKey(error)) reject(409, 'ACCEPTANCE_OPERATION_CONSUMED')
        throw error
      }
      return { state: 'prepared' as const }
    },

    async success(manifest: RegistrationAcceptanceManifest, envelope: RegistrationEnvelope) {
      assertEnvelope(manifest, envelope)
      assertRequestBinding(envelope, manifest.successBinding)
      await consumeTransition(models, manifest, 'success_executing', now())
      let result: Readonly<{ userId: Types.ObjectId }>
      try {
        result = await registrationWriter({
          account: envelope.account,
          email: envelope.email,
          password: envelope.password,
        })
      } catch {
        return reject(503, 'ACCEPTANCE_SUCCESS_OUTCOME_UNRESOLVED')
      }
      const inspection = await inspectSuccessRecords(
        models,
        (await models.RegistrationAcceptanceRun.findById(manifest.runId).lean()) as RunDocument,
        envelope,
      )
      if (inspection.outcome !== 'pristine' || inspection.userId !== result.userId.toString()) {
        await models.RegistrationAcceptanceRun.updateOne(
          { _id: manifest.runId, state: 'success_executing' },
          {
            $set: { state: 'stopped' },
            $push: { auditEvents: event(manifest, 'stopped', now()) },
          },
        )
        return reject(503, 'ACCEPTANCE_SUCCESS_POSTCONDITION_FAILED')
      }
      const completed = await models.RegistrationAcceptanceRun.findOneAndUpdate(
        { _id: manifest.runId, state: 'success_executing' },
        {
          $set: { state: 'success_completed', fixtureUserId: result.userId },
          $push: { auditEvents: event(manifest, 'success_completed', now()) },
        },
        { returnDocument: 'after' },
      )
      if (!completed) reject(503, 'ACCEPTANCE_SUCCESS_OUTCOME_UNRESOLVED')
      return { state: 'success_completed' as const, userId: result.userId.toString() }
    },

    async conflict(
      manifest: RegistrationAcceptanceManifest,
      envelope: RegistrationEnvelope & { success: RegistrationRequest },
    ) {
      assertEnvelope(manifest, envelope)
      assertRequestBinding(envelope, manifest.conflictBinding)
      assertRequestBinding(envelope.success, manifest.successBinding)
      await consumeTransition(models, manifest, 'conflict_executing', now())
      try {
        await registrationWriter({
          account: envelope.account,
          email: envelope.email,
          password: envelope.password,
        })
      } catch (error) {
        if (
          error instanceof RegistrationConflictError &&
          error.code === 'REGISTRATION_ACCOUNT_CONFLICT'
        ) {
          const residue = await inspectConflictResidue(
            models,
            (await models.RegistrationAcceptanceRun.findById(manifest.runId).lean()) as RunDocument,
            envelope.success,
            envelope,
          )
          if (!residue.safe) {
            await models.RegistrationAcceptanceRun.updateOne(
              { _id: manifest.runId, state: 'conflict_executing' },
              {
                $set: { state: 'stopped' },
                $push: { auditEvents: event(manifest, 'stopped', now()) },
              },
            )
            return reject(503, 'ACCEPTANCE_CONFLICT_POSTCONDITION_FAILED')
          }
          const verified = await models.RegistrationAcceptanceRun.findOneAndUpdate(
            { _id: manifest.runId, state: 'conflict_executing' },
            {
              $set: { state: 'conflict_verified' },
              $push: { auditEvents: event(manifest, 'conflict_verified', now()) },
            },
            { returnDocument: 'after' },
          )
          if (!verified) reject(503, 'ACCEPTANCE_CONFLICT_OUTCOME_UNRESOLVED')
          throw error
        }
        return reject(503, 'ACCEPTANCE_CONFLICT_OUTCOME_UNRESOLVED')
      }
      await models.RegistrationAcceptanceRun.updateOne(
        { _id: manifest.runId, state: 'conflict_executing' },
        { $set: { state: 'stopped' }, $push: { auditEvents: event(manifest, 'stopped', now()) } },
      )
      return reject(503, 'ACCEPTANCE_CONFLICT_EXPECTED')
    },

    async resolve(
      manifest: RegistrationAcceptanceManifest,
      envelope: RequestEnvelope & {
        success: RegistrationRequest
        conflict?: RegistrationRequest
      },
    ) {
      assertEnvelope(manifest, envelope)
      const run = await loadRun(models, manifest)
      assertOperationAvailable(run, manifest)
      if (run.state !== manifest.expectedState) reject(409, 'ACCEPTANCE_PREDECESSOR_MISMATCH')
      if (manifest.resolution === 'stop') {
        await transitionResolution(models, manifest, 'stopped', now())
        return { state: 'stopped' as const }
      }
      if (
        manifest.resolution === 'success_committed' ||
        manifest.resolution === 'success_no_effect'
      ) {
        if (run.state !== 'success_executing') reject(409, 'ACCEPTANCE_RESOLUTION_INVALID')
        const inspection = await inspectSuccessRecords(models, run, envelope.success)
        const expected = manifest.resolution === 'success_committed' ? 'pristine' : 'zero'
        if (inspection.outcome !== expected) {
          await transitionResolution(models, manifest, 'stopped', now())
          return reject(409, 'ACCEPTANCE_RESOLUTION_EVIDENCE_MISMATCH')
        }
        const fixtureUserId = inspection.userId ? new Types.ObjectId(inspection.userId) : undefined
        const state =
          manifest.resolution === 'success_committed' ? 'success_completed' : 'success_no_effect'
        await transitionResolution(models, manifest, state, now(), fixtureUserId)
        return { state }
      }
      if (manifest.resolution === 'conflict_no_effect') {
        const conflictInput = envelope.conflict
        if (run.state !== 'conflict_executing' || !conflictInput) {
          return reject(409, 'ACCEPTANCE_RESOLUTION_INVALID')
        }
        const residue = await inspectConflictResidue(models, run, envelope.success, conflictInput)
        if (!residue.safe) {
          await transitionResolution(models, manifest, 'stopped', now())
          return reject(409, 'ACCEPTANCE_RESOLUTION_EVIDENCE_MISMATCH')
        }
        await transitionResolution(models, manifest, 'conflict_no_effect', now())
        return { state: 'conflict_no_effect' as const }
      }
      return reject(409, 'ACCEPTANCE_RESOLUTION_INVALID')
    },

    async revoke(manifest: RegistrationAcceptanceManifest, envelope: RequestEnvelope) {
      assertEnvelope(manifest, envelope)
      const targetOperationId = manifest.targetOperationId
      if (!targetOperationId) return reject(400, 'ACCEPTANCE_REVOCATION_INVALID')
      if (targetOperationId === manifest.operationId) {
        return reject(400, 'ACCEPTANCE_REVOCATION_INVALID')
      }
      const run = await loadRun(models, manifest)
      assertOperationAvailable(run, manifest)
      if (run.state !== manifest.expectedState) reject(409, 'ACCEPTANCE_PREDECESSOR_MISMATCH')
      if (run.consumedOperationIds.includes(targetOperationId)) {
        reject(409, 'ACCEPTANCE_REVOCATION_TARGET_CONSUMED')
      }
      const updated = await models.RegistrationAcceptanceRun.findOneAndUpdate(
        {
          _id: manifest.runId,
          state: manifest.expectedState,
          consumedOperationIds: { $ne: manifest.operationId },
          revokedOperationIds: { $ne: manifest.operationId },
        },
        {
          $addToSet: {
            consumedOperationIds: manifest.operationId,
            revokedOperationIds: targetOperationId,
          },
          $push: { auditEvents: event(manifest, 'revoked', now()) },
        },
        { returnDocument: 'after' },
      )
      if (!updated) reject(409, 'ACCEPTANCE_REVOCATION_NOT_AVAILABLE')
      return { state: updated.state, revoked: true as const }
    },

    async cleanup(
      manifest: RegistrationAcceptanceManifest,
      envelope: RequestEnvelope & { success: RegistrationRequest },
    ) {
      assertEnvelope(manifest, envelope)
      assertRequestBinding(envelope.success, manifest.successBinding)
      try {
        await transactionRunner(async (session) => {
          const run = await loadRun(models, manifest, session)
          assertOperationAvailable(run, manifest)
          if (run.state !== 'conflict_verified' || manifest.expectedState !== 'conflict_verified') {
            reject(409, 'ACCEPTANCE_PREDECESSOR_MISMATCH')
          }
          if (!run.fixtureUserId) return reject(409, 'ACCEPTANCE_FIXTURE_TARGET_MISSING')
          const fixtureUserId = run.fixtureUserId
          const inspection = await inspectRegistrationAcceptancePristineState(
            run,
            envelope.success,
            session,
            models,
          )
          if (inspection.outcome !== 'pristine' || inspection.userId !== fixtureUserId.toString()) {
            reject(409, 'ACCEPTANCE_FIXTURE_NOT_PRISTINE')
          }
          const emailDelete = await models.IdentifierClaim.deleteOne(
            { kind: 'email', ownerUserId: fixtureUserId, state: 'active' },
            { session },
          )
          const usernameDelete = await models.IdentifierClaim.deleteOne(
            { kind: 'username', ownerUserId: fixtureUserId, state: 'active' },
            { session },
          )
          const userDelete = await models.User.deleteOne({ _id: fixtureUserId }, { session })
          if (
            emailDelete.deletedCount !== 1 ||
            usernameDelete.deletedCount !== 1 ||
            userDelete.deletedCount !== 1
          ) {
            reject(409, 'ACCEPTANCE_CLEANUP_DELETE_COUNT_INVALID')
          }
          const updated = await models.RegistrationAcceptanceRun.updateOne(
            {
              _id: manifest.runId,
              state: 'conflict_verified',
              consumedOperationIds: { $ne: manifest.operationId },
              revokedOperationIds: { $ne: manifest.operationId },
            },
            {
              $set: { state: 'cleaned' },
              $addToSet: { consumedOperationIds: manifest.operationId },
              $push: { auditEvents: event(manifest, 'cleaned', now()) },
            },
            { session },
          )
          if (updated.modifiedCount !== 1) reject(409, 'ACCEPTANCE_CLEANUP_STATE_INVALID')
        })
      } catch (error) {
        if (error instanceof RegistrationAcceptanceError) throw error
        return reject(503, 'ACCEPTANCE_CLEANUP_OUTCOME_UNRESOLVED')
      }
      return { state: 'cleaned' as const }
    },

    async verify(runId: string, successInput: RegistrationRequest) {
      const run = (await models.RegistrationAcceptanceRun.findById(
        runId,
      ).lean()) as RunDocument | null
      if (!run) return reject(404, 'ACCEPTANCE_RUN_NOT_FOUND')
      const inspection = await inspectRegistrationAcceptancePristineState(
        run,
        successInput,
        undefined,
        models,
      )
      return { state: run.state, inspection }
    },
  }
}

export type RegistrationAcceptanceService = ReturnType<typeof createRegistrationAcceptanceService>
