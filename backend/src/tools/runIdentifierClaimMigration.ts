import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import mongoose from 'mongoose'
import { IdentifierClaim } from '../models/identifierClaimModel.js'
import { User } from '../models/userModel.js'
import {
  IDENTIFIER_MIGRATION_MARKER_COLLECTION,
  IDENTIFIER_MIGRATION_MARKER_ID,
  IDENTIFIER_MIGRATION_PURPOSE,
  IdentifierMigrationError,
  exitCodeForOutcome,
  parseIdentifierMigrationCli,
  stop,
  validateIdentifierMigrationConfiguration,
  type MigrationConfiguration,
  type MigrationOutcome,
} from './identifierClaimMigrationConfig.js'
import { runIdentifierClaimBackfill } from './identifierClaimBackfill.js'
import { runIdentifierClaimReconciliation } from './identifierClaimReconciliation.js'

type IndexMetadata = Readonly<{
  name?: string
  key?: Readonly<Record<string, number>>
  unique?: boolean
  sparse?: boolean
  hidden?: boolean
  expireAfterSeconds?: number
  partialFilterExpression?: unknown
  collation?: Readonly<{ locale?: string }>
}>

const emit = (record: Readonly<Record<string, unknown>>) => {
  process.stdout.write(`${JSON.stringify(record)}\n`)
}

const exactKey = (index: IndexMetadata, expected: readonly (readonly [string, number])[]) => {
  const entries = Object.entries(index.key ?? {})
  return (
    entries.length === expected.length &&
    entries.every(([field, direction], position) => {
      const pair = expected[position]
      return pair !== undefined && pair[0] === field && pair[1] === direction
    })
  )
}

const safeUniqueIndex = (index: IndexMetadata) =>
  index.unique === true &&
  index.sparse !== true &&
  index.hidden !== true &&
  index.expireAfterSeconds === undefined &&
  index.partialFilterExpression === undefined &&
  (index.collation === undefined || index.collation.locale === 'simple')

const requiredDatabase = () => {
  const database = mongoose.connection.db
  if (!database) return stop('MIGRATION_DATABASE_UNAVAILABLE')
  return database
}

export const assertIdentifierMigrationSchema = () => {
  const emailPath = User.schema.path('email').options
  const accountPath = User.schema.path('account').options
  const statePath = IdentifierClaim.schema.path('state').options
  if (emailPath.required !== true || emailPath.unique !== true) stop('USER_EMAIL_SCHEMA_MISMATCH')
  if (accountPath.required !== true || accountPath.unique !== true) {
    stop('USER_ACCOUNT_SCHEMA_MISMATCH')
  }
  if (
    statePath.required !== true ||
    statePath.default !== undefined ||
    !Array.isArray(statePath.enum) ||
    statePath.enum.join(',') !== 'active,reserved'
  ) {
    stop('IDENTIFIER_CLAIM_STATE_SCHEMA_MISMATCH')
  }
  if (IdentifierClaim.schema.options.autoIndex !== false) stop('CLAIM_AUTOINDEX_UNSAFE')
  if (IdentifierClaim.schema.options.autoCreate !== false) stop('CLAIM_AUTOCREATE_UNSAFE')
}

export const verifyRequiredIndexes = async () => {
  const database = requiredDatabase()
  let userIndexes: IndexMetadata[] = []
  let claimIndexes: IndexMetadata[] = []
  try {
    userIndexes = (await database.collection(User.collection.name).indexes()) as IndexMetadata[]
    claimIndexes = (await database
      .collection(IdentifierClaim.collection.name)
      .indexes()) as IndexMetadata[]
  } catch {
    stop('MIGRATION_REQUIRED_COLLECTION_OR_INDEX_MISSING')
  }

  const emailIndex = userIndexes.find(({ name }) => name === 'email_1')
  if (!emailIndex || !exactKey(emailIndex, [['email', 1]]) || !safeUniqueIndex(emailIndex)) {
    stop('USER_EMAIL_INDEX_MISMATCH')
  }
  const accountIndex = userIndexes.find(({ name }) => name === 'account_1')
  if (
    !accountIndex ||
    !exactKey(accountIndex, [['account', 1]]) ||
    !safeUniqueIndex(accountIndex)
  ) {
    stop('USER_ACCOUNT_INDEX_MISMATCH')
  }
  const claimIndex = claimIndexes.find(
    (index) =>
      exactKey(index, [
        ['kind', 1],
        ['canonicalKey', 1],
      ]) && safeUniqueIndex(index),
  )
  if (!claimIndex) stop('IDENTIFIER_CLAIM_INDEX_MISMATCH')
}

export const verifyMigrationTarget = async (configuration: MigrationConfiguration) => {
  const database = requiredDatabase()
  if (database.databaseName !== configuration.databaseName) stop('MIGRATION_CONNECTED_DB_MISMATCH')

  const marker = await database
    .collection<{ _id: string; targetId?: unknown; purpose?: unknown }>(
      IDENTIFIER_MIGRATION_MARKER_COLLECTION,
    )
    .findOne({ _id: IDENTIFIER_MIGRATION_MARKER_ID })
  if (
    marker?._id !== IDENTIFIER_MIGRATION_MARKER_ID ||
    marker.targetId !== configuration.targetId ||
    marker.purpose !== IDENTIFIER_MIGRATION_PURPOSE
  ) {
    stop('MIGRATION_MARKER_MISMATCH')
  }

  const hello = await database.admin().command({ hello: 1 })
  const transactionTopology = typeof hello.setName === 'string' || hello.msg === 'isdbgrid'
  if (
    hello.logicalSessionTimeoutMinutes == null ||
    !transactionTopology ||
    hello.isWritablePrimary !== true
  ) {
    stop('MIGRATION_TOPOLOGY_UNSUPPORTED')
  }

  const session = await mongoose.connection.startSession()
  try {
    session.startTransaction()
    const transactionMarker = await database
      .collection<{ _id: string; targetId?: unknown; purpose?: unknown }>(
        IDENTIFIER_MIGRATION_MARKER_COLLECTION,
      )
      .findOne({ _id: IDENTIFIER_MIGRATION_MARKER_ID }, { session })
    if (
      transactionMarker?._id !== IDENTIFIER_MIGRATION_MARKER_ID ||
      transactionMarker.targetId !== configuration.targetId ||
      transactionMarker.purpose !== IDENTIFIER_MIGRATION_PURPOSE
    ) {
      stop('MIGRATION_TRANSACTION_MARKER_MISMATCH')
    }
    await session.abortTransaction()
  } catch (error) {
    if (session.inTransaction()) await session.abortTransaction().catch(() => undefined)
    if (error instanceof IdentifierMigrationError) throw error
    stop('MIGRATION_TRANSACTION_PROBE_FAILED')
  } finally {
    await session.endSession()
  }
}

const main = async () => {
  let stage = 'cli'
  let outcome: MigrationOutcome
  try {
    const cli = parseIdentifierMigrationCli(process.argv.slice(2))
    stage = 'configuration'
    const configuration = validateIdentifierMigrationConfiguration(process.env, cli)
    assertIdentifierMigrationSchema()

    stage = 'connection'
    await mongoose.connect(configuration.uri, {
      autoIndex: false,
      autoCreate: false,
      bufferCommands: false,
    })
    stage = 'target-preflight'
    await verifyMigrationTarget(configuration)
    await verifyRequiredIndexes()

    if (cli.operation === 'backfill') {
      stage = cli.apply ? 'backfill-apply' : 'backfill-dry-run'
      const result = await runIdentifierClaimBackfill(cli.apply)
      for (const user of result.userResults) {
        for (const claim of user.claims) {
          emit({
            type: 'claim',
            operation: cli.operation,
            mode: cli.mode,
            stage,
            outcome: claim.outcome,
            code: claim.code,
            userId: user.userId,
            kind: claim.kind,
          })
        }
        emit({
          type: 'user',
          operation: cli.operation,
          mode: cli.mode,
          stage,
          outcome: user.outcome,
          code: `USER_${user.outcome}`,
          userId: user.userId,
        })
      }
      outcome = result.outcome
      emit({
        type: 'summary',
        operation: cli.operation,
        mode: cli.mode,
        stage,
        outcome: result.outcome,
        usersExamined: result.usersExamined,
        usersCompleted: result.usersCompleted,
        usersPending: result.usersPending,
        usersNoOp: result.usersNoOp,
        claimsCompleted: result.claimsCompleted,
        claimsPending: result.claimsPending,
        claimsNoOp: result.claimsNoOp,
      })
    } else {
      stage = 'reconciliation'
      const result = await runIdentifierClaimReconciliation()
      outcome = result.outcome
      emit({ type: 'summary', operation: cli.operation, mode: cli.mode, stage, ...result })
    }
  } catch (error) {
    if (error instanceof IdentifierMigrationError) {
      outcome = error.outcome
      emit({
        type: 'error',
        stage,
        outcome,
        code: error.code,
        ...(error.userId === undefined ? {} : { userId: error.userId }),
        ...(error.kind === undefined ? {} : { kind: error.kind }),
      })
    } else {
      outcome = 'RETRYABLE'
      emit({ type: 'error', stage, outcome, code: 'MIGRATION_UNEXPECTED_FAILURE' })
    }
  } finally {
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect().catch(() => undefined)
  }
  process.exitCode = exitCodeForOutcome(outcome)
}

const invokedPath = process.argv[1]
if (invokedPath && pathToFileURL(resolve(invokedPath)).href === import.meta.url) {
  void main()
}
