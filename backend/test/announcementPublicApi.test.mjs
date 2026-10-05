import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { afterEach, describe, it } from 'node:test'
import express from 'express'
import { Types } from 'mongoose'
import { Announcement } from '../dist/models/announcementModel.js'
import announcementRouter from '../dist/routes/announcement.js'
import { errorHandler } from '../dist/middlewares/errorHandler.js'
import { encodeAnnouncementPublicCursor } from '../dist/utils/announcementPublicPolicy.js'

const originalFind = Announcement.find
const originalFindById = Announcement.findById
const originalFindOne = Announcement.findOne
const servers = new Set()

const body = {
  type: 'document',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Public body' }] }],
}
const time = (day) => new Date(`2035-02-${String(day).padStart(2, '0')}T00:00:00.000Z`)
const id = (suffix) => new Types.ObjectId(`607f1f77bcf86cd7994390${suffix}`)
const record = (suffix, overrides = {}) => ({
  _id: id(suffix),
  category: 'platform_announcement',
  priority: 'normal',
  title: `Announcement ${suffix}`,
  body,
  publicationStatus: 'published',
  governanceStatus: 'normal',
  publishedAt: time(10),
  revision: 4,
  ...overrides,
})

const matches = (candidate, filter) => {
  if (candidate.publicationStatus !== filter.publicationStatus) return false
  if (candidate.governanceStatus !== filter.governanceStatus) return false
  if (filter.category && candidate.category !== filter.category) return false
  if (!filter.$or) return true
  const boundaryTime = filter.$or[0].publishedAt.$lt
  const boundaryId = filter.$or[1]._id.$lt.toString()
  return (
    candidate.publishedAt < boundaryTime ||
    (candidate.publishedAt.valueOf() === boundaryTime.valueOf() &&
      candidate._id.toString() < boundaryId)
  )
}

const query = (value) => ({
  select() {
    return this
  },
  sort() {
    return this
  },
  limit(limit) {
    if (Array.isArray(value)) value = value.slice(0, limit)
    return this
  },
  async lean() {
    return value
  },
})

const installRecords = (records) => {
  Announcement.find = (filter) =>
    query(
      records
        .filter((candidate) => matches(candidate, filter))
        .sort(
          (left, right) =>
            right.publishedAt.valueOf() - left.publishedAt.valueOf() ||
            right._id.toString().localeCompare(left._id.toString()),
        ),
    )
  Announcement.findById = (announcementId) =>
    query(records.find((candidate) => candidate._id.toString() === announcementId) ?? null)
  Announcement.findOne = (filter) =>
    query(
      records.find(
        (candidate) =>
          candidate._id.toString() === filter._id &&
          candidate.publicationStatus === filter.publicationStatus &&
          candidate.governanceStatus === filter.governanceStatus,
      ) ?? null,
    )
}

const startServer = async () => {
  const app = express()
  app.use('/api/announcements', announcementRouter)
  app.use(errorHandler)
  const server = app.listen(0, '127.0.0.1')
  servers.add(server)
  await once(server, 'listening')
  return server
}

const request = (server, path, headers = {}) =>
  new Promise((resolve, reject) => {
    const address = server.address()
    assert(address && typeof address === 'object')
    const outgoing = http.request(
      { host: '127.0.0.1', port: address.port, path, headers },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: raw ? JSON.parse(raw) : null,
          })
        })
      },
    )
    outgoing.on('error', reject)
    outgoing.end()
  })

afterEach(async () => {
  Announcement.find = originalFind
  Announcement.findById = originalFindById
  Announcement.findOne = originalFindOne
  await Promise.all(
    [...servers].map(async (server) => {
      server.close()
      await once(server, 'close')
      servers.delete(server)
    }),
  )
})

describe('P10-I3 public Announcement API', () => {
  it('serves an unauthenticated list with category filtering, safe DTOs, and revalidation', async () => {
    const records = [
      record('11', { category: 'feature_update' }),
      record('12', { publicationStatus: 'draft' }),
    ]
    installRecords(records)
    const server = await startServer()
    const first = await request(server, '/api/announcements?category=feature_update')
    assert.equal(first.status, 200)
    assert.equal(first.headers['cache-control'], 'no-cache')
    assert.equal(typeof first.headers.etag, 'string')
    assert.equal(first.body.announcements.length, 1)
    assert.equal(first.body.announcements[0].category, 'feature_update')
    assert.equal('body' in first.body.announcements[0], false)

    const unchanged = await request(server, '/api/announcements?category=feature_update', {
      'If-None-Match': first.headers.etag,
    })
    assert.equal(unchanged.status, 304)
    records[0].title = 'Changed representation'
    const changed = await request(server, '/api/announcements?category=feature_update', {
      'If-None-Match': first.headers.etag,
    })
    assert.equal(changed.status, 200)
    assert.notEqual(changed.headers.etag, first.headers.etag)
  })

  it('returns stable input errors for category, limit, cursor, and id', async () => {
    installRecords([])
    const server = await startServer()
    const cursor = encodeAnnouncementPublicCursor({
      publishedAt: time(10),
      id: id('11').toString(),
    })
    for (const [path, code] of [
      ['/api/announcements?category=all', 'ANNOUNCEMENT_CATEGORY_INVALID'],
      ['/api/announcements?limit=0', 'ANNOUNCEMENT_LIMIT_INVALID'],
      ['/api/announcements?cursor=invalid', 'ANNOUNCEMENT_CURSOR_INVALID'],
      [
        `/api/announcements?cursor=${encodeURIComponent(`${cursor}!`)}`,
        'ANNOUNCEMENT_CURSOR_INVALID',
      ],
      ['/api/announcements/not-an-id', 'ANNOUNCEMENT_ID_INVALID'],
    ]) {
      const response = await request(server, path)
      assert.equal(response.status, 400)
      assert.equal(response.body.error.code, code)
    }
  })

  it('serves unauthenticated Available detail with ETag and invalidates stale validators', async () => {
    const available = record('11')
    const records = [available]
    installRecords(records)
    const server = await startServer()
    const path = `/api/announcements/${available._id}`
    const first = await request(server, path)
    assert.equal(first.status, 200)
    assert.equal(first.headers['cache-control'], 'no-cache')
    assert.equal(typeof first.headers.etag, 'string')
    assert.equal(first.body.announcement.availability, 'available')
    assert.deepEqual(first.body.announcement.body, body)

    const unchanged = await request(server, path, { 'If-None-Match': first.headers.etag })
    assert.equal(unchanged.status, 304)
    available.title = 'Changed detail'
    const changed = await request(server, path, { 'If-None-Match': first.headers.etag })
    assert.equal(changed.status, 200)
    assert.notEqual(changed.headers.etag, first.headers.etag)
  })

  it('returns minimal tombstones and identical Draft/nonexistent privacy errors', async () => {
    const sensitive = {
      title: 'Protected title',
      body,
      importantUpdate: { at: time(9), note: 'Protected note' },
      maintenance: {
        status: 'scheduled',
        startsAt: time(11),
        endsAt: time(12),
        affectedAreas: ['Protected area'],
        expectedImpact: 'Protected impact',
      },
    }
    const withdrawn = record('11', { publicationStatus: 'withdrawn', ...sensitive })
    const removed = record('12', { governanceStatus: 'exceptionally_removed', ...sensitive })
    const draft = record('13', { publicationStatus: 'draft', ...sensitive })
    installRecords([withdrawn, removed, draft])
    const server = await startServer()

    assert.deepEqual((await request(server, `/api/announcements/${withdrawn._id}`)).body, {
      announcement: { availability: 'withdrawn', id: withdrawn._id.toString() },
    })
    assert.deepEqual((await request(server, `/api/announcements/${removed._id}`)).body, {
      announcement: { availability: 'removed', id: removed._id.toString() },
    })
    const draftResponse = await request(server, `/api/announcements/${draft._id}`)
    const missingResponse = await request(server, `/api/announcements/${id('14')}`)
    assert.equal(draftResponse.status, 404)
    assert.equal(missingResponse.status, 404)
    assert.deepEqual(draftResponse.body, missingResponse.body)
    assert.deepEqual(draftResponse.body, {
      error: { code: 'ANNOUNCEMENT_NOT_FOUND', message: 'Announcement not found' },
    })
  })
})
