import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  REGISTRATION_ACCEPTANCE_OPERATIONS,
  signRegistrationAcceptanceManifest,
  type RegistrationAcceptanceManifest,
  type RegistrationAcceptanceOperation,
} from '../utils/registrationAcceptanceManifest.js'

const stop = (code: string): never => {
  throw new Error(code)
}

const required = (name: string) => {
  const value = process.env[name]
  if (typeof value !== 'string' || value.length === 0) return stop('CAPABILITY_TOOL_INPUT_MISSING')
  return value
}

export const createRegistrationAcceptanceCapability = (
  operation: RegistrationAcceptanceOperation,
  manifestJson: string,
  privateKeyPem: string,
) => {
  let manifest: RegistrationAcceptanceManifest
  try {
    manifest = JSON.parse(manifestJson) as RegistrationAcceptanceManifest
  } catch {
    return stop('CAPABILITY_TOOL_MANIFEST_INVALID')
  }
  if (manifest.operation !== operation) return stop('CAPABILITY_TOOL_OPERATION_MISMATCH')
  return signRegistrationAcceptanceManifest(manifest, privateKeyPem)
}

const main = () => {
  const operation = process.argv[2]
  if (!REGISTRATION_ACCEPTANCE_OPERATIONS.includes(operation as RegistrationAcceptanceOperation)) {
    return stop('CAPABILITY_TOOL_OPERATION_INVALID')
  }
  const capability = createRegistrationAcceptanceCapability(
    operation as RegistrationAcceptanceOperation,
    required('MOVUNE_I4C_CAPABILITY_MANIFEST'),
    required('MOVUNE_I4C_CAPABILITY_PRIVATE_KEY'),
  )
  process.stdout.write(`${capability}\n`)
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) main()
