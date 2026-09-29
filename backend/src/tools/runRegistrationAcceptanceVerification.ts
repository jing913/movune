import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  RegistrationAcceptanceVerificationError,
  runRegistrationAcceptanceVerification,
  validateRegistrationAcceptanceVerificationConfiguration,
} from './registrationAcceptanceVerification.js'

const required = (name: string) => {
  const value = process.env[name]
  if (typeof value !== 'string' || value.length === 0) {
    throw new RegistrationAcceptanceVerificationError('VERIFIER_FIXTURE_INPUT_MISSING')
  }
  return value
}

const main = async () => {
  try {
    const configuration = validateRegistrationAcceptanceVerificationConfiguration(process.env)
    const result = await runRegistrationAcceptanceVerification(configuration, {
      account: required('MOVUNE_I4C_VERIFY_SUCCESS_ACCOUNT'),
      email: required('MOVUNE_I4C_VERIFY_SUCCESS_EMAIL'),
      password: required('MOVUNE_I4C_VERIFY_SUCCESS_PASSWORD'),
    })
    process.stdout.write(
      `${JSON.stringify({
        outcome: result.inspection.outcome === 'partial' ? 'STOP' : 'PASS',
        state: result.state,
        fixtureState: result.inspection.outcome,
        violationCodes: result.inspection.violations,
      })}\n`,
    )
    process.exitCode = result.inspection.outcome === 'partial' ? 2 : 0
  } catch (error) {
    const code =
      error instanceof RegistrationAcceptanceVerificationError
        ? error.code
        : 'VERIFIER_UNEXPECTED_FAILURE'
    process.stdout.write(`${JSON.stringify({ outcome: 'STOP', code })}\n`)
    process.exitCode = 2
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) await main()
