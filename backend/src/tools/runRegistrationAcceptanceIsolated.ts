import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Connection } from 'mongoose'
import { RegistrationConflictError } from '../services/registrationService.js'
import {
  RegistrationAcceptanceError,
  type RegistrationAcceptanceService,
} from '../services/registrationAcceptanceService.js'
import {
  REGISTRATION_ACCEPTANCE_OPERATIONS,
  RegistrationAcceptanceManifestError,
  parseRegistrationAcceptancePublicKey,
  verifyRegistrationAcceptanceManifest,
  type RegistrationAcceptanceOperation,
  type RegistrationRequest,
} from '../utils/registrationAcceptanceManifest.js'
import {
  RegistrationAcceptanceIsolationError,
  requireP7ExecutionAcknowledgement,
  validateP7TargetConfiguration,
} from './registrationAcceptanceIsolatedConfiguration.js'
import {
  createP7IsolatedServices,
  openP7IsolatedConnection,
  verifyP7Infrastructure,
} from './registrationAcceptanceIsolatedRuntime.js'

export type P7CliOperation = RegistrationAcceptanceOperation | 'preflight'

const stop = (code: string): never => {
  throw new RegistrationAcceptanceIsolationError(code)
}

const required = (environment: NodeJS.ProcessEnv, name: string) => {
  const value = environment[name]
  if (typeof value !== 'string' || value.length === 0) return stop('P7_INPUT_REQUIRED')
  return value
}

export const parseP7CliOperation = (args: readonly string[]): P7CliOperation => {
  if (args.length !== 1) return stop('P7_CLI_INVALID')
  const operation = args[0]
  if (
    operation !== 'preflight' &&
    !REGISTRATION_ACCEPTANCE_OPERATIONS.includes(operation as RegistrationAcceptanceOperation)
  ) {
    return stop('P7_CLI_INVALID')
  }
  return operation as P7CliOperation
}

const record = (value: unknown, code = 'P7_REQUEST_INVALID') => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return stop(code)
  return value as Record<string, unknown>
}

const stringValue = (value: unknown) => (typeof value === 'string' ? value : '')

const registration = (value: unknown): RegistrationRequest => {
  const input = record(value)
  return {
    account: stringValue(input.account),
    email: stringValue(input.email),
    password: stringValue(input.password),
  }
}

const parseBody = (environment: NodeJS.ProcessEnv) => {
  try {
    return record(JSON.parse(required(environment, 'MOVUNE_P7_REQUEST_JSON')))
  } catch (error) {
    if (error instanceof RegistrationAcceptanceIsolationError) throw error
    return stop('P7_REQUEST_INVALID')
  }
}

const sanitizedIdentity = (value: string) =>
  createHash('sha256').update(value, 'utf8').digest('hex')

const executeServiceOperation = async (
  service: RegistrationAcceptanceService,
  operation: RegistrationAcceptanceOperation,
  manifest: ReturnType<typeof verifyRegistrationAcceptanceManifest>,
  body: Record<string, unknown>,
) => {
  const envelope = {
    runId: stringValue(body.runId),
    operationId: stringValue(body.operationId),
  }
  switch (operation) {
    case 'prepare':
      return service.prepare(manifest, envelope)
    case 'success':
      return service.success(manifest, { ...envelope, ...registration(body.registration) })
    case 'conflict':
      return service.conflict(manifest, {
        ...envelope,
        ...registration(body.registration),
        success: registration(body.success),
      })
    case 'resolve':
      return service.resolve(manifest, {
        ...envelope,
        success: registration(body.success),
        ...(body.conflict === undefined ? {} : { conflict: registration(body.conflict) }),
      })
    case 'revoke':
      return service.revoke(manifest, envelope)
    case 'cleanup':
      return service.cleanup(manifest, { ...envelope, success: registration(body.success) })
  }
}

export const runP7IsolatedOperation = async (
  operation: P7CliOperation,
  environment: NodeJS.ProcessEnv = process.env,
  openConnection: (
    configuration: ReturnType<typeof validateP7TargetConfiguration>,
  ) => Promise<Connection> = openP7IsolatedConnection,
) => {
  const configuration = validateP7TargetConfiguration(environment, 'MOVUNE_P7')
  let manifest: ReturnType<typeof verifyRegistrationAcceptanceManifest> | undefined
  let body: Record<string, unknown> | undefined
  if (operation !== 'preflight') {
    requireP7ExecutionAcknowledgement(environment)
    const keyId = required(environment, 'MOVUNE_P7_KEY_ID')
    const publicKey = parseRegistrationAcceptancePublicKey(
      required(environment, 'MOVUNE_P7_PUBLIC_KEY'),
    )
    manifest = verifyRegistrationAcceptanceManifest(
      required(environment, 'MOVUNE_P7_CAPABILITY'),
      operation,
      {
        environment: configuration.environment,
        serviceId: configuration.serviceId,
        releaseSha: configuration.releaseSha,
        keyId,
        publicKey,
      },
    )
    body = parseBody(environment)
  }

  const connection = await openConnection(configuration)
  try {
    const infrastructure = await verifyP7Infrastructure(connection, configuration)
    if (operation === 'preflight') {
      return Object.freeze({ operation, outcome: 'PASS' as const, infrastructure })
    }
    const { acceptanceService } = createP7IsolatedServices(connection)
    try {
      const result = await executeServiceOperation(
        acceptanceService,
        operation,
        manifest as NonNullable<typeof manifest>,
        body as NonNullable<typeof body>,
      )
      return Object.freeze({
        operation,
        outcome: 'PASS' as const,
        state: result.state,
        runFingerprint: sanitizedIdentity((manifest as NonNullable<typeof manifest>).runId),
        operationFingerprint: sanitizedIdentity(
          (manifest as NonNullable<typeof manifest>).operationId,
        ),
        infrastructure,
      })
    } catch (error) {
      if (operation === 'conflict' && error instanceof RegistrationConflictError) {
        return Object.freeze({
          operation,
          outcome: 'PASS' as const,
          state: 'conflict_verified' as const,
          classification: error.code,
          runFingerprint: sanitizedIdentity((manifest as NonNullable<typeof manifest>).runId),
          operationFingerprint: sanitizedIdentity(
            (manifest as NonNullable<typeof manifest>).operationId,
          ),
          infrastructure,
        })
      }
      throw error
    }
  } finally {
    await connection.close().catch(() => undefined)
  }
}

const errorCode = (error: unknown) => {
  if (
    error instanceof RegistrationAcceptanceIsolationError ||
    error instanceof RegistrationAcceptanceManifestError ||
    error instanceof RegistrationAcceptanceError
  ) {
    return error.code
  }
  if (error instanceof RegistrationConflictError) return error.code
  return 'P7_UNEXPECTED_FAILURE'
}

const main = async () => {
  try {
    const operation = parseP7CliOperation(process.argv.slice(2))
    const result = await runP7IsolatedOperation(operation)
    process.stdout.write(`${JSON.stringify({ type: 'p7-result', ...result })}\n`)
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ type: 'p7-result', outcome: 'STOP', code: errorCode(error) })}\n`,
    )
    process.exitCode = 2
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) void main()
