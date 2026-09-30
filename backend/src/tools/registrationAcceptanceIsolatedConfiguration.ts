import mongoose from 'mongoose'
import {
  IDENTIFIER_MIGRATION_MARKER_COLLECTION,
  IDENTIFIER_MIGRATION_MARKER_ID,
  IDENTIFIER_MIGRATION_PURPOSE,
} from './identifierClaimMigrationConfig.js'

export const P7_EXECUTION_ACKNOWLEDGEMENT = 'movune-phase9-p7-controlled-acceptance'
export const P7_PRODUCTION_DATABASE = 'test'
export const P7_TEST_DATABASE = 'movune_phase9_test'
export const P7_PRODUCTION_CLUSTER = 'movune.ndbtzal.mongodb.net'
const P7_PRODUCTION_SEED_PATTERN = /^ac-[a-z0-9]+-shard-[0-9]{2}-[0-9]{2}\.ndbtzal\.mongodb\.net$/
export const P7_ACCEPTANCE_COLLECTION = 'registrationacceptanceruns'
export const P7_ACCEPTANCE_OPERATION_INDEX = 'consumedOperationIds_1'

const TEST_MARKER_COLLECTION = '__movune_test_target'
const TEST_MARKER_ID = 'movune-phase9-test-target'
const TEST_MARKER_PURPOSE = 'movune-phase9-test'

export type P7TargetProfile = 'production' | 'dedicated-test'

export type P7TargetConfiguration = Readonly<{
  uri: string
  databaseName: string
  username: string
  targetId: string
  targetProfile: P7TargetProfile
  markerCollection: string
  markerId: string
  markerPurpose: string
  environment: 'production'
  serviceId: string
  releaseSha: string
}>

export class RegistrationAcceptanceIsolationError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'RegistrationAcceptanceIsolationError'
  }
}

export const p7Stop = (code: string): never => {
  throw new RegistrationAcceptanceIsolationError(code)
}

const hasOwn = (environment: NodeJS.ProcessEnv, name: string) =>
  Object.prototype.hasOwnProperty.call(environment, name)

const required = (environment: NodeJS.ProcessEnv, name: string, code: string) => {
  const value = environment[name]
  if (typeof value !== 'string' || value.trim().length === 0) p7Stop(code)
  return value as string
}

type ParsedMongoOptions = Readonly<{
  dbName?: string
  srvHost?: string
  hosts: readonly Readonly<{ host?: string }>[]
  credentials?: Readonly<{ username?: string }>
  tls?: boolean
}>

const parseMongoOptions = (uri: string): ParsedMongoOptions => {
  try {
    return new mongoose.mongo.MongoClient(uri).options as unknown as ParsedMongoOptions
  } catch {
    return p7Stop('P7_DB_URI_INVALID')
  }
}

const markerFor = (profile: P7TargetProfile) =>
  profile === 'production'
    ? {
        markerCollection: IDENTIFIER_MIGRATION_MARKER_COLLECTION,
        markerId: IDENTIFIER_MIGRATION_MARKER_ID,
        markerPurpose: IDENTIFIER_MIGRATION_PURPOSE,
      }
    : {
        markerCollection: TEST_MARKER_COLLECTION,
        markerId: TEST_MARKER_ID,
        markerPurpose: TEST_MARKER_PURPOSE,
      }

export const validateP7TargetConfiguration = (
  environment: NodeJS.ProcessEnv,
  prefix: 'MOVUNE_P7' | 'MOVUNE_P7_VERIFY',
): P7TargetConfiguration => {
  if (hasOwn(environment, 'DB_URL')) p7Stop('APPLICATION_DB_URL_PRESENT')
  if (hasOwn(environment, 'MOVUNE_IDENTIFIER_MIGRATION_APPLY_ACK')) {
    p7Stop('MIGRATION_APPLY_ACK_PRESENT')
  }

  const uri = required(environment, `${prefix}_DB_URL`, 'P7_DB_URL_REQUIRED')
  const databaseName = required(environment, `${prefix}_DB_NAME`, 'P7_DB_NAME_REQUIRED')
  const username = required(
    environment,
    `${prefix}_EXPECTED_USERNAME`,
    'P7_EXPECTED_USERNAME_REQUIRED',
  )
  const targetId = required(environment, `${prefix}_TARGET_ID`, 'P7_TARGET_ID_REQUIRED')
  const profileValue = required(
    environment,
    `${prefix}_TARGET_PROFILE`,
    'P7_TARGET_PROFILE_REQUIRED',
  )
  if (profileValue !== 'production' && profileValue !== 'dedicated-test') {
    p7Stop('P7_TARGET_PROFILE_INVALID')
  }
  const targetProfile = profileValue as P7TargetProfile
  const expectedDatabase =
    targetProfile === 'production' ? P7_PRODUCTION_DATABASE : P7_TEST_DATABASE
  if (databaseName !== expectedDatabase) p7Stop('P7_DB_NAME_INVALID_FOR_PROFILE')

  const configuredEnvironment = required(
    environment,
    `${prefix}_ENVIRONMENT`,
    'P7_ENVIRONMENT_REQUIRED',
  )
  if (configuredEnvironment !== 'production') p7Stop('P7_ENVIRONMENT_INVALID')
  const serviceId = required(environment, `${prefix}_RENDER_SERVICE_ID`, 'P7_SERVICE_ID_REQUIRED')
  const releaseSha = required(environment, `${prefix}_RELEASE_SHA`, 'P7_RELEASE_SHA_REQUIRED')
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(serviceId)) p7Stop('P7_SERVICE_ID_INVALID')
  if (!/^[a-f0-9]{40}$/.test(releaseSha)) p7Stop('P7_RELEASE_SHA_INVALID')

  const options = parseMongoOptions(uri)
  if (options.dbName !== databaseName) p7Stop('P7_DB_NAME_MISMATCH')
  if (options.credentials?.username !== username) p7Stop('P7_DB_USERNAME_MISMATCH')
  if (options.tls !== true) p7Stop('P7_DB_TLS_REQUIRED')
  const hosts = options.srvHost
    ? [options.srvHost]
    : options.hosts
        .map(({ host }) => host)
        .filter((host): host is string => typeof host === 'string')
  if (
    hosts.length === 0 ||
    hosts.some((host) => {
      const normalized = host.toLowerCase().replace(/:\d+$/, '')
      return normalized !== P7_PRODUCTION_CLUSTER && !P7_PRODUCTION_SEED_PATTERN.test(normalized)
    })
  ) {
    p7Stop('P7_CLUSTER_IDENTITY_MISMATCH')
  }

  return Object.freeze({
    uri,
    databaseName,
    username,
    targetId,
    targetProfile,
    ...markerFor(targetProfile),
    environment: 'production' as const,
    serviceId,
    releaseSha,
  })
}

export const requireP7ExecutionAcknowledgement = (environment: NodeJS.ProcessEnv) => {
  const value = required(environment, 'MOVUNE_P7_EXECUTION_ACK', 'P7_EXECUTION_ACK_REQUIRED')
  if (value !== P7_EXECUTION_ACKNOWLEDGEMENT) p7Stop('P7_EXECUTION_ACK_INVALID')
}

export const P7_LEAST_PRIVILEGE_CONTRACT = Object.freeze({
  actions: Object.freeze({
    metadata: Object.freeze(['listCollections', 'listIndexes']),
    read: Object.freeze(['find']),
    normalWrite: Object.freeze(['insert', 'update']),
    explicitlyExcluded: Object.freeze([
      'remove',
      'createCollection',
      'createIndex',
      'dropCollection',
      'dropIndex',
    ]),
  }),
  read: Object.freeze([
    'users',
    'identifierclaims',
    'registrationacceptanceruns',
    'refreshtokens',
    'passwordresettokens',
    'favorites',
    'collections',
    'collectionmemberships',
    'follows',
    'userblocks',
    'notifications',
    'directconversations',
    'directconversationstates',
    'contactpairguards',
    'discussionmemberships',
    'discussionrooms',
    'messages',
    'reports',
    'accountenforcementactions',
    IDENTIFIER_MIGRATION_MARKER_COLLECTION,
  ]),
  insert: Object.freeze(['users', 'identifierclaims', 'registrationacceptanceruns']),
  update: Object.freeze(['registrationacceptanceruns']),
  deleteForNormalOperations: Object.freeze([]),
})
