import mongoose from 'mongoose'
import {
  IDENTIFIER_MIGRATION_MARKER_COLLECTION,
  IDENTIFIER_MIGRATION_MARKER_ID,
  IDENTIFIER_MIGRATION_PURPOSE,
} from './identifierClaimMigrationConfig.js'
import { createRegistrationAcceptanceService } from '../services/registrationAcceptanceService.js'

export class RegistrationAcceptanceVerificationError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'RegistrationAcceptanceVerificationError'
  }
}

const stop = (code: string): never => {
  throw new RegistrationAcceptanceVerificationError(code)
}

const required = (environment: NodeJS.ProcessEnv, name: string) => {
  const value = environment[name]
  if (typeof value !== 'string' || value.trim().length === 0)
    return stop('VERIFIER_CONFIGURATION_MISSING')
  return value
}

export const validateRegistrationAcceptanceVerificationConfiguration = (
  environment: NodeJS.ProcessEnv,
) => {
  if (Object.prototype.hasOwnProperty.call(environment, 'DB_URL'))
    stop('APPLICATION_DB_URL_PRESENT')
  const uri = required(environment, 'MOVUNE_I4C_VERIFY_DB_URL')
  const databaseName = required(environment, 'MOVUNE_I4C_VERIFY_DB_NAME')
  const expectedUsername = required(environment, 'MOVUNE_I4C_VERIFY_EXPECTED_USERNAME')
  const targetId = required(environment, 'MOVUNE_I4C_VERIFY_TARGET_ID')
  const runId = required(environment, 'MOVUNE_I4C_VERIFY_RUN_ID')
  let options: mongoose.mongo.MongoClientOptions & {
    dbName?: string
    credentials?: { username?: string }
    srvHost?: string
    hosts: readonly { host?: string }[]
  }
  try {
    options = new mongoose.mongo.MongoClient(uri).options as typeof options
  } catch {
    return stop('VERIFIER_DB_URI_INVALID')
  }
  if (options.dbName !== databaseName || databaseName === 'test') stop('VERIFIER_DB_NAME_MISMATCH')
  if (options.credentials?.username !== expectedUsername) stop('VERIFIER_DB_USERNAME_MISMATCH')
  if (options.tls !== true) stop('VERIFIER_DB_TLS_REQUIRED')
  return Object.freeze({ uri, databaseName, targetId, runId })
}

export const runRegistrationAcceptanceVerification = async (
  configuration: ReturnType<typeof validateRegistrationAcceptanceVerificationConfiguration>,
  success: Readonly<{ account: string; email: string; password: string }>,
) => {
  await mongoose.connect(configuration.uri, {
    autoCreate: false,
    autoIndex: false,
    bufferCommands: false,
  })
  try {
    if (mongoose.connection.db?.databaseName !== configuration.databaseName) {
      return stop('VERIFIER_CONNECTED_DB_MISMATCH')
    }
    const marker = await mongoose.connection.db
      .collection<{ _id: string; targetId?: unknown; purpose?: unknown }>(
        IDENTIFIER_MIGRATION_MARKER_COLLECTION,
      )
      .findOne({ _id: IDENTIFIER_MIGRATION_MARKER_ID })
    if (
      marker?._id !== IDENTIFIER_MIGRATION_MARKER_ID ||
      marker.targetId !== configuration.targetId ||
      marker.purpose !== IDENTIFIER_MIGRATION_PURPOSE
    ) {
      return stop('VERIFIER_MARKER_MISMATCH')
    }
    return createRegistrationAcceptanceService().verify(configuration.runId, success)
  } finally {
    await mongoose.disconnect()
  }
}
