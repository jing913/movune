import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { StatusCodes } from 'http-status-codes'

export type RegistrationReleaseState = 'legacy-gate-on' | 'stage4-gate-on' | 'stage4-gate-off'

export const REGISTRATION_RELEASE_STATE: RegistrationReleaseState = 'legacy-gate-on'

export const REGISTRATION_MIGRATION_GATE_STATUS = StatusCodes.SERVICE_UNAVAILABLE
export const REGISTRATION_MIGRATION_GATE_RESPONSE = Object.freeze({
  error: Object.freeze({
    code: 'REGISTRATION_TEMPORARILY_UNAVAILABLE',
    message: 'Registration is temporarily unavailable.',
  }),
})

export const REGISTRATION_GATE_BLOCKED_EVENT = 'REGISTRATION_GATE_BLOCKED_BEFORE_WRITER'

type RegistrationGateRejectionEvent = Readonly<{
  event: typeof REGISTRATION_GATE_BLOCKED_EVENT
  method: 'POST'
  path: '/api/auth/register'
  status: typeof REGISTRATION_MIGRATION_GATE_STATUS
  gateState: RegistrationReleaseState
}>

type RegistrationGateEventLogger = (event: RegistrationGateRejectionEvent) => void

const logRegistrationGateRejection: RegistrationGateEventLogger = (event) => {
  console.log(JSON.stringify(event))
}

const registrationIsBlocked = (state: RegistrationReleaseState) => {
  switch (state) {
    case 'legacy-gate-on':
    case 'stage4-gate-on':
      return true
    case 'stage4-gate-off':
      return false
    default:
      return true
  }
}

export const createRegistrationMigrationGate = (
  state: RegistrationReleaseState,
  logEvent: RegistrationGateEventLogger = logRegistrationGateRejection,
): RequestHandler => {
  return (_req: Request, res: Response, next: NextFunction) => {
    if (!registrationIsBlocked(state)) {
      next()
      return
    }

    logEvent({
      event: REGISTRATION_GATE_BLOCKED_EVENT,
      method: 'POST',
      path: '/api/auth/register',
      status: REGISTRATION_MIGRATION_GATE_STATUS,
      gateState: state,
    })

    res.status(REGISTRATION_MIGRATION_GATE_STATUS).json(REGISTRATION_MIGRATION_GATE_RESPONSE)
  }
}

export const registrationMigrationGate = createRegistrationMigrationGate(REGISTRATION_RELEASE_STATE)
