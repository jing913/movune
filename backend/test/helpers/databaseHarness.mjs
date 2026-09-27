import { randomUUID } from 'node:crypto'
import mongoose from 'mongoose'

export const TEST_DATABASE_NAME = 'movune_phase9_test'
export const TEST_DATABASE_PURPOSE = 'movune-phase9-test'
export const TEST_DATABASE_MARKER_COLLECTION = '__movune_test_target'
export const TEST_DATABASE_MARKER_ID = 'movune-phase9-test-target'

export class DatabaseHarnessError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'DatabaseHarnessError'
    this.code = code
  }
}

const fail = (code, message) => {
  throw new DatabaseHarnessError(code, message)
}

const requiredValue = (environment, name, code) => {
  const value = environment[name]
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(code, `${name} is required`)
  }
  return value
}

const isLoopbackHost = (host) => {
  const normalized = host.toLowerCase().replace(/^\[(.*)\]$/, '$1')
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === 'localhost'
}

const parseMongoClientOptions = (uri, mongooseInstance) => {
  try {
    const client = new mongooseInstance.mongo.MongoClient(uri)
    return client.options
  } catch {
    fail('TEST_DB_URI_INVALID', 'MOVUNE_TEST_DB_URL is not a valid MongoDB URI')
  }
}

export const validateDatabaseTestConfiguration = (
  environment,
  { mongooseInstance = mongoose } = {},
) => {
  if (Object.hasOwn(environment, 'DB_URL')) {
    fail('APPLICATION_DB_URL_PRESENT', 'DB_URL must not be present for safe database tests')
  }

  const uri = requiredValue(environment, 'MOVUNE_TEST_DB_URL', 'TEST_DB_URL_REQUIRED')
  const acknowledgement = requiredValue(
    environment,
    'MOVUNE_TEST_DB_DESTRUCTIVE_ACK',
    'TEST_DB_ACK_REQUIRED',
  )
  if (acknowledgement !== TEST_DATABASE_PURPOSE) {
    fail('TEST_DB_ACK_INVALID', 'Destructive database-test acknowledgement is invalid')
  }
  const targetId = requiredValue(
    environment,
    'MOVUNE_TEST_DB_TARGET_ID',
    'TEST_DB_TARGET_ID_REQUIRED',
  )

  const options = parseMongoClientOptions(uri, mongooseInstance)
  if (!options.dbName || options.dbName === 'test') {
    fail('TEST_DB_DATABASE_UNSAFE', 'The configured database is not a dedicated test database')
  }
  if (options.dbName !== TEST_DATABASE_NAME) {
    fail('TEST_DB_DATABASE_UNSAFE', 'The configured database is not a dedicated test database')
  }

  const hosts = options.srvHost
    ? [options.srvHost]
    : options.hosts.map((hostAddress) => hostAddress.host)
  if (hosts.length === 0) fail('TEST_DB_URI_INVALID', 'MongoDB URI contains no usable host')

  const loopback = hosts.every(isLoopbackHost)
  const username = options.credentials?.username
  const expectedUsername = environment.MOVUNE_TEST_DB_EXPECTED_USERNAME

  if (!loopback) {
    if (!username) {
      fail('TEST_DB_REMOTE_AUTH_REQUIRED', 'Remote database tests require authentication')
    }
    if (options.tls !== true) {
      fail('TEST_DB_REMOTE_TLS_REQUIRED', 'Remote database tests require TLS')
    }
    if (typeof expectedUsername !== 'string' || expectedUsername.length === 0) {
      fail(
        'TEST_DB_EXPECTED_USERNAME_REQUIRED',
        'Remote database tests require an expected dedicated username',
      )
    }
  }
  if (expectedUsername !== undefined && expectedUsername !== username) {
    fail('TEST_DB_USERNAME_MISMATCH', 'The configured database username is not the expected user')
  }

  return Object.freeze({
    uri,
    databaseName: options.dbName,
    targetId,
    loopback,
  })
}

const markerMatches = (marker, targetId) =>
  marker?._id === TEST_DATABASE_MARKER_ID &&
  marker.targetId === targetId &&
  marker.purpose === TEST_DATABASE_PURPOSE

export class DatabaseTestHarness {
  #environment
  #mongoose
  #configuration
  #state = 'unconfigured'
  #cleanupOperations = []

  constructor({ environment = process.env, mongooseInstance = mongoose } = {}) {
    this.#environment = environment
    this.#mongoose = mongooseInstance
    this.runId = randomUUID()
  }

  get state() {
    return this.#state
  }

  get ready() {
    return this.#state === 'ready'
  }

  preflight() {
    if (this.#state !== 'unconfigured') {
      fail('TEST_DB_STATE_INVALID', 'Database-test preflight cannot run in the current state')
    }
    this.#configuration = validateDatabaseTestConfiguration(this.#environment, {
      mongooseInstance: this.#mongoose,
    })
    this.#state = 'preflightValidated'
    return this.#configuration
  }

  #assertReady(operation) {
    if (!this.ready) {
      fail('TEST_DB_NOT_READY', `${operation} requires a verified database-test target`)
    }
  }

  async #readMarker(session) {
    return this.#mongoose.connection.db
      .collection(TEST_DATABASE_MARKER_COLLECTION)
      .findOne({ _id: TEST_DATABASE_MARKER_ID }, session ? { session } : undefined)
  }

  async #disconnectAfterFailure() {
    try {
      await this.#mongoose.disconnect()
    } finally {
      this.#state = 'closed'
    }
  }

  async connect() {
    if (this.#state === 'unconfigured') this.preflight()
    if (this.#state !== 'preflightValidated') {
      fail('TEST_DB_STATE_INVALID', 'Database-test connection cannot start in the current state')
    }

    try {
      await this.#mongoose.connect(this.#configuration.uri, {
        autoIndex: false,
        autoCreate: false,
        bufferCommands: false,
      })
      this.#state = 'connected'

      if (this.#mongoose.connection.db.databaseName !== TEST_DATABASE_NAME) {
        fail(
          'TEST_DB_CONNECTED_DATABASE_MISMATCH',
          'Connected database is not the dedicated target',
        )
      }
      const marker = await this.#readMarker()
      if (!markerMatches(marker, this.#configuration.targetId)) {
        fail('TEST_DB_MARKER_INVALID', 'Dedicated database-test target marker is invalid')
      }
      this.#state = 'targetVerified'

      const hello = await this.#mongoose.connection.db.admin().command({ hello: 1 })
      const transactionTopology = typeof hello.setName === 'string' || hello.msg === 'isdbgrid'
      if (
        hello.logicalSessionTimeoutMinutes == null ||
        !transactionTopology ||
        hello.isWritablePrimary !== true
      ) {
        fail('TEST_DB_TOPOLOGY_UNSUPPORTED', 'Database target is not transaction capable')
      }
      this.#state = 'capabilityVerified'

      const session = await this.#mongoose.connection.startSession()
      try {
        session.startTransaction()
        const transactionMarker = await this.#readMarker(session)
        if (!markerMatches(transactionMarker, this.#configuration.targetId)) {
          fail('TEST_DB_TRANSACTION_MARKER_INVALID', 'Transaction target marker is invalid')
        }
        await session.abortTransaction()
      } catch (error) {
        if (session.inTransaction()) await session.abortTransaction().catch(() => undefined)
        if (error instanceof DatabaseHarnessError) throw error
        fail('TEST_DB_TRANSACTION_PROBE_FAILED', 'Read-only transaction probe failed')
      } finally {
        await session.endSession()
      }

      this.#state = 'ready'
      return this
    } catch (error) {
      await this.#disconnectAfterFailure()
      if (error instanceof DatabaseHarnessError) throw error
      fail('TEST_DB_CONNECTION_FAILED', 'Dedicated database-test connection failed')
    }
  }

  async prepareIndexes(models) {
    this.#assertReady('Index preparation')
    if (!Array.isArray(models) || models.length === 0) {
      fail('TEST_DB_INDEX_MODELS_REQUIRED', 'Index preparation requires explicit models')
    }
    try {
      for (const model of models) await model.createIndexes()
    } catch {
      fail('TEST_DB_INDEX_PREPARATION_FAILED', 'Dedicated database-test index preparation failed')
    }
  }

  registerCleanup(operation) {
    this.#assertReady('Cleanup registration')
    if (typeof operation !== 'function') {
      fail('TEST_DB_CLEANUP_INVALID', 'Cleanup operation must be a function')
    }
    this.#cleanupOperations.push(operation)
  }

  async runCleanup() {
    this.#assertReady('Cleanup execution')
    const operations = this.#cleanupOperations.splice(0).reverse()
    let firstError
    for (const operation of operations) {
      try {
        await operation()
      } catch (error) {
        firstError ??= error
      }
    }
    if (firstError) fail('TEST_DB_CLEANUP_FAILED', 'Scoped database-test cleanup failed')
  }

  async close() {
    if (this.#state === 'closed') return
    this.#state = 'closing'
    try {
      await this.#mongoose.disconnect()
    } finally {
      this.#state = 'closed'
    }
  }
}

export const createDatabaseTestHarness = (options) => new DatabaseTestHarness(options)
