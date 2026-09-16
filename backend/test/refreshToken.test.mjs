import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createRefreshCookieOptions } from '../dist/utils/refreshToken.js'

describe('Refresh cookie deployment options', () => {
  it('uses Lax without Secure for local development', () => {
    assert.deepEqual(createRefreshCookieOptions('development'), {
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      path: '/',
    })
  })

  it('uses SameSite=None with Secure for cross-site production requests', () => {
    assert.deepEqual(createRefreshCookieOptions('production'), {
      httpOnly: true,
      secure: true,
      sameSite: 'none',
      path: '/',
    })
  })
})
