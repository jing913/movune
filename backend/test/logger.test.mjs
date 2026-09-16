import assert from 'node:assert/strict'
import test from 'node:test'

import { logger } from '../dist/middlewares/logger.js'

test('request logger omits query-string values', () => {
  const entries = []
  const originalLog = console.log
  let nextCalled = false

  console.log = (...values) => entries.push(values)

  try {
    logger({ method: 'GET', originalUrl: '/api/movies?token=sensitive-value' }, {}, () => {
      nextCalled = true
    })
  } finally {
    console.log = originalLog
  }

  assert.equal(nextCalled, true)
  assert.deepEqual(entries, [['GET', '/api/movies']])
})
