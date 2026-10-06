import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { Types } from 'mongoose'
import { getMoviePeople, getUsers } from '../dist/controllers/userController.js'
import { Favorite } from '../dist/models/favoriteModel.js'
import { Follow } from '../dist/models/followModel.js'
import { UserBlock } from '../dist/models/userBlockModel.js'
import { User } from '../dist/models/userModel.js'
import { listEncounterCandidates } from '../dist/services/encounterService.js'
import { listFormalRecommendations } from '../dist/services/formalRecommendationService.js'

const originalMethods = {
  favoriteDistinct: Favorite.distinct,
  favoriteFind: Favorite.find,
  followAggregate: Follow.aggregate,
  followFind: Follow.find,
  userAggregate: User.aggregate,
  userCountDocuments: User.countDocuments,
  userFind: User.find,
  userBlockFind: UserBlock.find,
}

afterEach(() => {
  Favorite.distinct = originalMethods.favoriteDistinct
  Favorite.find = originalMethods.favoriteFind
  Follow.aggregate = originalMethods.followAggregate
  Follow.find = originalMethods.followFind
  User.aggregate = originalMethods.userAggregate
  User.countDocuments = originalMethods.userCountDocuments
  User.find = originalMethods.userFind
  UserBlock.find = originalMethods.userBlockFind
})

const id = (value) => new Types.ObjectId(value.toString(16).padStart(24, '0'))

const query = (initialValue) => {
  let value = initialValue
  return {
    select() {
      return this
    },
    sort() {
      value = [...value].sort(
        (first, second) =>
          first.account.localeCompare(second.account) ||
          first._id.toString().localeCompare(second._id.toString()),
      )
      return this
    },
    skip(count) {
      value = value.slice(count)
      return this
    },
    limit(count) {
      value = value.slice(0, count)
      return this
    },
    lean() {
      return Promise.resolve(value)
    },
  }
}

const includesId = (values, candidateId) =>
  values.some((value) => value.toString() === candidateId.toString())

const matchesUser = (candidate, filter) => {
  if (filter.role !== undefined && candidate.role !== filter.role) return false
  if (
    filter.favoritesPublic !== undefined &&
    candidate.favoritesPublic !== filter.favoritesPublic
  ) {
    return false
  }

  const idFilter = filter._id
  if (!idFilter) return true
  if (idFilter.$ne !== undefined && candidate._id.toString() === idFilter.$ne.toString()) {
    return false
  }
  if (idFilter.$in && !includesId(idFilter.$in, candidate._id)) return false
  if (idFilter.$nin && includesId(idFilter.$nin, candidate._id)) return false
  return true
}

const installSocialMetadataStubs = () => {
  Follow.find = () => query([])
  Follow.aggregate = async () => []
  UserBlock.find = () => query([])
}

const invokeController = async (controller, request) => {
  const response = { status: 200, body: undefined }
  const res = {
    status(value) {
      response.status = value
      return this
    },
    json(value) {
      response.body = value
      return this
    },
  }
  await controller(request, res, (error) => {
    throw error
  })
  return response
}

const favoriteRecords = (userId, tmdbBase) => [
  { userId, tmdbId: tmdbBase, genreIds: [18] },
  { userId, tmdbId: tmdbBase + 1, genreIds: [28] },
  { userId, tmdbId: tmdbBase + 2, genreIds: [35] },
]

const matchesFavoriteOwner = (favorite, userIdFilter) => {
  if (userIdFilter?.$in) return includesId(userIdFilter.$in, favorite.userId)
  return favorite.userId.toString() === userIdFilter.toString()
}

describe('admin social discovery eligibility', () => {
  it('T1 excludes an otherwise eligible admin from formal results and pagination totals', async () => {
    installSocialMetadataStubs()
    const viewerId = id(100)
    const member = {
      _id: id(101),
      account: 'member',
      displayName: 'Member',
      role: 'user',
      favoritesPublic: true,
    }
    const admin = {
      _id: id(102),
      account: 'admin',
      displayName: 'Admin',
      role: 'admin',
      favoritesPublic: true,
    }
    const favorites = [
      ...favoriteRecords(viewerId, 1),
      ...favoriteRecords(member._id, 1),
      ...favoriteRecords(admin._id, 1),
    ]

    User.find = (filter) =>
      query([member, admin].filter((candidate) => matchesUser(candidate, filter)))
    Favorite.find = (filter) =>
      query(favorites.filter((favorite) => matchesFavoriteOwner(favorite, filter.userId)))

    const result = await listFormalRecommendations(viewerId, 1, 1)

    assert.deepEqual(
      result.items.map(({ _id }) => _id.toString()),
      [member._id.toString()],
    )
    assert.deepEqual(result.pagination, { page: 1, limit: 1, total: 1, totalPages: 1 })
  })

  it('T2 excludes admin from general discovery results and count before pagination', async () => {
    installSocialMetadataStubs()
    const viewer = { _id: id(200) }
    const member = { _id: id(201), account: 'member', displayName: 'Member', role: 'user' }
    const admin = { _id: id(202), account: 'admin', displayName: 'Admin', role: 'admin' }
    const candidates = [member, admin]

    User.aggregate = async (pipeline) => {
      const filter = pipeline[0].$match
      return candidates.filter((candidate) => matchesUser(candidate, filter))
    }
    User.countDocuments = async (filter) =>
      candidates.filter((candidate) => matchesUser(candidate, filter)).length

    const response = await invokeController(getUsers, {
      user: viewer,
      query: { page: '1', limit: '1' },
    })

    assert.equal(response.status, 200)
    assert.deepEqual(
      response.body.users.map(({ _id }) => _id.toString()),
      [member._id.toString()],
    )
    assert.deepEqual(response.body.pagination, { page: 1, limit: 1, total: 1, totalPages: 1 })
  })

  it('T3 excludes admin before Encounter sampling so it does not consume round capacity', async () => {
    installSocialMetadataStubs()
    const viewerId = id(300)
    const members = Array.from({ length: 5 }, (_, index) => ({
      _id: id(301 + index),
      account: `member-${index}`,
      displayName: `Member ${index}`,
      role: 'user',
      favoritesPublic: true,
    }))
    const admin = {
      _id: id(399),
      account: 'admin',
      displayName: 'Admin',
      role: 'admin',
      favoritesPublic: true,
    }
    const favorites = [
      ...favoriteRecords(viewerId, 1),
      ...members.flatMap((member) => favoriteRecords(member._id, 1)),
      ...favoriteRecords(admin._id, 1),
    ]
    let loadedCandidateIds = []

    User.find = (filter) =>
      query([...members, admin].filter((candidate) => matchesUser(candidate, filter)))
    Favorite.find = (filter) => {
      if (filter.userId?.$in) loadedCandidateIds = filter.userId.$in.map(String)
      return query(favorites.filter((favorite) => matchesFavoriteOwner(favorite, filter.userId)))
    }

    const result = await listEncounterCandidates(viewerId, [], [])
    const resultIds = result.candidates.map(({ _id }) => _id.toString())

    assert.equal(result.candidates.length, 5)
    assert.deepEqual(new Set(resultIds), new Set(members.map(({ _id }) => _id.toString())))
    assert.equal(resultIds.includes(admin._id.toString()), false)
    assert.equal(loadedCandidateIds.includes(admin._id.toString()), false)
  })

  it('T4 excludes an admin favorite owner from Movie Detail results and totals', async () => {
    installSocialMetadataStubs()
    const viewer = { _id: id(400) }
    const member = {
      _id: id(401),
      account: 'member',
      displayName: 'Member',
      role: 'user',
      favoritesPublic: true,
    }
    const admin = {
      _id: id(402),
      account: 'admin',
      displayName: 'Admin',
      role: 'admin',
      favoritesPublic: true,
    }
    const candidates = [member, admin]

    Favorite.distinct = async () => candidates.map(({ _id }) => _id)
    User.find = (filter) => query(candidates.filter((candidate) => matchesUser(candidate, filter)))
    User.countDocuments = async (filter) =>
      candidates.filter((candidate) => matchesUser(candidate, filter)).length

    const response = await invokeController(getMoviePeople, {
      user: viewer,
      params: { tmdbId: '123' },
      query: { page: '1', limit: '1' },
    })

    assert.equal(response.status, 200)
    assert.deepEqual(
      response.body.users.map(({ _id }) => _id.toString()),
      [member._id.toString()],
    )
    assert.deepEqual(response.body.pagination, { page: 1, limit: 1, total: 1, totalPages: 1 })
  })
})
