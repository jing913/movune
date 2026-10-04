import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { serializeUser } from '../dist/controllers/userController.js'
import {
  ANNOUNCEMENT_PERMISSIONS,
  deriveAnnouncementCapabilities,
  isAnnouncementAuthorized,
} from '../dist/policies/announcementAuthorizationPolicy.js'

const normalId = '507f1f77bcf86cd799439011'
const adminId = '507f191e810c19729de860ea'
const normalUser = { _id: normalId, role: 'user' }
const ordinaryAdmin = { _id: adminId, role: 'admin' }
const standardPermissions = ANNOUNCEMENT_PERMISSIONS.filter(
  (permission) => permission !== 'announcement:remove',
)
const membership =
  (...ids) =>
  (userId) =>
    ids.includes(userId)

describe('P10-I2 Announcement authorization policy', () => {
  it('denies every Announcement permission to a normal user', () => {
    for (const permission of ANNOUNCEMENT_PERMISSIONS) {
      assert.equal(
        isAnnouncementAuthorized(normalUser, permission, membership(normalId)),
        false,
        permission,
      )
    }
  })

  it('grants only standard permissions to an ordinary admin', () => {
    for (const permission of standardPermissions) {
      assert.equal(
        isAnnouncementAuthorized(ordinaryAdmin, permission, membership()),
        true,
        permission,
      )
    }
    assert.equal(isAnnouncementAuthorized(ordinaryAdmin, 'announcement:remove'), false)
    assert.equal(
      isAnnouncementAuthorized(ordinaryAdmin, 'announcement:remove', membership()),
      false,
    )
  })

  it('grants all six permissions to an elevated admin', () => {
    for (const permission of ANNOUNCEMENT_PERMISSIONS) {
      assert.equal(
        isAnnouncementAuthorized(ordinaryAdmin, permission, membership(adminId)),
        true,
        permission,
      )
    }
  })

  it('requires both admin identity and allowlist membership for removal', () => {
    assert.equal(isAnnouncementAuthorized(normalUser, 'announcement:remove', membership()), false)
    assert.equal(
      isAnnouncementAuthorized(normalUser, 'announcement:remove', membership(normalId)),
      false,
    )
    assert.equal(
      isAnnouncementAuthorized(ordinaryAdmin, 'announcement:remove', membership(normalId)),
      false,
    )
    assert.equal(
      isAnnouncementAuthorized(ordinaryAdmin, 'announcement:remove', membership(adminId)),
      true,
    )
  })

  it('denies unauthenticated identities and unknown permissions by default', () => {
    assert.equal(isAnnouncementAuthorized(undefined, 'announcement:create', membership()), false)
    assert.equal(isAnnouncementAuthorized(null, 'announcement:create', membership()), false)
    assert.equal(
      isAnnouncementAuthorized(ordinaryAdmin, 'announcement:unknown', membership()),
      false,
    )
  })

  it('derives the management capability through the authorization policy', () => {
    assert.deepEqual(deriveAnnouncementCapabilities(normalUser), { manageAnnouncements: false })
    assert.deepEqual(deriveAnnouncementCapabilities(ordinaryAdmin), { manageAnnouncements: true })
  })

  it('projects only the management capability in the actual current-user serializer', () => {
    const serializedNormal = serializeUser({
      ...normalUser,
      account: 'member',
      displayName: 'Member',
      favoritesPublic: false,
    })
    const serializedAdmin = serializeUser({
      ...ordinaryAdmin,
      account: 'administrator',
      displayName: 'Administrator',
      favoritesPublic: false,
    })

    assert.equal(serializedNormal.capabilities.manageAnnouncements, false)
    assert.equal(serializedAdmin.capabilities.manageAnnouncements, true)
    assert.deepEqual(Object.keys(serializedAdmin.capabilities), ['manageAnnouncements'])
    assert.equal('role' in serializedAdmin, false)
    assert.equal('canRemoveAnnouncements' in serializedAdmin.capabilities, false)
    assert.equal('permissions' in serializedAdmin, false)
  })
})
