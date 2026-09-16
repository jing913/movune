import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isSelfFollow } from '../dist/utils/followPolicy.js'

describe('Follow policy', () => {
  it('identifies a self-follow attempt', () => {
    assert.equal(isSelfFollow('64b64c0a4f4c6a2e9c6d1001', '64b64c0a4f4c6a2e9c6d1001'), true)
  })

  it('allows distinct users to form a Follow relationship', () => {
    assert.equal(isSelfFollow('64b64c0a4f4c6a2e9c6d1001', '64b64c0a4f4c6a2e9c6d1002'), false)
  })
})
