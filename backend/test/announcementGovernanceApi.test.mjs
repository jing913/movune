import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { after, afterEach, before, describe, it } from 'node:test'
import express from 'express'
import mongoose, { Types } from 'mongoose'
import passport from 'passport'
import { Announcement } from '../dist/models/announcementModel.js'
import { errorHandler } from '../dist/middlewares/errorHandler.js'

const originalTransaction = mongoose.connection.transaction
const originalFindById = Announcement.findById
const originalFindOneAndUpdate = Announcement.findOneAndUpdate
const originalFindOneAndDelete = Announcement.findOneAndDelete
const originalInsertOne = mongoose.Collection.prototype.insertOne
const originalRemoveAdmins = process.env.ANNOUNCEMENT_REMOVE_ADMIN_USER_IDS
const servers = new Set()
const session = { api: 'session' }
let records = []
let events = []
let adminAnnouncementRouter

const body = {
  type: 'document',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'API body' }] }],
}
const id = (suffix) => new Types.ObjectId(`b07f1f77bcf86cd7994390${suffix}`)
const publishedAt = new Date('2035-08-01T00:00:00.000Z')
const maintenance = (status = 'scheduled') => ({
  status,
  startsAt: new Date('2035-08-02T00:00:00.000Z'),
  endsAt: new Date('2035-08-02T02:00:00.000Z'),
  affectedAreas: ['Discovery'],
  expectedImpact: 'Brief impact',
})
const record = (suffix, overrides = {}) => ({
  _id: id(suffix),
  category: 'platform_announcement',
  priority: 'normal',
  title: `Announcement ${suffix}`,
  body,
  publicationStatus: 'draft',
  governanceStatus: 'normal',
  revision: 0,
  createdAt: new Date('2035-07-01T00:00:00.000Z'),
  updatedAt: new Date('2035-08-01T00:00:00.000Z'),
  ...overrides,
})

const query = (getValue) => ({
  select() {
    return this
  },
  session(received) {
    assert.equal(received, session)
    return this
  },
  async lean() {
    return getValue()
  },
})

const matches = (candidate, filter) =>
  Object.entries(filter).every(([key, value]) => {
    const actual = key === 'maintenance.status' ? candidate.maintenance?.status : candidate[key]
    return actual?.toString?.() === value?.toString?.()
  })

const installPersistence = (values) => {
  records = values
  events = []
  mongoose.connection.transaction = async (operation) => operation(session)
  Announcement.findById = (announcementId) =>
    query(() => records.find(({ _id }) => _id.toString() === announcementId) ?? null)
  Announcement.findOneAndUpdate = (filter, update, options) => {
    if ('returnDocument' in options) {
      assert.equal(options.session, session)
      assert.equal(options.returnDocument, 'after')
      assert.equal('new' in options, false)
    }
    const current = records.find((candidate) => matches(candidate, filter))
    if (current) {
      Object.assign(current, update.$set)
      for (const field of Object.keys(update.$unset ?? {})) delete current[field]
      current.revision += update.$inc.revision
    }
    return query(() => current ?? null)
  }
  Announcement.findOneAndDelete = (filter) =>
    query(() => {
      const index = records.findIndex((candidate) => matches(candidate, filter))
      if (index < 0) return null
      return records.splice(index, 1)[0]
    })
  mongoose.Collection.prototype.insertOne = async function (value, options) {
    assert.deepEqual(options.session, session)
    events.push(value)
    return { acknowledged: true, insertedId: value._id }
  }
}

class TestJwtStrategy extends passport.Strategy {
  name = 'jwt'

  authenticate(req) {
    const token = req.headers.authorization?.replace(/^Bearer /, '')
    if (!token) return this.fail()
    if (token === 'admin') return this.success({ _id: id('91'), role: 'admin' })
    if (token === 'ordinary-admin') return this.success({ _id: id('94'), role: 'admin' })
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

before(async () => {
  process.env.ANNOUNCEMENT_REMOVE_ADMIN_USER_IDS = id('91').toString()
  ;({ default: adminAnnouncementRouter } = await import('../dist/routes/adminAnnouncement.js'))
  passport.use(new TestJwtStrategy())
})

after(() => {
  if (originalRemoveAdmins === undefined) delete process.env.ANNOUNCEMENT_REMOVE_ADMIN_USER_IDS
  else process.env.ANNOUNCEMENT_REMOVE_ADMIN_USER_IDS = originalRemoveAdmins
})

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
  mongoose.connection.transaction = originalTransaction
  Announcement.findById = originalFindById
  Announcement.findOneAndUpdate = originalFindOneAndUpdate
  Announcement.findOneAndDelete = originalFindOneAndDelete
  mongoose.Collection.prototype.insertOne = originalInsertOne
  records = []
  events = []
  await Promise.all(
    [...servers].map(async (server) => {
      server.close()
      await once(server, 'close')
      servers.delete(server)
    }),
  )
})

describe('P10-I6 Announcement governance API', () => {
  it('requires Passport and rejects ordinary and capability-only users on all five routes', async () => {
    const draft = record('11')
    installPersistence([draft])
    const server = await startServer()
    const routes = [
      ['POST', `/api/admin/announcements/${draft._id}/publish`, { expectedRevision: 0 }],
      [
        'PATCH',
        `/api/admin/announcements/${draft._id}/published-content`,
        {
          expectedRevision: 0,
          editIntent: 'general_correction',
          category: 'platform_announcement',
          priority: 'normal',
          title: 'Title',
          body,
        },
      ],
      ['POST', `/api/admin/announcements/${draft._id}/withdraw`, { expectedRevision: 0 }],
      ['POST', `/api/admin/announcements/${draft._id}/restore`, { expectedRevision: 0 }],
      [
        'POST',
        `/api/admin/announcements/${draft._id}/maintenance-transition`,
        { expectedRevision: 0, status: 'in_progress' },
      ],
    ]
    for (const [method, path, requestBody] of routes) {
      assert.equal((await request(server, method, path, { body: requestBody })).status, 401)
      for (const token of ['user', 'capability-only']) {
        const response = await request(server, method, path, { token, body: requestBody })
        assert.equal(response.status, 403)
        assert.equal(response.body.error.code, 'ANNOUNCEMENT_PERMISSION_DENIED')
      }
    }
    assert.equal(events.length, 0)
  })

  it('allows an admin through each exact route and records the Passport actor', async () => {
    const values = [
      record('11'),
      record('12', { publicationStatus: 'published', publishedAt }),
      record('13', { publicationStatus: 'published', publishedAt }),
      record('14', { publicationStatus: 'withdrawn', publishedAt }),
      record('15', {
        category: 'system_maintenance',
        maintenance: maintenance(),
        publicationStatus: 'published',
        publishedAt,
      }),
    ]
    installPersistence(values)
    const server = await startServer()
    const commands = [
      ['POST', `/api/admin/announcements/${values[0]._id}/publish`, { expectedRevision: 0 }],
      [
        'PATCH',
        `/api/admin/announcements/${values[1]._id}/published-content`,
        {
          expectedRevision: 0,
          editIntent: 'important_update',
          category: 'platform_announcement',
          priority: 'normal',
          title: 'Corrected title',
          body,
          updateNote: 'Important context',
        },
      ],
      ['POST', `/api/admin/announcements/${values[2]._id}/withdraw`, { expectedRevision: 0 }],
      ['POST', `/api/admin/announcements/${values[3]._id}/restore`, { expectedRevision: 0 }],
      [
        'POST',
        `/api/admin/announcements/${values[4]._id}/maintenance-transition`,
        { expectedRevision: 0, status: 'in_progress' },
      ],
    ]
    for (const [method, path, requestBody] of commands) {
      const response = await request(server, method, path, {
        token: 'admin',
        body: requestBody,
      })
      assert.equal(response.status, 200)
      assert.equal(response.body.announcement.revision, 1)
    }
    assert.deepEqual(
      events.map(({ action }) => action),
      ['publish', 'important_update', 'withdraw', 'restore', 'maintenance_transition'],
    )
    assert.equal(
      events.every(({ actorUserId }) => actorUserId.toString() === id('91').toString()),
      true,
    )
  })

  it('returns stable request, publication, id, revision, and state errors', async () => {
    const draft = record('11', { title: undefined })
    const published = record('12', { publicationStatus: 'published', publishedAt, revision: 2 })
    installPersistence([draft, published])
    const server = await startServer()
    const invalidId = await request(server, 'POST', '/api/admin/announcements/bad/publish', {
      token: 'admin',
      body: { expectedRevision: 0 },
    })
    assert.equal(invalidId.body.error.code, 'ANNOUNCEMENT_ID_INVALID')
    const unknown = await request(server, 'POST', `/api/admin/announcements/${draft._id}/publish`, {
      token: 'admin',
      body: { expectedRevision: 0, actorUserId: id('99').toString() },
    })
    assert.equal(unknown.body.error.code, 'ANNOUNCEMENT_REQUEST_INVALID')
    const invalidPublication = await request(
      server,
      'POST',
      `/api/admin/announcements/${draft._id}/publish`,
      { token: 'admin', body: { expectedRevision: 0 } },
    )
    assert.equal(invalidPublication.body.error.code, 'ANNOUNCEMENT_PUBLICATION_INVALID')
    assert.ok(invalidPublication.body.error.details.issues.length > 0)
    const stale = await request(
      server,
      'PATCH',
      `/api/admin/announcements/${published._id}/published-content`,
      {
        token: 'admin',
        body: {
          expectedRevision: 1,
          editIntent: 'general_correction',
          category: 'platform_announcement',
          priority: 'normal',
          title: 'Title',
          body,
        },
      },
    )
    assert.equal(stale.body.error.code, 'ANNOUNCEMENT_REVISION_CONFLICT')
    const wrongState = await request(
      server,
      'POST',
      `/api/admin/announcements/${published._id}/publish`,
      { token: 'admin', body: { expectedRevision: 2 } },
    )
    assert.equal(wrongState.body.error.code, 'ANNOUNCEMENT_STATE_CONFLICT')
  })

  it('maps every command to its locked centralized permission', async () => {
    const source = await readFile(
      new URL('../src/controllers/adminAnnouncementController.ts', import.meta.url),
      'utf8',
    )
    for (const permission of [
      'announcement:publish',
      'announcement:edit',
      'announcement:withdraw',
      'announcement:restore',
    ]) {
      assert.ok(source.includes(`authorize(req, '${permission}')`))
    }
    assert.equal(source.match(/authorize\(req, 'announcement:remove'\)/g)?.length, 1)
    assert.equal(source.includes("role === 'admin'"), false)
  })

  it('enforces the elevated remove allowlist independently from standard permissions', async () => {
    const source = record('11')
    installPersistence([source])
    const server = await startServer()
    const path = `/api/admin/announcements/${source._id}/remove`
    const requestBody = {
      expectedRevision: 0,
      reasonCode: 'privacy',
      reasonSummary: 'Privacy request',
    }
    assert.equal((await request(server, 'POST', path, { body: requestBody })).status, 401)
    for (const token of ['user', 'capability-only', 'ordinary-admin']) {
      const response = await request(server, 'POST', path, { token, body: requestBody })
      assert.equal(response.status, 403)
      assert.equal(response.body.error.code, 'ANNOUNCEMENT_PERMISSION_DENIED')
    }
    const elevated = await request(server, 'POST', path, { token: 'admin', body: requestBody })
    assert.equal(elevated.status, 200)
    assert.equal(elevated.body.announcement.governanceStatus, 'exceptionally_removed')
    assert.equal(events[0].actorUserId.toString(), id('91').toString())

    const malformedPath = '/api/admin/announcements/malformed/remove'
    assert.equal((await request(server, 'POST', malformedPath, { body: requestBody })).status, 401)
    for (const token of ['user', 'ordinary-admin']) {
      const response = await request(server, 'POST', malformedPath, { token, body: requestBody })
      assert.equal(response.status, 403)
      assert.equal(response.body.error.code, 'ANNOUNCEMENT_PERMISSION_DENIED')
    }
    const authorizedMalformed = await request(server, 'POST', malformedPath, {
      token: 'admin',
      body: requestBody,
    })
    assert.equal(authorizedMalformed.status, 400)
    assert.equal(authorizedMalformed.body.error.code, 'ANNOUNCEMENT_ID_INVALID')
  })

  it('accepts exactly the five removal reasons from every normal publication state', async () => {
    const reasonCodes = ['privacy', 'legal', 'safety', 'mistaken_publication', 'other']
    const values = reasonCodes.map((reasonCode, index) =>
      record(`${index + 1}1`, {
        publicationStatus: ['draft', 'published', 'withdrawn', 'draft', 'published'][index],
        ...(index === 0 || index === 3 ? {} : { publishedAt }),
        priority: 'important',
        importantUpdate: { at: publishedAt, note: 'Preserve update' },
      }),
    )
    installPersistence(values)
    const server = await startServer()
    for (const [index, reasonCode] of reasonCodes.entries()) {
      const source = values[index]
      const original = structuredClone(source)
      const response = await request(
        server,
        'POST',
        `/api/admin/announcements/${source._id}/remove`,
        {
          token: 'admin',
          body: {
            expectedRevision: 0,
            reasonCode,
            reasonSummary: `Required ${reasonCode} removal`,
          },
        },
      )
      assert.equal(response.status, 200)
      assert.equal(response.body.announcement.governanceStatus, 'exceptionally_removed')
      assert.equal(response.body.announcement.publicationStatus, original.publicationStatus)
      assert.equal(response.body.announcement.revision, 1)
      assert.equal(source.title, original.title)
      assert.deepEqual(source.body, original.body)
      assert.deepEqual(source.importantUpdate, original.importantUpdate)
      assert.equal(source.publicationStatus, original.publicationStatus)
      assert.equal(events[index].action, 'exceptional_removal')
      assert.equal(events[index].reasonCode, reasonCode)
      assert.equal(events[index].reasonSummary, `Required ${reasonCode} removal`)
    }
  })

  it('rejects every malformed exceptional-removal request without mutation or audit', async () => {
    const source = record('11')
    installPersistence([source])
    const server = await startServer()
    const valid = {
      expectedRevision: 0,
      reasonCode: 'privacy',
      reasonSummary: 'Privacy request',
    }
    const invalidBodies = [
      { ...valid, reasonCode: 'unsupported' },
      { expectedRevision: 0, reasonSummary: valid.reasonSummary },
      { expectedRevision: 0, reasonCode: valid.reasonCode },
      { ...valid, reasonSummary: '' },
      { ...valid, reasonSummary: '   ' },
      { ...valid, reasonSummary: ' untrimmed ' },
      { ...valid, reasonSummary: 'x'.repeat(501) },
      { ...valid, expectedRevision: -1 },
      { reasonCode: valid.reasonCode, reasonSummary: valid.reasonSummary },
      { ...valid, unknown: true },
      { ...valid, actorUserId: id('99').toString() },
    ]
    for (const requestBody of invalidBodies) {
      const response = await request(
        server,
        'POST',
        `/api/admin/announcements/${source._id}/remove`,
        { token: 'admin', body: requestBody },
      )
      assert.equal(response.status, 400)
      assert.equal(response.body.error.code, 'ANNOUNCEMENT_REQUEST_INVALID')
    }
    assert.equal(source.governanceStatus, 'normal')
    assert.equal(source.revision, 0)
    assert.equal(events.length, 0)
  })

  it('classifies removal state, revision, and missing-record conflicts without audit', async () => {
    const removed = record('11', { governanceStatus: 'exceptionally_removed' })
    const stale = record('12', { revision: 2 })
    installPersistence([removed, stale])
    const server = await startServer()
    const input = { reasonCode: 'legal', reasonSummary: 'Legal requirement' }
    const cases = [
      [removed._id, 0, 409, 'ANNOUNCEMENT_STATE_CONFLICT'],
      [stale._id, 1, 409, 'ANNOUNCEMENT_REVISION_CONFLICT'],
      [id('13'), 0, 404, 'ANNOUNCEMENT_NOT_FOUND'],
    ]
    for (const [announcementId, expectedRevision, status, code] of cases) {
      const response = await request(
        server,
        'POST',
        `/api/admin/announcements/${announcementId}/remove`,
        { token: 'admin', body: { expectedRevision, ...input } },
      )
      assert.equal(response.status, status)
      assert.equal(response.body.error.code, code)
    }
    assert.equal(events.length, 0)
  })

  it('keeps exceptionally removed announcements terminal across all ordinary mutations', async () => {
    const removed = record('11', {
      governanceStatus: 'exceptionally_removed',
      category: 'system_maintenance',
      maintenance: maintenance(),
    })
    installPersistence([removed])
    const server = await startServer()
    const base = `/api/admin/announcements/${removed._id}`
    const commands = [
      [
        'PATCH',
        base,
        { expectedRevision: 0, category: 'platform_announcement', priority: 'normal' },
      ],
      ['DELETE', base, { expectedRevision: 0 }],
      ['POST', `${base}/publish`, { expectedRevision: 0 }],
      [
        'PATCH',
        `${base}/published-content`,
        {
          expectedRevision: 0,
          editIntent: 'general_correction',
          category: 'platform_announcement',
          priority: 'normal',
          title: 'Correction',
          body,
        },
      ],
      [
        'PATCH',
        `${base}/published-content`,
        {
          expectedRevision: 0,
          editIntent: 'important_update',
          category: 'platform_announcement',
          priority: 'normal',
          title: 'Update',
          body,
          updateNote: 'Not permitted',
        },
      ],
      ['POST', `${base}/withdraw`, { expectedRevision: 0 }],
      ['POST', `${base}/restore`, { expectedRevision: 0 }],
      ['POST', `${base}/maintenance-transition`, { expectedRevision: 0, status: 'in_progress' }],
    ]
    for (const [method, path, requestBody] of commands) {
      const response = await request(server, method, path, { token: 'admin', body: requestBody })
      assert.equal(response.status, 409)
      assert.equal(response.body.error.code, 'ANNOUNCEMENT_STATE_CONFLICT')
    }
    assert.equal(removed.governanceStatus, 'exceptionally_removed')
    assert.equal(removed.revision, 0)
    assert.equal(events.length, 0)
  })
})
