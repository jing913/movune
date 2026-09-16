import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { afterEach, describe, it } from 'node:test'
import express from 'express'
import { errorHandler } from '../dist/middlewares/errorHandler.js'
import tmdbRouter from '../dist/routes/tmdb.js'

const originalFetch = globalThis.fetch
const originalToken = process.env.TMDB_READ_ACCESS_TOKEN

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalToken === undefined) delete process.env.TMDB_READ_ACCESS_TOKEN
  else process.env.TMDB_READ_ACCESS_TOKEN = originalToken
})

const startServer = async () => {
  const app = express()
  app.use('/api/tmdb', tmdbRouter)
  app.use(errorHandler)
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return server
}

const requestJson = (server, path) =>
  new Promise((resolve, reject) => {
    const address = server.address()
    assert(address && typeof address === 'object')
    http
      .get({ host: '127.0.0.1', port: address.port, path }, (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          try {
            resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks)) })
          } catch (error) {
            reject(error)
          }
        })
      })
      .on('error', reject)
  })

describe('TMDB API routes', () => {
  it('maps every browser movie operation to its approved TMDB endpoint', async () => {
    process.env.TMDB_READ_ACCESS_TOKEN = 'api-test-token'
    const requestedUrls = []
    globalThis.fetch = async (url) => {
      requestedUrls.push(new URL(url))
      return Response.json({ page: 1, results: [], genres: [] })
    }
    const server = await startServer()

    try {
      const requests = [
        ['/api/tmdb/movie/popular?language=zh-TW', '/3/movie/popular'],
        ['/api/tmdb/movie/now_playing?language=zh-TW&region=TW', '/3/movie/now_playing'],
        [
          '/api/tmdb/search/movie?language=zh-TW&query=Arrival&page=2&include_adult=false&region=TW',
          '/3/search/movie',
        ],
        [
          '/api/tmdb/discover/movie?language=zh-TW&page=1&include_adult=false&include_video=false&sort_by=primary_release_date.asc&vote_count.gte=200&without_genres=99%7C10755',
          '/3/discover/movie',
        ],
        ['/api/tmdb/movie/550?language=zh-TW', '/3/movie/550'],
        ['/api/tmdb/movie/550/recommendations?language=zh-TW', '/3/movie/550/recommendations'],
        ['/api/tmdb/genre/movie/list?language=en-US', '/3/genre/movie/list'],
      ]

      for (const [path, expectedUpstreamPath] of requests) {
        const response = await requestJson(server, path)
        assert.equal(response.status, 200)
        assert.equal(requestedUrls.at(-1).pathname, expectedUpstreamPath)
      }

      const discoverUrl = requestedUrls[3]
      assert.equal(discoverUrl.searchParams.get('sort_by'), 'primary_release_date.asc')
      assert.equal(discoverUrl.searchParams.get('vote_count.gte'), '200')
      assert.equal(discoverUrl.searchParams.get('without_genres'), '99|10755')
    } finally {
      server.close()
      await once(server, 'close')
    }
  })

  it('rejects invalid browser parameters before calling TMDB', async () => {
    process.env.TMDB_READ_ACCESS_TOKEN = 'api-test-token'
    let requested = false
    globalThis.fetch = async () => {
      requested = true
      return Response.json({})
    }
    const server = await startServer()

    try {
      const response = await requestJson(server, '/api/tmdb/search/movie?language=zh-TW')
      assert.equal(response.status, 400)
      assert.equal(response.body.error.code, 'TMDB_REQUEST_INVALID')
      assert.equal(requested, false)
    } finally {
      server.close()
      await once(server, 'close')
    }
  })

  it('returns a safe API problem when TMDB fails', async () => {
    process.env.TMDB_READ_ACCESS_TOKEN = 'api-test-token'
    globalThis.fetch = async () => new Response(null, { status: 500 })
    const server = await startServer()

    try {
      const response = await requestJson(server, '/api/tmdb/movie/popular?language=zh-TW')
      assert.equal(response.status, 503)
      assert.equal(response.body.error.code, 'TMDB_UNAVAILABLE')
      assert.equal(JSON.stringify(response.body).includes('api-test-token'), false)
    } finally {
      server.close()
      await once(server, 'close')
    }
  })
})
