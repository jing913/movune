import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Connection } from 'mongoose'
import {
  createRegistrationAcceptanceModels,
  type RegistrationAcceptanceModels,
} from '../services/registrationAcceptanceService.js'
import {
  canonicalizeEmailIdentifier,
  canonicalizeUsernameIdentifier,
} from '../utils/identifierPolicy.js'
import {
  createRegistrationAcceptanceFixtureBinding,
  fixtureBindingsEqual,
  type RegistrationRequest,
} from '../utils/registrationAcceptanceManifest.js'
import {
  RegistrationAcceptanceIsolationError,
  p7Stop,
  validateP7TargetConfiguration,
} from './registrationAcceptanceIsolatedConfiguration.js'
import {
  openP7IsolatedConnection,
  verifyP7Infrastructure,
} from './registrationAcceptanceIsolatedRuntime.js'

type VerificationInput = Readonly<{
  runId: string
  success: RegistrationRequest
  conflict: RegistrationRequest
}>

const required = (environment: NodeJS.ProcessEnv, name: string) => {
  const value = environment[name]
  if (typeof value !== 'string' || value.length === 0) return p7Stop('P7_VERIFY_INPUT_REQUIRED')
  return value
}

const registration = (value: unknown): RegistrationRequest => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return p7Stop('P7_VERIFY_EVIDENCE_INVALID')
  }
  const record = value as Record<string, unknown>
  if (
    typeof record.account !== 'string' ||
    typeof record.email !== 'string' ||
    typeof record.password !== 'string'
  ) {
    return p7Stop('P7_VERIFY_EVIDENCE_INVALID')
  }
  return { account: record.account, email: record.email, password: record.password }
}

export const parseP7VerificationInput = (environment: NodeJS.ProcessEnv): VerificationInput => {
  if (Object.prototype.hasOwnProperty.call(environment, 'MOVUNE_P7_EXECUTION_ACK')) {
    p7Stop('P7_EXECUTION_ACK_FORBIDDEN_FOR_VERIFIER')
  }
  let value: unknown
  try {
    value = JSON.parse(required(environment, 'MOVUNE_P7_VERIFY_EVIDENCE_JSON'))
  } catch (error) {
    if (error instanceof RegistrationAcceptanceIsolationError) throw error
    return p7Stop('P7_VERIFY_EVIDENCE_INVALID')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return p7Stop('P7_VERIFY_EVIDENCE_INVALID')
  }
  const record = value as Record<string, unknown>
  if (typeof record.runId !== 'string' || record.runId.length === 0) {
    return p7Stop('P7_VERIFY_EVIDENCE_INVALID')
  }
  return Object.freeze({
    runId: record.runId,
    success: registration(record.success),
    conflict: registration(record.conflict),
  })
}

const fingerprint = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')

export const verifyP7Evidence = async (
  connection: Connection,
  configuration: ReturnType<typeof validateP7TargetConfiguration>,
  input: VerificationInput,
  models: RegistrationAcceptanceModels = createRegistrationAcceptanceModels(connection),
) => {
  const run = (await models.RegistrationAcceptanceRun.findById(input.runId).lean()) as Record<
    string,
    unknown
  > | null
  if (!run) return p7Stop('P7_VERIFY_RUN_NOT_FOUND')
  if (
    run.environment !== configuration.environment ||
    run.serviceId !== configuration.serviceId ||
    run.releaseSha !== configuration.releaseSha ||
    run.state !== 'conflict_verified'
  ) {
    return p7Stop('P7_VERIFY_RUN_SCOPE_INVALID')
  }

  const successBinding = createRegistrationAcceptanceFixtureBinding(input.success)
  const conflictBinding = createRegistrationAcceptanceFixtureBinding(input.conflict)
  if (
    !fixtureBindingsEqual(
      run.successBinding as ReturnType<typeof createRegistrationAcceptanceFixtureBinding>,
      successBinding,
    ) ||
    !fixtureBindingsEqual(
      run.conflictBinding as ReturnType<typeof createRegistrationAcceptanceFixtureBinding>,
      conflictBinding,
    )
  ) {
    return p7Stop('P7_VERIFY_FIXTURE_BINDING_INVALID')
  }

  const successUsername = canonicalizeUsernameIdentifier(input.success.account)
  const successEmail = canonicalizeEmailIdentifier(input.success.email)
  const conflictUsername = canonicalizeUsernameIdentifier(input.conflict.account)
  const conflictEmail = canonicalizeEmailIdentifier(input.conflict.email)
  if (
    successUsername.canonicalKey !== conflictUsername.canonicalKey ||
    successEmail.canonicalKey === conflictEmail.canonicalKey
  ) {
    return p7Stop('P7_VERIFY_CONFLICT_DESIGN_INVALID')
  }

  const [users, claims, conflictUsers, conflictEmailClaims] = await Promise.all([
    models.User.find({
      $or: [{ account: successUsername.representation }, { email: successEmail.representation }],
    })
      .select('_id account email role favoritesPublic messageRequestPreference createdAt updatedAt')
      .lean(),
    models.IdentifierClaim.find({
      $or: [
        { kind: 'username', canonicalKey: successUsername.canonicalKey },
        { kind: 'email', canonicalKey: successEmail.canonicalKey },
      ],
    })
      .select('_id kind canonicalKey ownerUserId state')
      .lean(),
    models.User.countDocuments({ email: conflictEmail.representation }),
    models.IdentifierClaim.countDocuments({
      kind: 'email',
      canonicalKey: conflictEmail.canonicalKey,
    }),
  ])
  if (users.length !== 1 || claims.length !== 2) {
    return p7Stop('P7_VERIFY_SUCCESS_CARDINALITY_INVALID')
  }
  const user = users[0] as Record<string, unknown>
  const userId = String(user._id)
  if (
    String(run.fixtureUserId) !== userId ||
    user.account !== successUsername.representation ||
    user.email !== successEmail.representation ||
    user.role !== 'user' ||
    user.favoritesPublic !== false ||
    user.messageRequestPreference !== 'all_members'
  ) {
    return p7Stop('P7_VERIFY_USER_STATE_INVALID')
  }

  const summaries = (claims as Record<string, unknown>[])
    .map((claim) => ({
      kind: claim.kind,
      canonicalKey: claim.canonicalKey,
      ownerUserId: String(claim.ownerUserId),
      state: claim.state,
    }))
    .sort((left, right) => String(left.kind).localeCompare(String(right.kind)))
  if (
    summaries[0]?.kind !== 'email' ||
    summaries[0].canonicalKey !== successEmail.canonicalKey ||
    summaries[0].ownerUserId !== userId ||
    summaries[0].state !== 'active' ||
    summaries[1]?.kind !== 'username' ||
    summaries[1].canonicalKey !== successUsername.canonicalKey ||
    summaries[1].ownerUserId !== userId ||
    summaries[1].state !== 'active'
  ) {
    return p7Stop('P7_VERIFY_CLAIM_OWNERSHIP_INVALID')
  }
  if (conflictUsers !== 0 || conflictEmailClaims !== 0) {
    return p7Stop('P7_VERIFY_CONFLICT_RESIDUE_PRESENT')
  }

  const events = Array.isArray(run.auditEvents)
    ? (run.auditEvents as Record<string, unknown>[])
    : []
  if (
    !events.some(({ outcome }) => outcome === 'success_completed') ||
    !events.some(({ outcome }) => outcome === 'conflict_verified')
  ) {
    return p7Stop('P7_VERIFY_AUDIT_TRAIL_INCOMPLETE')
  }

  return Object.freeze({
    type: 'p7-verification',
    outcome: 'PASS' as const,
    runFingerprint: fingerprint(input.runId),
    releaseSha: configuration.releaseSha,
    durableState: 'conflict_verified' as const,
    success: Object.freeze({
      userCount: 1,
      activeEmailClaimCount: 1,
      activeUsernameClaimCount: 1,
      commonOwner: true,
      canonicalKeys: 'PASS' as const,
      fixtureBindings: 'PASS' as const,
      userFingerprint: fingerprint(userId),
    }),
    conflict: Object.freeze({
      classification: 'REGISTRATION_ACCOUNT_CONFLICT',
      userResidueCount: 0,
      emailClaimResidueCount: 0,
      successOwnershipUnchanged: true,
    }),
  })
}

export const runP7ProductionVerification = async (
  environment: NodeJS.ProcessEnv = process.env,
  openConnection: (
    configuration: ReturnType<typeof validateP7TargetConfiguration>,
  ) => Promise<Connection> = openP7IsolatedConnection,
) => {
  const configuration = validateP7TargetConfiguration(environment, 'MOVUNE_P7_VERIFY')
  const input = parseP7VerificationInput(environment)
  const connection = await openConnection(configuration)
  try {
    const infrastructure = await verifyP7Infrastructure(connection, configuration)
    const evidence = await verifyP7Evidence(connection, configuration, input)
    return Object.freeze({ ...evidence, infrastructure })
  } finally {
    await connection.close().catch(() => undefined)
  }
}

const main = async () => {
  try {
    const result = await runP7ProductionVerification()
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } catch (error) {
    const code =
      error instanceof RegistrationAcceptanceIsolationError
        ? error.code
        : 'P7_VERIFY_UNEXPECTED_FAILURE'
    process.stdout.write(`${JSON.stringify({ type: 'p7-verification', outcome: 'STOP', code })}\n`)
    process.exitCode = 2
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) void main()
