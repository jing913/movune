import type { Request, Response, NextFunction } from 'express'
import { StatusCodes } from 'http-status-codes'
import * as yup from 'yup'
import { ApiProblem, invalidInput } from '../utils/messagingPolicy.js'

type JsonParseError = SyntaxError & {
  body?: unknown
  type?: unknown
}

const privacyPrimitiveBodyProblem = (err: unknown, req: Request) => {
  if (
    req.method !== 'PATCH' ||
    req.path !== '/api/users/me/privacy' ||
    !(err instanceof SyntaxError) ||
    (err as JsonParseError).type !== 'entity.parse.failed' ||
    typeof (err as JsonParseError).body !== 'string'
  ) {
    return null
  }

  try {
    const parsed: unknown = JSON.parse((err as JsonParseError).body as string)
    if (parsed === null || typeof parsed !== 'object') {
      return invalidInput('messageRequestPreference')
    }
  } catch {
    return null
  }
  return null
}

const reportPrimitiveBodyProblem = (err: unknown, req: Request) => {
  if (
    req.method !== 'POST' ||
    !(
      /^\/api\/users\/[^/]+\/report$/.test(req.path) ||
      /^\/api\/direct-conversations\/[^/]+\/report-user$/.test(req.path) ||
      /^\/api\/messages\/[^/]+\/report$/.test(req.path)
    ) ||
    !(err instanceof SyntaxError) ||
    (err as JsonParseError).type !== 'entity.parse.failed' ||
    typeof (err as JsonParseError).body !== 'string'
  ) {
    return null
  }

  try {
    const parsed: unknown = JSON.parse((err as JsonParseError).body as string)
    if (parsed === null || typeof parsed !== 'object') return invalidInput('reason')
  } catch {
    return null
  }
  return null
}

export const errorHandler = (err: unknown, req: Request, res: Response, _next: NextFunction) => {
  const primitiveBodyProblem =
    privacyPrimitiveBodyProblem(err, req) ?? reportPrimitiveBodyProblem(err, req)
  if (primitiveBodyProblem) err = primitiveBodyProblem

  if (err instanceof ApiProblem) {
    res
      .status(err.status)
      .json({ error: { code: err.code, message: err.message, details: err.details } })
    return
  }
  if (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    err.code === 11000 &&
    'keyPattern' in err &&
    typeof err.keyPattern === 'object' &&
    err.keyPattern !== null
  ) {
    if ('account' in err.keyPattern) {
      res.status(StatusCodes.CONFLICT).json({
        message: 'Account already exists',
      })
      return
    }
    if ('email' in err.keyPattern) {
      res.status(StatusCodes.CONFLICT).json({
        message: 'Email already exists',
      })
      return
    }
  }

  if (err instanceof yup.ValidationError) {
    res.status(StatusCodes.BAD_REQUEST).json({
      message: err.message,
    })

    return
  }

  if (process.env.NODE_ENV === 'production') {
    console.error('Unhandled application error', err)
  }

  const message =
    process.env.NODE_ENV === 'production'
      ? 'Internal server error'
      : err instanceof Error
        ? err.message
        : 'Unknown error'

  res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
    message,
  })
}
