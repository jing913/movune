import { randomBytes, createHash } from 'node:crypto'
import type { CookieOptions } from 'express'

export const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000

// 原始RT
export const random = () => {
  return randomBytes(64).toString('hex')
}

// SHA-256 雜湊
export const hash = (token: string) => {
  return createHash('sha256').update(token).digest('hex')
}

export const createRefreshCookieOptions = (
  nodeEnvironment = process.env.NODE_ENV,
): CookieOptions => {
  const isProduction = nodeEnvironment === 'production'

  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'none' : 'lax',
    path: '/',
  }
}

export const refreshCookieOptions = createRefreshCookieOptions()

export const getRefreshCookieOptions = (rememberMe: boolean): CookieOptions => {
  if (!rememberMe) {
    return refreshCookieOptions
  }

  return {
    ...refreshCookieOptions,
    maxAge: REFRESH_TOKEN_TTL_MS,
  }
}
