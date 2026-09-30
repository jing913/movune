import mongoose, { type ClientSession, type Connection } from 'mongoose'
import {
  createRegistrationAcceptanceModels,
  createRegistrationAcceptanceService,
  type RegistrationAcceptanceModels,
} from '../services/registrationAcceptanceService.js'
import { createRegistrationService } from '../services/registrationService.js'
import {
  P7_ACCEPTANCE_COLLECTION,
  P7_ACCEPTANCE_OPERATION_INDEX,
  p7Stop,
  type P7TargetConfiguration,
} from './registrationAcceptanceIsolatedConfiguration.js'

export type P7InfrastructureEvidence = Readonly<{
  databaseName: string
  targetProfile: string
  marker: 'PASS'
  topology: 'PASS'
  acceptanceCollection: 'PASS'
  operationIndex: 'PASS'
}>

export const openP7IsolatedConnection = async (configuration: P7TargetConfiguration) => {
  const connection = mongoose.createConnection(configuration.uri, {
    autoCreate: false,
    autoIndex: false,
    bufferCommands: false,
    dbName: configuration.databaseName,
  })
  try {
    await connection.asPromise()
    return connection
  } catch {
    await connection.close().catch(() => undefined)
    return p7Stop('P7_CONNECTION_FAILED')
  }
}

const exactOperationIndex = (index: Record<string, unknown>) => {
  const key = index.key
  return (
    index.name === P7_ACCEPTANCE_OPERATION_INDEX &&
    typeof key === 'object' &&
    key !== null &&
    JSON.stringify(key) === JSON.stringify({ consumedOperationIds: 1 }) &&
    index.unique === true &&
    index.sparse !== true &&
    index.partialFilterExpression === undefined &&
    index.hidden !== true &&
    index.collation === undefined
  )
}

export const verifyP7Infrastructure = async (
  connection: Connection,
  configuration: P7TargetConfiguration,
): Promise<P7InfrastructureEvidence> => {
  const database = connection.db
  if (!database || database.databaseName !== configuration.databaseName) {
    return p7Stop('P7_CONNECTED_DB_MISMATCH')
  }

  const hello = (await database.admin().command({ hello: 1 })) as Record<string, unknown>
  if (
    hello.isWritablePrimary !== true ||
    typeof hello.setName !== 'string' ||
    typeof hello.logicalSessionTimeoutMinutes !== 'number'
  ) {
    return p7Stop('P7_TOPOLOGY_UNSUPPORTED')
  }

  const marker = await database
    .collection<{ _id: string; targetId?: unknown; purpose?: unknown }>(
      configuration.markerCollection,
    )
    .findOne({ _id: configuration.markerId }, { projection: { _id: 1, targetId: 1, purpose: 1 } })
  if (
    marker?._id !== configuration.markerId ||
    marker.targetId !== configuration.targetId ||
    marker.purpose !== configuration.markerPurpose
  ) {
    return p7Stop('P7_TARGET_MARKER_MISMATCH')
  }

  const collections = await database
    .listCollections({ name: P7_ACCEPTANCE_COLLECTION }, { nameOnly: true })
    .toArray()
  if (collections.length !== 1 || collections[0]?.name !== P7_ACCEPTANCE_COLLECTION) {
    return p7Stop('P7_ACCEPTANCE_COLLECTION_MISSING')
  }

  const indexes = (await database
    .collection(P7_ACCEPTANCE_COLLECTION)
    .listIndexes()
    .toArray()) as Record<string, unknown>[]
  const matching = indexes.filter(exactOperationIndex)
  const sameKey = indexes.filter(
    ({ key }) => JSON.stringify(key) === JSON.stringify({ consumedOperationIds: 1 }),
  )
  if (matching.length !== 1 || sameKey.length !== 1) {
    return p7Stop('P7_ACCEPTANCE_INDEX_MISMATCH')
  }

  return Object.freeze({
    databaseName: configuration.databaseName,
    targetProfile: configuration.targetProfile,
    marker: 'PASS' as const,
    topology: 'PASS' as const,
    acceptanceCollection: 'PASS' as const,
    operationIndex: 'PASS' as const,
  })
}

const isolatedTransactionRunner =
  (connection: Connection) => (operation: (session: ClientSession) => Promise<void>) =>
    connection.transaction(operation)

export const createP7IsolatedServices = (
  connection: Connection,
  models: RegistrationAcceptanceModels = createRegistrationAcceptanceModels(connection),
) => {
  const transactionRunner = isolatedTransactionRunner(connection)
  const registrationWriter = createRegistrationService({
    transactionRunner,
    createClaim: (claim, session) => models.IdentifierClaim.create([claim], { session }),
    createUserDocument: (user) => new models.User(user),
  })
  const acceptanceService = createRegistrationAcceptanceService({
    models,
    transactionRunner,
    registrationWriter,
  })
  return Object.freeze({ models, registrationWriter, acceptanceService })
}
