import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { afterEach, before, describe, it } from 'node:test'
import express from 'express'
import passport from 'passport'
import { Types } from 'mongoose'
import { Announcement } from '../dist/models/announcementModel.js'
import adminAnnouncementRouter from '../dist/routes/adminAnnouncement.js'
import { errorHandler } from '../dist/middlewares/errorHandler.js'

const originalFind = Announcement.find
const originalFindById = Announcement.findById
const originalFindOneAndUpdate = Announcement.findOneAndUpdate
const originalFindOneAndDelete = Announcement.findOneAndDelete
const originalCreate = Announcement.create
const servers = new Set()
let records = []

const body = {
  type: 'document',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Admin body' }] }],
}
const time = (day) => new Date(`2035-05-${String(day).padStart(2, '0')}T00:00:00.000Z`)
const id = (suffix) => new Types.ObjectId(`807f1f77bcf86cd7994390${suffix}`)
const record = (suffix, overrides = {}) => ({
  _id: id(suffix),
  category: 'platform_announcement',
  priority: 'normal',
  title: `Announcement ${suffix}`,
  body,
  publicationStatus: 'draft',
  governanceStatus: 'normal',
  revision: 0,
  createdAt: time(1),
  updatedAt: time(10),
  __v: 3,
  ...overrides,
})

const query = (getValue) => ({
  select() {
    return this
  },
  sort() {
    return this
  },
  limit(limit) {
    const value = getValue()
    if (Array.isArray(value)) records = value.slice(0, limit)
    return this
  },
  async lean() {
    return getValue()
  },
})

const installRecords = (values) => {
  records = values
  Announcement.find = (filter) => {
    let result = records.filter((candidate) => {
      if (!filter.$or) return true
      const cursorTime = filter.$or[0].updatedAt.$lt
      const cursorId = filter.$or[1]._id.$lt.toString()
      return (
        candidate.updatedAt < cursorTime ||
        (candidate.updatedAt.valueOf() === cursorTime.valueOf() &&
          candidate._id.toString() < cursorId)
      )
    })
    result = result.sort(
      (left, right) =>
        right.updatedAt.valueOf() - left.updatedAt.valueOf() ||
        right._id.toString().localeCompare(left._id.toString()),
    )
    let limited = result
    return {
      select() {
        return this
      },
      sort() {
        return this
      },
      limit(limit) {
        limited = result.slice(0, limit)
        return this
      },
      async lean() {
        return limited
      },
    }
  }
  Announcement.findById = (announcementId) =>
    query(() => records.find(({ _id }) => _id.toString() === announcementId) ?? null)
  Announcement.create = async (value) => {
    const created = record('99', {
      ...value,
      title: undefined,
      body: undefined,
      updatedAt: time(2),
    })
    records.push(created)
    return { toObject: () => created }
  }
  Announcement.findOneAndUpdate = (filter, update) => {
    const current = records.find(
      (candidate) =>
        candidate._id.toString() === filter._id &&
        candidate.revision === filter.revision &&
        candidate.publicationStatus === filter.publicationStatus &&
        candidate.governanceStatus === filter.governanceStatus,
    )
    if (current) {
      Object.assign(current, update.$set)
      for (const field of Object.keys(update.$unset ?? {})) delete current[field]
      current.revision += update.$inc.revision
      current.updatedAt = new Date(current.updatedAt.valueOf() + 1)
    }
    return query(() => current ?? null)
  }
  Announcement.findOneAndDelete = (filter) => {
    const index = records.findIndex(
      (candidate) =>
        candidate._id.toString() === filter._id &&
        candidate.revision === filter.revision &&
        candidate.publicationStatus === filter.publicationStatus &&
        candidate.governanceStatus === filter.governanceStatus,
    )
    const deleted = index < 0 ? null : records.splice(index, 1)[0]
    return query(() => deleted)
  }
}

class TestJwtStrategy extends passport.Strategy {
  name = 'jwt'

  authenticate(req) {
    const token = req.headers.authorization?.replace(/^Bearer /, '')
    if (!token) return this.fail()
    if (token === 'admin') return this.success({ _id: id('91'), role: 'admin' })
    if (token === 'capability-only') {
      return this.success({
        _id: id('92'),
        role: 'user',
        capabilities: { manageAnnouncements: true },
      })
    }
    return this.success({ _id: id('93'), role: 'user' })
  }
}

before(() => passport.use(new TestJwtStrategy()))

const startServer = async () => {
  const app = express()
  app.use(express.json())
  app.use(passport.initialize())
  app.use('/api/admin/announcements', adminAnnouncementRouter)
  app.use(errorHandler)
  const server = app.listen(0, '127.0.0.1')
  servers.add(server)
  await once(server, 'listening')
  return server
}

const request = (server, method, path, { token, body: requestBody } = {}) =>
  new Promise((resolve, reject) => {
    const address = server.address()
    assert(address && typeof address === 'object')
    const payload = requestBody === undefined ? undefined : JSON.stringify(requestBody)
    const outgoing = http.request(
      {
        host: '127.0.0.1',
        port: address.port,
        method,
        path,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(payload
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
            : {}),
        },
      },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          let responseBody = null
          if (raw) {
            try {
              responseBody = JSON.parse(raw)
            } catch {
              responseBody = raw
            }
          }
          resolve({ status: response.statusCode, body: responseBody })
        })
      },
    )
    outgoing.on('error', reject)
    if (payload) outgoing.write(payload)
    outgoing.end()
  })

afterEach(async () => {
  Announcement.find = originalFind
  Announcement.findById = originalFindById
  Announcement.findOneAndUpdate = originalFindOneAndUpdate
  Announcement.findOneAndDelete = originalFindOneAndDelete
  Announcement.create = originalCreate
  records = []
  await Promise.all(
    [...servers].map(async (server) => {
      server.close()
      await once(server, 'close')
      servers.delete(server)
    }),
  )
})

describe('P10-I4B Draft Admin API', () => {
  it('requires Passport authentication and centralized permissions on all five routes', async () => {
    installRecords([record('11')])
    const server = await startServer()
    const routes = [
      ['GET', '/api/admin/announcements'],
      ['GET', `/api/admin/announcements/${id('11')}`],
      ['POST', '/api/admin/announcements', { category: 'feature_update', priority: 'normal' }],
      [
        'PATCH',
        `/api/admin/announcements/${id('11')}`,
        { expectedRevision: 0, category: 'feature_update', priority: 'normal' },
      ],
      ['DELETE', `/api/admin/announcements/${id('11')}`, { expectedRevision: 0 }],
    ]
    for (const [method, path, requestBody] of routes) {
      assert.equal((await request(server, method, path, { body: requestBody })).status, 401)
      const denied = await request(server, method, path, { token: 'user', body: requestBody })
      assert.equal(denied.status, 403)
      assert.equal(denied.body.error.code, 'ANNOUNCEMENT_PERMISSION_DENIED')
    }
    const capabilityOnly = await request(server, 'GET', '/api/admin/announcements', {
      token: 'capability-only',
    })
    assert.equal(capabilityOnly.status, 403)
    const allowed = await request(server, 'GET', '/api/admin/announcements', { token: 'admin' })
    assert.equal(allowed.status, 200)
  })

  it('creates authoritative Drafts and rejects forbidden Create request fields', async () => {
    installRecords([])
    const server = await startServer()
    const created = await request(server, 'POST', '/api/admin/announcements', {
      token: 'admin',
      body: { category: 'feature_update', priority: 'important' },
    })
    assert.equal(created.status, 201)
    assert.equal(created.body.announcement.publicationStatus, 'draft')
    assert.equal(created.body.announcement.governanceStatus, 'normal')
    assert.equal(created.body.announcement.revision, 0)
    for (const invalid of [
      { priority: 'normal' },
      { category: 'feature_update' },
      { category: 'bad', priority: 'normal' },
      { category: 'feature_update', priority: 'bad' },
      { category: 'feature_update', priority: 'normal', title: 'Forbidden' },
      { category: 'feature_update', priority: 'normal', revision: 0 },
      { category: 'feature_update', priority: 'normal', unknown: true },
    ]) {
      const response = await request(server, 'POST', '/api/admin/announcements', {
        token: 'admin',
        body: invalid,
      })
      assert.equal(response.status, 400)
      assert.ok(
        ['ANNOUNCEMENT_REQUEST_INVALID', 'ANNOUNCEMENT_DRAFT_INVALID'].includes(
          response.body.error.code,
        ),
      )
    }
  })

  it('serves explicit Admin List/Detail DTOs and protects exceptionally removed content', async () => {
    const ordinary = record('11', { title: undefined, body: undefined })
    const removed = record('12', {
      governanceStatus: 'exceptionally_removed',
      title: 'Protected',
      body,
      maintenance: { status: 'scheduled' },
      importantUpdate: { at: time(9), note: 'Protected' },
    })
    installRecords([ordinary, removed])
    const server = await startServer()
    const list = await request(server, 'GET', '/api/admin/announcements', { token: 'admin' })
    assert.equal(list.status, 200)
    assert.equal(
      list.body.announcements.some((item) => 'body' in item),
      false,
    )
    assert.equal(
      'title' in list.body.announcements.find(({ id: value }) => value === ordinary._id.toString()),
      false,
    )
    const redacted = list.body.announcements.find(
      ({ id: value }) => value === removed._id.toString(),
    )
    for (const field of ['title', 'body', 'maintenance', 'importantUpdate']) {
      assert.equal(field in redacted, false)
    }
    const detail = await request(server, 'GET', `/api/admin/announcements/${ordinary._id}`, {
      token: 'admin',
    })
    assert.equal(detail.status, 200)
    assert.equal('title' in detail.body.announcement, false)
    assert.equal('__v' in detail.body.announcement, false)
    const invalidId = await request(server, 'GET', '/api/admin/announcements/bad', {
      token: 'admin',
    })
    assert.equal(invalidId.status, 400)
    assert.equal(invalidId.body.error.code, 'ANNOUNCEMENT_ID_INVALID')
    const missing = await request(server, 'GET', `/api/admin/announcements/${id('13')}`, {
      token: 'admin',
    })
    assert.equal(missing.status, 404)
    assert.equal(missing.body.error.code, 'ANNOUNCEMENT_NOT_FOUND')
  })

  it('saves and deletes through atomic OCC with stable conflict and request errors', async () => {
    const current = record('11', { revision: 2, title: 'Old', body })
    installRecords([current])
    const server = await startServer()
    const saved = await request(server, 'PATCH', `/api/admin/announcements/${current._id}`, {
      token: 'admin',
      body: { expectedRevision: 2, category: 'feature_update', priority: 'important' },
    })
    assert.equal(saved.status, 200)
    assert.equal(saved.body.announcement.revision, 3)
    assert.equal('title' in saved.body.announcement, false)
    assert.equal('body' in saved.body.announcement, false)

    const stale = await request(server, 'PATCH', `/api/admin/announcements/${current._id}`, {
      token: 'admin',
      body: { expectedRevision: 2, category: 'feature_update', priority: 'important' },
    })
    assert.equal(stale.status, 409)
    assert.equal(stale.body.error.code, 'ANNOUNCEMENT_REVISION_CONFLICT')

    const numericString = await request(
      server,
      'PATCH',
      `/api/admin/announcements/${current._id}`,
      {
        token: 'admin',
        body: { expectedRevision: '3', category: 'feature_update', priority: 'normal' },
      },
    )
    assert.equal(numericString.status, 400)
    assert.equal(numericString.body.error.code, 'ANNOUNCEMENT_REQUEST_INVALID')

    const deleted = await request(server, 'DELETE', `/api/admin/announcements/${current._id}`, {
      token: 'admin',
      body: { expectedRevision: 3 },
    })
    assert.deepEqual(deleted.body, { deleted: true, id: current._id.toString() })
    assert.equal(records.length, 0)
  })
})
