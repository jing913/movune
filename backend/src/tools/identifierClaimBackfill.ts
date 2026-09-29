import mongoose, { Types } from 'mongoose'
import { IdentifierClaim } from '../models/identifierClaimModel.js'
import { User } from '../models/userModel.js'
import {
  IdentifierPolicyError,
  canonicalizeEmailIdentifier,
  canonicalizeUsernameIdentifier,
  type IdentifierKind,
} from '../utils/identifierPolicy.js'
import {
  IdentifierMigrationError,
  retryable,
  stop,
  type MigrationOutcome,
} from './identifierClaimMigrationConfig.js'

export type EligibleUser = Readonly<{
  userId: Types.ObjectId
  emailCanonicalKey: string
  usernameCanonicalKey: string
}>

export type ClaimDecision = Readonly<{
  kind: IdentifierKind
  outcome: 'COMPLETED' | 'NO_OP' | 'PENDING'
  code: string
}>

export type BackfillUserResult = Readonly<{
  userId: string
  outcome: 'COMPLETED' | 'PENDING' | 'NO_OP'
  claims: readonly ClaimDecision[]
}>

export type BackfillResult = Readonly<{
  outcome: 'COMPLETED' | 'PENDING' | 'NO_OP'
  usersExamined: number
  usersCompleted: number
  usersPending: number
  usersNoOp: number
  claimsCompleted: number
  claimsPending: number
  claimsNoOp: number
  userResults: readonly BackfillUserResult[]
}>

type BackfillDependencies = Readonly<{
  userModel?: typeof User
  claimModel?: typeof IdentifierClaim
  databaseConnection?: typeof mongoose.connection
  failurePoint?: 'after-email-create'
}>

type StoredClaim = Readonly<{
  ownerUserId?: unknown
  state?: unknown
}>

const userIdString = (value: unknown) =>
  value instanceof Types.ObjectId ? value.toString() : String(value)

const canonicalizeUser = (value: unknown): EligibleUser => {
  const candidate = value as { _id?: unknown; email?: unknown; account?: unknown }
  const objectId = candidate._id
  if (!(objectId instanceof Types.ObjectId)) stop('USER_ID_INVALID')
  const verifiedObjectId = objectId as Types.ObjectId
  const userId = verifiedObjectId.toString()
  if (typeof candidate.email !== 'string') stop('USER_EMAIL_INVALID', { userId, kind: 'email' })
  if (typeof candidate.account !== 'string') {
    stop('USER_USERNAME_INVALID', { userId, kind: 'username' })
  }

  try {
    const email = canonicalizeEmailIdentifier(candidate.email)
    const username = canonicalizeUsernameIdentifier(candidate.account)
    return {
      userId: verifiedObjectId,
      emailCanonicalKey: email.canonicalKey,
      usernameCanonicalKey: username.canonicalKey,
    }
  } catch (error) {
    if (error instanceof IdentifierPolicyError) stop('USER_IDENTIFIER_POLICY_INVALID', { userId })
    throw error
  }
}

export const scanEligibleUsers = async ({
  userModel = User,
}: Pick<BackfillDependencies, 'userModel'> = {}): Promise<EligibleUser[]> => {
  const users: EligibleUser[] = []
  const emailOwners = new Map<string, string>()
  const usernameOwners = new Map<string, string>()
  const cursor = userModel.find().select('_id email account').sort({ _id: 1 }).lean().cursor()

  for await (const rawUser of cursor) {
    const user = canonicalizeUser(rawUser)
    const id = user.userId.toString()
    const emailOwner = emailOwners.get(user.emailCanonicalKey)
    if (emailOwner !== undefined && emailOwner !== id) {
      stop('USER_CANONICAL_COLLISION', { userId: id, kind: 'email' })
    }
    const usernameOwner = usernameOwners.get(user.usernameCanonicalKey)
    if (usernameOwner !== undefined && usernameOwner !== id) {
      stop('USER_CANONICAL_COLLISION', { userId: id, kind: 'username' })
    }
    emailOwners.set(user.emailCanonicalKey, id)
    usernameOwners.set(user.usernameCanonicalKey, id)
    users.push(user)
  }

  return users
}

export const classifyStoredClaim = (
  claim: StoredClaim | null,
  expectedOwnerUserId: Types.ObjectId,
  kind: IdentifierKind,
): ClaimDecision => {
  if (!claim) return { kind, outcome: 'PENDING', code: 'CLAIM_MISSING' }
  if (userIdString(claim.ownerUserId) !== expectedOwnerUserId.toString()) {
    stop('CLAIM_OWNER_CONFLICT', { userId: expectedOwnerUserId.toString(), kind })
  }
  if (claim.state !== 'active') {
    stop('CLAIM_STATE_CONFLICT', { userId: expectedOwnerUserId.toString(), kind })
  }
  return { kind, outcome: 'NO_OP', code: 'CLAIM_ALREADY_OWNED' }
}

const loadClaim = async (
  claimModel: typeof IdentifierClaim,
  kind: IdentifierKind,
  canonicalKey: string,
  session?: Parameters<ReturnType<typeof IdentifierClaim.findOne>['session']>[0],
) => {
  const query = claimModel.findOne({ kind, canonicalKey }).select('ownerUserId state').lean()
  if (session) query.session(session)
  return (await query) as StoredClaim | null
}

const expectedClaims = (user: EligibleUser) =>
  [
    { kind: 'email' as const, canonicalKey: user.emailCanonicalKey },
    { kind: 'username' as const, canonicalKey: user.usernameCanonicalKey },
  ] as const

const isAmbiguousTransactionFailure = (error: unknown) => {
  if (typeof error !== 'object' || error === null) return false
  if ('code' in error && error.code === 11000) return true
  if ('hasErrorLabel' in error && typeof error.hasErrorLabel === 'function') {
    return (
      error.hasErrorLabel('UnknownTransactionCommitResult') ||
      error.hasErrorLabel('TransientTransactionError')
    )
  }
  return false
}

export const classifyAmbiguousUserResult = async (
  user: EligibleUser,
  preExisting: Readonly<Record<IdentifierKind, boolean>>,
  { claimModel = IdentifierClaim }: Pick<BackfillDependencies, 'claimModel'> = {},
): Promise<'COMPLETED'> => {
  const email = classifyStoredClaim(
    await loadClaim(claimModel, 'email', user.emailCanonicalKey),
    user.userId,
    'email',
  )
  const username = classifyStoredClaim(
    await loadClaim(claimModel, 'username', user.usernameCanonicalKey),
    user.userId,
    'username',
  )
  const emailExists = email.outcome === 'NO_OP'
  const usernameExists = username.outcome === 'NO_OP'

  if (emailExists && usernameExists) return 'COMPLETED'
  if (!emailExists && !usernameExists) {
    retryable('CLAIM_TRANSACTION_NOT_COMMITTED', { userId: user.userId.toString() })
  }
  const existingKind = emailExists ? 'email' : 'username'
  if (preExisting[existingKind]) {
    retryable('CLAIM_TRANSACTION_INCOMPLETE_RETRYABLE', {
      userId: user.userId.toString(),
      kind: existingKind,
    })
  }
  return stop('CLAIM_TRANSACTION_IMPOSSIBLE_PARTIAL', {
    userId: user.userId.toString(),
    kind: existingKind,
  })
}

const processDryRunUser = async (
  user: EligibleUser,
  claimModel: typeof IdentifierClaim,
): Promise<BackfillUserResult> => {
  const claims: ClaimDecision[] = []
  for (const expected of expectedClaims(user)) {
    claims.push(
      classifyStoredClaim(
        await loadClaim(claimModel, expected.kind, expected.canonicalKey),
        user.userId,
        expected.kind,
      ),
    )
  }
  const pending = claims.some(({ outcome }) => outcome === 'PENDING')
  return {
    userId: user.userId.toString(),
    outcome: pending ? 'PENDING' : 'NO_OP',
    claims,
  }
}

const processApplyUser = async (
  user: EligibleUser,
  {
    claimModel = IdentifierClaim,
    databaseConnection = mongoose.connection,
    failurePoint,
  }: Omit<BackfillDependencies, 'userModel'> = {},
): Promise<BackfillUserResult> => {
  const preExisting: Record<IdentifierKind, boolean> = { email: false, username: false }
  const created: IdentifierKind[] = []

  try {
    await databaseConnection.transaction(async (session) => {
      for (const expected of expectedClaims(user)) {
        const decision = classifyStoredClaim(
          await loadClaim(claimModel, expected.kind, expected.canonicalKey, session),
          user.userId,
          expected.kind,
        )
        preExisting[expected.kind] = decision.outcome === 'NO_OP'
      }

      for (const expected of expectedClaims(user)) {
        if (preExisting[expected.kind]) continue
        await claimModel.create(
          [
            {
              kind: expected.kind,
              canonicalKey: expected.canonicalKey,
              ownerUserId: user.userId,
              state: 'active',
            },
          ],
          { session },
        )
        created.push(expected.kind)
        if (failurePoint === 'after-email-create' && expected.kind === 'email') {
          throw new Error('INJECTED_FAILURE')
        }
      }
    })
  } catch (error) {
    if (error instanceof IdentifierMigrationError) throw error
    if (isAmbiguousTransactionFailure(error)) {
      await classifyAmbiguousUserResult(user, preExisting, { claimModel })
    }
    retryable('CLAIM_TRANSACTION_FAILED', { userId: user.userId.toString() })
  }

  const claims: ClaimDecision[] = []
  for (const expected of expectedClaims(user)) {
    const durable = classifyStoredClaim(
      await loadClaim(claimModel, expected.kind, expected.canonicalKey),
      user.userId,
      expected.kind,
    )
    if (durable.outcome !== 'NO_OP') {
      stop('CLAIM_POSTCONDITION_FAILED', { userId: user.userId.toString(), kind: expected.kind })
    }
    claims.push({
      kind: expected.kind,
      outcome: created.includes(expected.kind) ? 'COMPLETED' : 'NO_OP',
      code: created.includes(expected.kind) ? 'CLAIM_CREATED' : 'CLAIM_ALREADY_OWNED',
    })
  }

  return {
    userId: user.userId.toString(),
    outcome: created.length > 0 ? 'COMPLETED' : 'NO_OP',
    claims,
  }
}

const summarize = (userResults: readonly BackfillUserResult[]): BackfillResult => {
  const usersCompleted = userResults.filter(({ outcome }) => outcome === 'COMPLETED').length
  const usersPending = userResults.filter(({ outcome }) => outcome === 'PENDING').length
  const usersNoOp = userResults.filter(({ outcome }) => outcome === 'NO_OP').length
  const claimsPending = userResults
    .flatMap(({ claims }) => claims)
    .filter(({ outcome }) => outcome === 'PENDING').length
  const claimsNoOp = userResults
    .flatMap(({ claims }) => claims)
    .filter(({ code }) => code === 'CLAIM_ALREADY_OWNED').length
  const claimsCompleted = userResults
    .flatMap(({ claims }) => claims)
    .filter(({ code }) => code === 'CLAIM_CREATED').length
  let outcome: BackfillResult['outcome'] = 'NO_OP'
  if (usersPending > 0) outcome = 'PENDING'
  else if (usersCompleted > 0) outcome = 'COMPLETED'

  return {
    outcome,
    usersExamined: userResults.length,
    usersCompleted,
    usersPending,
    usersNoOp,
    claimsCompleted,
    claimsPending,
    claimsNoOp,
    userResults,
  }
}

export const runIdentifierClaimBackfill = async (
  apply: boolean,
  dependencies: BackfillDependencies = {},
): Promise<BackfillResult> => {
  const users = await scanEligibleUsers(
    dependencies.userModel === undefined ? {} : { userModel: dependencies.userModel },
  )
  const userResults: BackfillUserResult[] = []
  for (const user of users) {
    userResults.push(
      apply
        ? await processApplyUser(user, dependencies)
        : await processDryRunUser(user, dependencies.claimModel ?? IdentifierClaim),
    )
  }
  return summarize(userResults)
}

export const outcomePriority = (outcomes: readonly MigrationOutcome[]): MigrationOutcome => {
  if (outcomes.includes('STOP')) return 'STOP'
  if (outcomes.includes('RETRYABLE')) return 'RETRYABLE'
  if (outcomes.includes('PENDING')) return 'PENDING'
  if (outcomes.includes('COMPLETED')) return 'COMPLETED'
  if (outcomes.includes('PASS')) return 'PASS'
  return 'NO_OP'
}
