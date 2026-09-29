import type { KeyObject } from 'node:crypto'
import { parseRegistrationAcceptancePublicKey } from '../utils/registrationAcceptanceManifest.js'

export type RegistrationAcceptanceConfiguration = Readonly<{
  environment: 'production'
  serviceId: string
  releaseSha: string
  keyId: string
  publicKey: KeyObject
}>

export class RegistrationAcceptanceConfigurationError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'RegistrationAcceptanceConfigurationError'
  }
}

const fail = (code: string): never => {
  throw new RegistrationAcceptanceConfigurationError(code)
}

const required = (environment: NodeJS.ProcessEnv, name: string) => {
  const value = environment[name]
  if (typeof value !== 'string' || value.trim().length === 0)
    return fail('I4C_CONFIGURATION_MISSING')
  return value.trim()
}

export const resolveRegistrationAcceptanceConfiguration = (
  environment: NodeJS.ProcessEnv = process.env,
): RegistrationAcceptanceConfiguration => {
  const configuredEnvironment = required(environment, 'MOVUNE_I4C_ENVIRONMENT')
  const serviceId = required(environment, 'MOVUNE_I4C_RENDER_SERVICE_ID')
  const releaseSha = required(environment, 'MOVUNE_I4C_RELEASE_SHA')
  const keyId = required(environment, 'MOVUNE_I4C_KEY_ID')
  const publicKeyPem = required(environment, 'MOVUNE_I4C_PUBLIC_KEY')
  if (configuredEnvironment !== 'production' || environment.NODE_ENV !== 'production') {
    return fail('I4C_ENVIRONMENT_INVALID')
  }
  if (environment.RENDER_SERVICE_ID !== serviceId) return fail('I4C_SERVICE_ID_MISMATCH')
  if (environment.RENDER_GIT_COMMIT !== releaseSha) return fail('I4C_RELEASE_SHA_MISMATCH')
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(keyId)) return fail('I4C_KEY_ID_INVALID')
  if (!/^[a-f0-9]{40,64}$/.test(releaseSha)) return fail('I4C_RELEASE_SHA_INVALID')
  return Object.freeze({
    environment: 'production',
    serviceId,
    releaseSha,
    keyId,
    publicKey: parseRegistrationAcceptancePublicKey(publicKeyPem),
  })
}
