import express, { type Request, type Response } from 'express'
import { rateLimit } from 'express-rate-limit'
import {
  RegistrationAcceptanceConfigurationError,
  resolveRegistrationAcceptanceConfiguration,
  type RegistrationAcceptanceConfiguration,
} from '../configs/registrationAcceptanceConfiguration.js'
import {
  RegistrationAcceptanceError,
  createRegistrationAcceptanceService,
  type RegistrationAcceptanceService,
} from '../services/registrationAcceptanceService.js'
import {
  RegistrationAcceptanceManifestError,
  verifyRegistrationAcceptanceManifest,
  type RegistrationAcceptanceOperation,
  type RegistrationRequest,
} from '../utils/registrationAcceptanceManifest.js'
import { RegistrationConflictError } from '../services/registrationService.js'

const unavailable = Object.freeze({
  error: Object.freeze({
    code: 'REGISTRATION_ACCEPTANCE_UNAVAILABLE',
    message: 'Registration acceptance is unavailable.',
  }),
})

const denied = Object.freeze({
  error: Object.freeze({
    code: 'REGISTRATION_ACCEPTANCE_DENIED',
    message: 'Registration acceptance authorization failed.',
  }),
})

type RouterOptions = Readonly<{
  configuration?: RegistrationAcceptanceConfiguration
  service?: RegistrationAcceptanceService
  disableRateLimit?: boolean
  now?: () => Date
}>

const stringValue = (value: unknown) => (typeof value === 'string' ? value : '')

const envelope = (body: unknown) => {
  const value = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
  return {
    runId: stringValue(value.runId),
    operationId: stringValue(value.operationId),
  }
}

const registration = (value: unknown): RegistrationRequest => {
  const record =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  return {
    account: stringValue(record.account),
    email: stringValue(record.email),
    password: stringValue(record.password),
  }
}

const capabilityFrom = (req: Request) => {
  const authorization = req.get('authorization')
  if (!authorization?.startsWith('Bearer '))
    throw new RegistrationAcceptanceManifestError('CAPABILITY_MISSING')
  const capability = authorization.slice('Bearer '.length)
  if (!capability) throw new RegistrationAcceptanceManifestError('CAPABILITY_MISSING')
  return capability
}

export const createRegistrationAcceptanceRouter = (options: RouterOptions = {}) => {
  const router = express.Router()
  let configuration = options.configuration
  let configurationError: unknown
  if (!configuration) {
    try {
      configuration = resolveRegistrationAcceptanceConfiguration()
    } catch (error) {
      configurationError = error
    }
  }
  const service = options.service ?? createRegistrationAcceptanceService()
  if (!options.disableRateLimit) {
    router.use(
      rateLimit({
        windowMs: 15 * 60 * 1000,
        limit: 10,
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        message: denied,
      }),
    )
  }

  const handler = (
    operation: RegistrationAcceptanceOperation,
    action: (
      service: RegistrationAcceptanceService,
      manifest: ReturnType<typeof verifyRegistrationAcceptanceManifest>,
      body: Record<string, unknown>,
    ) => Promise<Readonly<Record<string, unknown>>>,
    status = 200,
  ) => {
    return async (req: Request, res: Response) => {
      if (
        !configuration ||
        configurationError instanceof RegistrationAcceptanceConfigurationError
      ) {
        res.status(503).json(unavailable)
        return
      }
      try {
        const manifest = verifyRegistrationAcceptanceManifest(capabilityFrom(req), operation, {
          ...configuration,
          ...(options.now ? { now: options.now() } : {}),
        })
        const body =
          typeof req.body === 'object' && req.body !== null
            ? (req.body as Record<string, unknown>)
            : {}
        const result = await action(service, manifest, body)
        res.status(status).json(result)
      } catch (error) {
        if (error instanceof RegistrationConflictError) {
          res.status(409).json({ message: error.message, code: error.code })
          return
        }
        if (error instanceof RegistrationAcceptanceManifestError) {
          res.status(401).json(denied)
          return
        }
        if (error instanceof RegistrationAcceptanceError) {
          res.status(error.status).json({
            error: {
              code: error.code,
              message: 'Registration acceptance operation failed.',
            },
          })
          return
        }
        res.status(500).json({
          error: {
            code: 'REGISTRATION_ACCEPTANCE_INTERNAL_ERROR',
            message: 'Registration acceptance operation failed.',
          },
        })
      }
    }
  }

  router.post(
    '/prepare',
    handler('prepare', (value, manifest, body) => value.prepare(manifest, envelope(body)), 201),
  )
  router.post(
    '/success',
    handler(
      'success',
      (value, manifest, body) =>
        value.success(manifest, { ...envelope(body), ...registration(body.registration) }),
      201,
    ),
  )
  router.post(
    '/conflict',
    handler('conflict', (value, manifest, body) =>
      value.conflict(manifest, {
        ...envelope(body),
        ...registration(body.registration),
        success: registration(body.success),
      }),
    ),
  )
  router.post(
    '/resolve',
    handler('resolve', (value, manifest, body) =>
      value.resolve(manifest, {
        ...envelope(body),
        success: registration(body.success),
        ...(body.conflict === undefined ? {} : { conflict: registration(body.conflict) }),
      }),
    ),
  )
  router.post(
    '/revoke',
    handler('revoke', (value, manifest, body) => value.revoke(manifest, envelope(body))),
  )
  router.post(
    '/cleanup',
    handler('cleanup', (value, manifest, body) =>
      value.cleanup(manifest, {
        ...envelope(body),
        success: registration(body.success),
      }),
    ),
  )

  return router
}

export default createRegistrationAcceptanceRouter()
