import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  createFrontendApplicationUrl,
  resolveFrontendConfiguration,
} from '../dist/configs/frontendConfiguration.js'

describe('frontend deployment configuration', () => {
  it('keeps the repository path when creating a production password-reset URL', () => {
    const configuration = resolveFrontendConfiguration({
      FRONTEND_APP_URL: 'https://github-username.github.io/movune/',
      FRONTEND_ORIGIN: 'https://github-username.github.io',
    })

    const resetUrl = createFrontendApplicationUrl('reset-password', configuration)
    resetUrl.searchParams.set('token', 'test-only-token')

    assert.equal(
      resetUrl.toString(),
      'https://github-username.github.io/movune/reset-password?token=test-only-token',
    )
  })

  it('preserves the local-development URL behavior', () => {
    const configuration = resolveFrontendConfiguration({
      FRONTEND_APP_URL: 'http://localhost:5173/',
      FRONTEND_ORIGIN: 'http://localhost:5173',
    })

    assert.equal(configuration.origin, 'http://localhost:5173')
    assert.equal(
      createFrontendApplicationUrl('reset-password', configuration).toString(),
      'http://localhost:5173/reset-password',
    )
  })

  it('rejects a CORS origin that contains a path', () => {
    assert.throws(
      () =>
        resolveFrontendConfiguration({
          FRONTEND_APP_URL: 'https://github-username.github.io/movune/',
          FRONTEND_ORIGIN: 'https://github-username.github.io/movune/',
        }),
      /FRONTEND_ORIGIN must contain only the frontend origin/,
    )
  })

  it('rejects frontend URLs whose origins do not match', () => {
    assert.throws(
      () =>
        resolveFrontendConfiguration({
          FRONTEND_APP_URL: 'https://github-username.github.io/movune/',
          FRONTEND_ORIGIN: 'https://example.com',
        }),
      /must use the same origin/,
    )
  })
})
