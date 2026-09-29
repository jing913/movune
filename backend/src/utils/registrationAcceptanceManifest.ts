import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  timingSafeEqual,
  verify,
  type KeyObject,
} from 'node:crypto'
import { canonicalizeEmailIdentifier, canonicalizeUsernameIdentifier } from './identifierPolicy.js'

export const REGISTRATION_ACCEPTANCE_MANIFEST_VERSION = 1 as const
export const REGISTRATION_ACCEPTANCE_OPERATIONS = [
  'prepare',
  'success',
  'conflict',
  'resolve',
  'revoke',
  'cleanup',
] as const
export type RegistrationAcceptanceOperation = (typeof REGISTRATION_ACCEPTANCE_OPERATIONS)[number]

export const REGISTRATION_ACCEPTANCE_STATES = [
  'prepared',
  'success_executing',
  'success_no_effect',
  'success_completed',
  'conflict_executing',
  'conflict_no_effect',
  'conflict_verified',
  'cleaned',
  'stopped',
] as const
export type RegistrationAcceptanceState = (typeof REGISTRATION_ACCEPTANCE_STATES)[number]

export const REGISTRATION_ACCEPTANCE_PREDECESSORS = [
  'none',
  ...REGISTRATION_ACCEPTANCE_STATES,
] as const
export type RegistrationAcceptancePredecessor =
  (typeof REGISTRATION_ACCEPTANCE_PREDECESSORS)[number]

export const REGISTRATION_ACCEPTANCE_RESOLUTIONS = [
  'success_committed',
  'success_no_effect',
  'conflict_no_effect',
  'stop',
] as const
export type RegistrationAcceptanceResolution = (typeof REGISTRATION_ACCEPTANCE_RESOLUTIONS)[number]

export type RegistrationRequest = Readonly<{
  account: string
  email: string
  password: string
}>

export type RegistrationAcceptanceFixtureBinding = Readonly<{
  accountFingerprint: string
  emailFingerprint: string
  usernameCanonicalFingerprint: string
  emailCanonicalFingerprint: string
  passwordFingerprint: string
  requestFingerprint: string
}>

export type RegistrationAcceptanceManifest = Readonly<{
  version: 1
  keyId: string
  runId: string
  operationId: string
  operation: RegistrationAcceptanceOperation
  issuedAt: string
  expiresAt: string
  environment: string
  serviceId: string
  releaseSha: string
  expectedState: RegistrationAcceptancePredecessor
  successBinding: RegistrationAcceptanceFixtureBinding
  conflictBinding: RegistrationAcceptanceFixtureBinding
  resolution?: RegistrationAcceptanceResolution
  targetOperationId?: string
}>

export type ManifestVerificationContext = Readonly<{
  keyId: string
  publicKey: KeyObject
  environment: string
  serviceId: string
  releaseSha: string
  now?: Date
  clockToleranceMs?: number
  maximumLifetimeMs?: number
}>

export class RegistrationAcceptanceManifestError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'RegistrationAcceptanceManifestError'
  }
}

const fail = (code: string): never => {
  throw new RegistrationAcceptanceManifestError(code)
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/
const SHA_PATTERN = /^[a-f0-9]{40,64}$/

export const fingerprintRegistrationAcceptanceValue = (value: string) =>
  createHash('sha256').update(value, 'utf8').digest('hex')

export const createRegistrationAcceptanceFixtureBinding = (
  request: RegistrationRequest,
): RegistrationAcceptanceFixtureBinding => {
  const username = canonicalizeUsernameIdentifier(request.account)
  const email = canonicalizeEmailIdentifier(request.email)
  return Object.freeze({
    accountFingerprint: fingerprintRegistrationAcceptanceValue(request.account),
    emailFingerprint: fingerprintRegistrationAcceptanceValue(request.email),
    usernameCanonicalFingerprint: fingerprintRegistrationAcceptanceValue(username.canonicalKey),
    emailCanonicalFingerprint: fingerprintRegistrationAcceptanceValue(email.canonicalKey),
    passwordFingerprint: fingerprintRegistrationAcceptanceValue(request.password),
    requestFingerprint: fingerprintRegistrationAcceptanceValue(
      JSON.stringify([request.account, request.email, request.password]),
    ),
  })
}

export const fixtureBindingsEqual = (
  left: RegistrationAcceptanceFixtureBinding,
  right: RegistrationAcceptanceFixtureBinding,
) => {
  const leftBuffer = Buffer.from(JSON.stringify(canonicalBinding(left)))
  const rightBuffer = Buffer.from(JSON.stringify(canonicalBinding(right)))
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

const canonicalBinding = (binding: RegistrationAcceptanceFixtureBinding) => ({
  accountFingerprint: binding.accountFingerprint,
  emailFingerprint: binding.emailFingerprint,
  usernameCanonicalFingerprint: binding.usernameCanonicalFingerprint,
  emailCanonicalFingerprint: binding.emailCanonicalFingerprint,
  passwordFingerprint: binding.passwordFingerprint,
  requestFingerprint: binding.requestFingerprint,
})

const canonicalManifest = (manifest: RegistrationAcceptanceManifest) => ({
  version: manifest.version,
  keyId: manifest.keyId,
  runId: manifest.runId,
  operationId: manifest.operationId,
  operation: manifest.operation,
  issuedAt: manifest.issuedAt,
  expiresAt: manifest.expiresAt,
  environment: manifest.environment,
  serviceId: manifest.serviceId,
  releaseSha: manifest.releaseSha,
  expectedState: manifest.expectedState,
  successBinding: canonicalBinding(manifest.successBinding),
  conflictBinding: canonicalBinding(manifest.conflictBinding),
  ...(manifest.resolution === undefined ? {} : { resolution: manifest.resolution }),
  ...(manifest.targetOperationId === undefined
    ? {}
    : { targetOperationId: manifest.targetOperationId }),
})

export const registrationAcceptanceManifestBytes = (manifest: RegistrationAcceptanceManifest) =>
  Buffer.from(JSON.stringify(canonicalManifest(manifest)), 'utf8')

const exactKeys = (value: Record<string, unknown>, expected: readonly string[]) => {
  const actual = Object.keys(value).sort()
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === [...expected].sort()[index])
  )
}

const parseBinding = (value: unknown): RegistrationAcceptanceFixtureBinding => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail('MANIFEST_BINDING_INVALID')
  }
  const record = value as Record<string, unknown>
  const keys = [
    'accountFingerprint',
    'emailFingerprint',
    'usernameCanonicalFingerprint',
    'emailCanonicalFingerprint',
    'passwordFingerprint',
    'requestFingerprint',
  ] as const
  if (!exactKeys(record, keys)) return fail('MANIFEST_BINDING_INVALID')
  for (const key of keys) {
    if (typeof record[key] !== 'string' || !SHA256_PATTERN.test(record[key])) {
      return fail('MANIFEST_BINDING_INVALID')
    }
  }
  return record as RegistrationAcceptanceFixtureBinding
}

const parseManifest = (value: unknown): RegistrationAcceptanceManifest => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail('MANIFEST_PAYLOAD_INVALID')
  }
  const record = value as Record<string, unknown>
  const required = [
    'version',
    'keyId',
    'runId',
    'operationId',
    'operation',
    'issuedAt',
    'expiresAt',
    'environment',
    'serviceId',
    'releaseSha',
    'expectedState',
    'successBinding',
    'conflictBinding',
  ]
  const optional = ['resolution', 'targetOperationId']
  const keys = Object.keys(record)
  if (
    !required.every((key) => keys.includes(key)) ||
    keys.some((key) => !required.includes(key) && !optional.includes(key))
  ) {
    return fail('MANIFEST_PAYLOAD_INVALID')
  }
  if (record.version !== REGISTRATION_ACCEPTANCE_MANIFEST_VERSION) {
    return fail('MANIFEST_VERSION_UNSUPPORTED')
  }
  if (typeof record.keyId !== 'string' || !ID_PATTERN.test(record.keyId))
    fail('MANIFEST_KEY_ID_INVALID')
  if (typeof record.runId !== 'string' || !ID_PATTERN.test(record.runId))
    fail('MANIFEST_RUN_ID_INVALID')
  if (typeof record.operationId !== 'string' || !ID_PATTERN.test(record.operationId))
    fail('MANIFEST_OPERATION_ID_INVALID')
  if (
    !REGISTRATION_ACCEPTANCE_OPERATIONS.includes(
      record.operation as RegistrationAcceptanceOperation,
    )
  ) {
    fail('MANIFEST_OPERATION_INVALID')
  }
  if (
    !REGISTRATION_ACCEPTANCE_PREDECESSORS.includes(
      record.expectedState as RegistrationAcceptancePredecessor,
    )
  ) {
    fail('MANIFEST_PREDECESSOR_INVALID')
  }
  for (const key of ['issuedAt', 'expiresAt', 'environment', 'serviceId'] as const) {
    if (typeof record[key] !== 'string' || record[key].length === 0)
      fail('MANIFEST_PAYLOAD_INVALID')
  }
  if (typeof record.releaseSha !== 'string' || !SHA_PATTERN.test(record.releaseSha)) {
    fail('MANIFEST_RELEASE_INVALID')
  }
  if (
    record.resolution !== undefined &&
    !REGISTRATION_ACCEPTANCE_RESOLUTIONS.includes(
      record.resolution as RegistrationAcceptanceResolution,
    )
  ) {
    fail('MANIFEST_RESOLUTION_INVALID')
  }
  if (
    record.targetOperationId !== undefined &&
    (typeof record.targetOperationId !== 'string' || !ID_PATTERN.test(record.targetOperationId))
  ) {
    fail('MANIFEST_TARGET_OPERATION_INVALID')
  }
  const manifest = {
    ...record,
    successBinding: parseBinding(record.successBinding),
    conflictBinding: parseBinding(record.conflictBinding),
  } as RegistrationAcceptanceManifest
  const resolutionRequired = manifest.operation === 'resolve'
  const targetRequired = manifest.operation === 'revoke'
  if (resolutionRequired !== (manifest.resolution !== undefined))
    fail('MANIFEST_RESOLUTION_INVALID')
  if (targetRequired !== (manifest.targetOperationId !== undefined)) {
    fail('MANIFEST_TARGET_OPERATION_INVALID')
  }
  return manifest
}

export const parseRegistrationAcceptancePublicKey = (pem: string) => {
  try {
    const key = createPublicKey(pem)
    if (key.asymmetricKeyType !== 'ed25519') return fail('PUBLIC_KEY_INVALID')
    return key
  } catch {
    return fail('PUBLIC_KEY_INVALID')
  }
}

export const signRegistrationAcceptanceManifest = (
  manifest: RegistrationAcceptanceManifest,
  privateKeyPem: string,
) => {
  const validated = parseManifest(canonicalManifest(manifest))
  let privateKey: KeyObject
  try {
    privateKey = createPrivateKey(privateKeyPem)
  } catch {
    return fail('PRIVATE_KEY_INVALID')
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') return fail('PRIVATE_KEY_INVALID')
  const payload = registrationAcceptanceManifestBytes(validated)
  const signature = sign(null, payload, privateKey)
  return `${payload.toString('base64url')}.${signature.toString('base64url')}`
}

export const verifyRegistrationAcceptanceManifest = (
  capability: string,
  requestedOperation: RegistrationAcceptanceOperation,
  context: ManifestVerificationContext,
) => {
  const parts = capability.split('.')
  if (parts.length !== 2 || !parts[0] || !parts[1]) return fail('CAPABILITY_MALFORMED')
  let payload: Buffer
  let signature: Buffer
  let parsed: unknown
  try {
    payload = Buffer.from(parts[0], 'base64url')
    signature = Buffer.from(parts[1], 'base64url')
    parsed = JSON.parse(payload.toString('utf8'))
  } catch {
    return fail('CAPABILITY_MALFORMED')
  }
  const manifest = parseManifest(parsed)
  const canonical = registrationAcceptanceManifestBytes(manifest)
  if (canonical.length !== payload.length || !timingSafeEqual(canonical, payload)) {
    return fail('CAPABILITY_NON_CANONICAL')
  }
  if (!verify(null, payload, context.publicKey, signature))
    return fail('CAPABILITY_SIGNATURE_INVALID')
  if (manifest.keyId !== context.keyId) fail('CAPABILITY_KEY_ID_MISMATCH')
  if (manifest.operation !== requestedOperation) fail('CAPABILITY_OPERATION_MISMATCH')
  if (manifest.environment !== context.environment) fail('CAPABILITY_ENVIRONMENT_MISMATCH')
  if (manifest.serviceId !== context.serviceId) fail('CAPABILITY_SERVICE_MISMATCH')
  if (manifest.releaseSha !== context.releaseSha) fail('CAPABILITY_RELEASE_MISMATCH')
  const now = (context.now ?? new Date()).getTime()
  const issuedAt = Date.parse(manifest.issuedAt)
  const expiresAt = Date.parse(manifest.expiresAt)
  const tolerance = context.clockToleranceMs ?? 60_000
  const maximumLifetime = context.maximumLifetimeMs ?? 30 * 60_000
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt) {
    fail('CAPABILITY_TIME_INVALID')
  }
  if (issuedAt > now + tolerance) fail('CAPABILITY_NOT_YET_VALID')
  if (expiresAt < now - tolerance) fail('CAPABILITY_EXPIRED')
  if (expiresAt - issuedAt > maximumLifetime) fail('CAPABILITY_LIFETIME_INVALID')
  return manifest
}
