import mongoose from 'mongoose'
import type { IdentifierKind } from '../utils/identifierPolicy.js'

export const IDENTIFIER_MIGRATION_ACK = 'movune-identifier-migration'
export const IDENTIFIER_MIGRATION_APPLY_ACK = 'movune-identifier-migration-apply'
export const IDENTIFIER_MIGRATION_MARKER_COLLECTION = '__movune_migration_target'
export const IDENTIFIER_MIGRATION_MARKER_ID = 'movune-identifier-migration-target'
export const IDENTIFIER_MIGRATION_PURPOSE = 'movune-identifier-migration'

export type MigrationOperation = 'backfill' | 'reconcile'
export type MigrationMode = 'dry-run' | 'apply' | 'read-only'
export type MigrationOutcome = 'COMPLETED' | 'PASS' | 'PENDING' | 'RETRYABLE' | 'NO_OP' | 'STOP'

export type MigrationCli = Readonly<{
  operation: MigrationOperation
  mode: MigrationMode
  apply: boolean
}>

export type MigrationConfiguration = Readonly<{
  uri: string
  databaseName: string
  targetId: string
  loopback: boolean
  username?: string
}>

export class IdentifierMigrationError extends Error {
  readonly outcome: Exclude<MigrationOutcome, 'COMPLETED' | 'PASS' | 'NO_OP' | 'PENDING'>
  readonly code: string
  readonly userId?: string
  readonly kind?: IdentifierKind

  constructor(
    code: string,
    outcome: 'STOP' | 'RETRYABLE',
    options: Readonly<{ userId?: string; kind?: IdentifierKind }> = {},
  ) {
    super(code)
    this.name = 'IdentifierMigrationError'
    this.code = code
    this.outcome = outcome
    if (options.userId !== undefined) this.userId = options.userId
    if (options.kind !== undefined) this.kind = options.kind
  }
}

export const stop = (
  code: string,
  options?: Readonly<{ userId?: string; kind?: IdentifierKind }>,
): never => {
  throw new IdentifierMigrationError(code, 'STOP', options)
}

export const retryable = (
  code: string,
  options?: Readonly<{ userId?: string; kind?: IdentifierKind }>,
): never => {
  throw new IdentifierMigrationError(code, 'RETRYABLE', options)
}

const hasOwn = (environment: NodeJS.ProcessEnv, name: string) =>
  Object.prototype.hasOwnProperty.call(environment, name)

const required = (environment: NodeJS.ProcessEnv, name: string, code: string): string => {
  const value = environment[name]
  if (typeof value !== 'string' || value.trim().length === 0) stop(code)
  return value as string
}

const isLoopbackHost = (host: string) => {
  const normalized = host.toLowerCase().replace(/^\[(.*)\]$/, '$1')
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === 'localhost'
}

export const parseIdentifierMigrationCli = (args: readonly string[]): MigrationCli => {
  if (args.length === 1 && args[0] === 'backfill') {
    return { operation: 'backfill', mode: 'dry-run', apply: false }
  }
  if (args.length === 2 && args[0] === 'backfill' && args[1] === '--apply') {
    return { operation: 'backfill', mode: 'apply', apply: true }
  }
  if (args.length === 1 && args[0] === 'reconcile') {
    return { operation: 'reconcile', mode: 'read-only', apply: false }
  }
  return stop('CLI_INVALID')
}

type ParsedMongoOptions = Readonly<{
  dbName?: string
  srvHost?: string
  hosts: readonly Readonly<{ host?: string }>[]
  credentials?: Readonly<{ username?: string }>
  tls?: boolean
}>

const parseMongoOptions = (uri: string, mongooseInstance: typeof mongoose): ParsedMongoOptions => {
  try {
    return new mongooseInstance.mongo.MongoClient(uri).options as unknown as ParsedMongoOptions
  } catch {
    return stop('MIGRATION_DB_URI_INVALID')
  }
}

export const validateIdentifierMigrationConfiguration = (
  environment: NodeJS.ProcessEnv,
  cli: MigrationCli,
  { mongooseInstance = mongoose }: { mongooseInstance?: typeof mongoose } = {},
): MigrationConfiguration => {
  if (hasOwn(environment, 'DB_URL')) stop('APPLICATION_DB_URL_PRESENT')

  const uri = required(
    environment,
    'MOVUNE_IDENTIFIER_MIGRATION_DB_URL',
    'MIGRATION_DB_URL_REQUIRED',
  )
  const databaseName = required(
    environment,
    'MOVUNE_IDENTIFIER_MIGRATION_DB_NAME',
    'MIGRATION_DB_NAME_REQUIRED',
  )
  const targetId = required(
    environment,
    'MOVUNE_IDENTIFIER_MIGRATION_TARGET_ID',
    'MIGRATION_TARGET_ID_REQUIRED',
  )
  const acknowledgement = required(
    environment,
    'MOVUNE_IDENTIFIER_MIGRATION_ACK',
    'MIGRATION_ACK_REQUIRED',
  )
  if (acknowledgement !== IDENTIFIER_MIGRATION_ACK) stop('MIGRATION_ACK_INVALID')

  const applyAckPresent = hasOwn(environment, 'MOVUNE_IDENTIFIER_MIGRATION_APPLY_ACK')
  if (cli.apply) {
    const applyAcknowledgement = required(
      environment,
      'MOVUNE_IDENTIFIER_MIGRATION_APPLY_ACK',
      'MIGRATION_APPLY_ACK_REQUIRED',
    )
    if (applyAcknowledgement !== IDENTIFIER_MIGRATION_APPLY_ACK) stop('MIGRATION_APPLY_ACK_INVALID')
  } else if (applyAckPresent) {
    stop('MIGRATION_APPLY_ACK_FORBIDDEN')
  }

  const options = parseMongoOptions(uri, mongooseInstance)

  if (!options.dbName || options.dbName !== databaseName) stop('MIGRATION_DB_NAME_MISMATCH')
  const hosts = options.srvHost
    ? [options.srvHost]
    : options.hosts
        .map((hostAddress) => hostAddress.host)
        .filter((host): host is string => typeof host === 'string')
  if (hosts.length === 0) stop('MIGRATION_DB_HOST_REQUIRED')
  const loopbackHosts = hosts.filter(isLoopbackHost)
  if (loopbackHosts.length > 0 && loopbackHosts.length !== hosts.length) {
    stop('MIGRATION_DB_MIXED_HOSTS')
  }
  const loopback = loopbackHosts.length === hosts.length
  const username = options.credentials?.username
  const expectedUsername = environment.MOVUNE_IDENTIFIER_MIGRATION_EXPECTED_USERNAME

  if (!loopback) {
    if (!username) stop('MIGRATION_DB_REMOTE_AUTH_REQUIRED')
    if (options.tls !== true) stop('MIGRATION_DB_REMOTE_TLS_REQUIRED')
    if (typeof expectedUsername !== 'string' || expectedUsername.length === 0) {
      stop('MIGRATION_DB_EXPECTED_USERNAME_REQUIRED')
    }
  }
  if (expectedUsername !== undefined && expectedUsername !== username) {
    stop('MIGRATION_DB_USERNAME_MISMATCH')
  }

  return Object.freeze({
    uri,
    databaseName,
    targetId,
    loopback,
    ...(username === undefined ? {} : { username }),
  })
}

export const exitCodeForOutcome = (outcome: MigrationOutcome) => {
  if (outcome === 'COMPLETED' || outcome === 'PASS' || outcome === 'NO_OP') return 0
  if (outcome === 'STOP') return 2
  if (outcome === 'PENDING') return 3
  return 4
}
