import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { requestTmdb } from '../dist/services/tmdbMetadataService.js'

const originalFetch = globalThis.fetch
const originalToken = process.env.TMDB_READ_ACCESS_TOKEN

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalToken === undefined) delete process.env.TMDB_READ_ACCESS_TOKEN
  else process.env.TMDB_READ_ACCESS_TOKEN = originalToken
})

describe('TMDB server boundary', () => {
  it('adds server-side authentication and forwards approved request parameters', async () => {
    process.env.TMDB_READ_ACCESS_TOKEN = 'test-only-token'
    let capturedUrl
    let capturedAuthorization
    globalThis.fetch = async (url, options) => {
      capturedUrl = new URL(url)
      capturedAuthorization = options.headers.Authorization
      return Response.json({ page: 2, results: [] })
    }

    const result = await requestTmdb('/search/movie', {
      language: 'zh-TW',
      query: 'Arrival',
      page: 2,
    })

    assert.equal(capturedUrl.origin, 'https://api.themoviedb.org')
    assert.equal(capturedUrl.pathname, '/3/search/movie')
    assert.equal(capturedUrl.searchParams.get('language'), 'zh-TW')
    assert.equal(capturedUrl.searchParams.get('query'), 'Arrival')
    assert.equal(capturedUrl.searchParams.get('page'), '2')
    assert.equal(capturedAuthorization, 'Bearer test-only-token')
    assert.deepEqual(result, { page: 2, results: [] })
  })

  it('uses the project API error convention when TMDB is unavailable', async () => {
    process.env.TMDB_READ_ACCESS_TOKEN = 'test-only-token'
    globalThis.fetch = async () => new Response(null, { status: 500 })

    await assert.rejects(requestTmdb('/movie/popular'), {
      status: 503,
      code: 'TMDB_UNAVAILABLE',
    })
  })

  it('fails without making a request when server-side authentication is not configured', async () => {
    delete process.env.TMDB_READ_ACCESS_TOKEN
    let requested = false
    globalThis.fetch = async () => {
      requested = true
      return Response.json({})
    }

    await assert.rejects(requestTmdb('/movie/popular'), {
      status: 503,
      code: 'TMDB_UNAVAILABLE',
    })
    assert.equal(requested, false)
  })
})
