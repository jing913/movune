import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { after, before, describe, it } from 'node:test'
import mongoose from 'mongoose'
import {
  getFavoritesVisibilityController,
  updateFavoritesVisibilityController,
} from '../dist/controllers/favoriteController.js'
import { getDnaMatch } from '../dist/controllers/dnaMatchController.js'
import { getMovieDna } from '../dist/controllers/movieDnaController.js'
import { getCollectionController } from '../dist/controllers/collectionController.js'
import {
  getMovieSpace,
  getUser,
  updateFavoriteVisibility,
} from '../dist/controllers/userController.js'
import { Collection } from '../dist/models/collectionModel.js'
import { CollectionMembership } from '../dist/models/collectionMembershipModel.js'
import { Favorite } from '../dist/models/favoriteModel.js'
import { User } from '../dist/models/userModel.js'
import { buildPeopleSummaries } from '../dist/services/peopleService.js'

async function databaseUrl() {
  if (process.env.DB_URL) return process.env.DB_URL
  const env = await readFile(new URL('../.env', import.meta.url), 'utf8')
  const line = env.split(/\r?\n/).find((entry) => entry.startsWith('DB_URL='))
  return line?.slice('DB_URL='.length)
}

async function invoke(controller, { user, params = {}, body = {} } = {}) {
  const req = { user, params, body }
  const result = { status: 200, body: undefined }
  const res = {
    status(status) {
      result.status = status
      return this
    },
    json(bodyValue) {
      result.body = bodyValue
      return this
    },
  }
  let controllerError
  await controller(req, res, (error) => {
    controllerError = error
  })
  if (controllerError) throw controllerError
  return result
}

describe('Favorites Resource visibility API and privacy', { timeout: 60_000 }, () => {
  let owner
  let visitor
  let favorite
  let collection
  const collectionIds = []

  before(async () => {
    const url = await databaseUrl()
    if (!url) throw new Error('DB_URL is required for Favorites Resource visibility tests')
    await mongoose.connect(url)

    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    ;[owner, visitor] = await User.create([
      {
        account: `p7-favorites-owner-${suffix}`,
        email: `p7-favorites-owner-${suffix}@test.invalid`,
        password: 'not-used',
        role: 'user',
        favoritesPublic: false,
      },
      {
        account: `p7-favorites-visitor-${suffix}`,
        email: `p7-favorites-visitor-${suffix}@test.invalid`,
        password: 'not-used',
        role: 'user',
        favoritesPublic: false,
      },
    ])
    favorite = await Favorite.create({ userId: owner._id, tmdbId: 550, genreIds: [18, 53] })
    collection = await Collection.create({
      ownerId: owner._id,
      name: 'Public independent list',
      visibility: 'public',
    })
    collectionIds.push(collection._id)
    await CollectionMembership.create({ collectionId: collection._id, tmdbId: 550, position: 0 })
  })

  after(async () => {
    await CollectionMembership.deleteMany({ collectionId: collection?._id })
    await Collection.deleteMany({ _id: { $in: collectionIds } })
    await Favorite.deleteMany({ userId: { $in: [owner?._id, visitor?._id].filter(Boolean) } })
    await User.deleteMany({ _id: { $in: [owner?._id, visitor?._id].filter(Boolean) } })
    await mongoose.disconnect()
  })

  it('lets the owner read the canonical private visibility', async () => {
    const response = await invoke(getFavoritesVisibilityController, { user: owner })
    assert.deepEqual(response, { status: 200, body: { visibility: 'private' } })
  })

  it('rejects missing authentication and malformed visibility', async () => {
    assert.deepEqual(await invoke(getFavoritesVisibilityController), {
      status: 401,
      body: { message: 'Unauthorized' },
    })
    for (const visibility of [undefined, null, true, false, 'friends', 'Public']) {
      const response = await invoke(updateFavoritesVisibilityController, {
        user: owner,
        body: { visibility },
      })
      assert.equal(response.status, 400)
    }
  })

  it('changes Private to Public and Public to Private through resource vocabulary', async () => {
    const published = await invoke(updateFavoritesVisibilityController, {
      user: owner,
      body: { visibility: 'public' },
    })
    assert.deepEqual(published, { status: 200, body: { visibility: 'public' } })
    assert.equal((await User.findById(owner._id).lean()).favoritesPublic, true)

    const privatized = await invoke(updateFavoritesVisibilityController, {
      user: owner,
      body: { visibility: 'private' },
    })
    assert.deepEqual(privatized, { status: 200, body: { visibility: 'private' } })
    assert.equal((await User.findById(owner._id).lean()).favoritesPublic, false)
  })

  it('cannot mutate another owner because the resource endpoint is scoped to req.user', async () => {
    await invoke(updateFavoritesVisibilityController, {
      user: visitor,
      params: { id: owner._id.toString() },
      body: { visibility: 'public' },
    })
    assert.equal((await User.findById(owner._id).lean()).favoritesPublic, false)
    assert.equal((await User.findById(visitor._id).lean()).favoritesPublic, true)
    visitor.favoritesPublic = false
    await visitor.save()
  })

  it('keeps the legacy endpoint as a convergent adapter to the canonical resource read', async () => {
    const legacy = await invoke(updateFavoriteVisibility, {
      user: owner,
      body: { favoritesPublic: true },
    })
    assert.equal(legacy.status, 200)
    assert.equal(legacy.body.user.favoritesPublic, true)
    assert.deepEqual(await invoke(getFavoritesVisibilityController, { user: owner }), {
      status: 200,
      body: { visibility: 'public' },
    })

    await invoke(updateFavoriteVisibility, { user: owner, body: { favoritesPublic: false } })
    assert.deepEqual(await invoke(getFavoritesVisibilityController, { user: owner }), {
      status: 200,
      body: { visibility: 'private' },
    })
  })

  it('does not mutate Favorite records or Collection visibility when visibility changes', async () => {
    const before = await Favorite.findById(favorite._id).lean()
    await invoke(updateFavoritesVisibilityController, {
      user: owner,
      body: { visibility: 'public' },
    })
    const after = await Favorite.findById(favorite._id).lean()
    const storedCollection = await Collection.findById(collection._id).lean()
    assert.deepEqual(after, before)
    assert.equal(storedCollection.visibility, 'public')
  })

  it('omits all private Favorite state and content from visitor user and Movie Space DTOs', async () => {
    await invoke(updateFavoritesVisibilityController, {
      user: owner,
      body: { visibility: 'private' },
    })
    const publicUser = await invoke(getUser, { params: { id: owner._id.toString() } })
    const movieSpace = await invoke(getMovieSpace, {
      user: visitor,
      params: { id: owner._id.toString() },
    })

    for (const field of [
      'favoritesPublic',
      'visibility',
      'favoritesVisibility',
      'canViewFavorites',
    ]) {
      assert.equal(field in publicUser.body.user, false)
      assert.equal(field in movieSpace.body, false)
    }
    assert.equal('favorites' in movieSpace.body, false)
    assert.deepEqual(Object.keys(movieSpace.body).sort(), ['collections', 'user'])
  })

  it('returns approved Favorite relationships to a visitor only after Public', async () => {
    await invoke(updateFavoritesVisibilityController, {
      user: owner,
      body: { visibility: 'public' },
    })
    const response = await invoke(getMovieSpace, {
      user: visitor,
      params: { id: owner._id.toString() },
    })
    assert.equal(response.status, 200)
    assert.deepEqual(
      response.body.favorites.map(({ tmdbId }) => tmdbId),
      [550],
    )
    assert.equal('favoritesPublic' in response.body.user, false)
  })

  it('keeps discovery People summaries free of Favorite-derived facts', async () => {
    await invoke(updateFavoritesVisibilityController, {
      user: owner,
      body: { visibility: 'private' },
    })
    const [privateSummary] = await buildPeopleSummaries([owner.toObject()], visitor._id)
    for (const field of [
      'favoritesPublic',
      'sharedGenreIds',
      'sharedFavoriteCount',
      'sharedFavoriteTmdbIds',
    ]) {
      assert.equal(field in privateSummary, false)
    }

    await invoke(updateFavoritesVisibilityController, {
      user: owner,
      body: { visibility: 'public' },
    })
    const [publicSummary] = await buildPeopleSummaries([owner.toObject()], visitor._id)
    for (const field of [
      'favoritesPublic',
      'sharedGenreIds',
      'sharedFavoriteCount',
      'sharedFavoriteTmdbIds',
    ]) {
      assert.equal(field in publicSummary, false)
    }
  })

  it('lists only active Public Collections through a minimal visitor Movie Space DTO', async () => {
    const [privateCollection, deletedCollection] = await Collection.create([
      { ownerId: owner._id, name: 'Hidden private list' },
      {
        ownerId: owner._id,
        name: 'Hidden deleted list',
        visibility: 'public',
        lifecycleState: 'deleted',
        deletedAt: new Date(),
      },
    ])
    collectionIds.push(privateCollection._id, deletedCollection._id)

    const response = await invoke(getMovieSpace, {
      user: visitor,
      params: { id: owner._id.toString() },
    })
    assert.deepEqual(response.body.collections, [
      {
        _id: collection._id,
        name: 'Public independent list',
        movieCount: 1,
        previewMovies: [{ tmdbId: 550 }],
      },
    ])
    assert.deepEqual(Object.keys(response.body.collections[0]).sort(), [
      '_id',
      'movieCount',
      'name',
      'previewMovies',
    ])
    assert.equal(JSON.stringify(response.body).includes('Hidden private list'), false)
    assert.equal(JSON.stringify(response.body).includes('Hidden deleted list'), false)
  })

  it('revalidates Public to Private and Private to Public from persisted state', async () => {
    collection.visibility = 'private'
    await collection.save()
    const hidden = await invoke(getMovieSpace, {
      user: visitor,
      params: { id: owner._id.toString() },
    })
    assert.deepEqual(hidden.body.collections, [])

    collection.visibility = 'public'
    await collection.save()
    const visible = await invoke(getMovieSpace, {
      user: visitor,
      params: { id: owner._id.toString() },
    })
    assert.deepEqual(visible.body.collections, [
      {
        _id: collection._id,
        name: 'Public independent list',
        movieCount: 1,
        previewMovies: [{ tmdbId: 550 }],
      },
    ])
  })

  it('keeps private Favorites in Movie DNA processing without public source provenance', async () => {
    for (const visibility of ['private', 'public']) {
      await invoke(updateFavoritesVisibilityController, { user: owner, body: { visibility } })
      const visitorResponse = await invoke(getMovieDna, {
        user: visitor,
        params: { id: owner._id.toString() },
      })
      assert.deepEqual(visitorResponse.body.movieDna, {
        genres: [
          { genreId: 18, percentage: 50 },
          { genreId: 53, percentage: 50 },
        ],
      })
      assert.equal('totalFavorites' in visitorResponse.body.movieDna, false)
      assert.equal('analyzedFavorites' in visitorResponse.body.movieDna, false)
    }

    await invoke(updateFavoritesVisibilityController, {
      user: owner,
      body: { visibility: 'private' },
    })
    const ownerResponse = await invoke(getMovieDna, {
      user: owner,
      params: { id: owner._id.toString() },
    })
    assert.equal(ownerResponse.body.movieDna.totalFavorites, 1)
    assert.equal(ownerResponse.body.movieDna.analyzedFavorites, 1)
  })

  it('processes private Match inputs while exposing only canonical aggregate explanation', async () => {
    await Favorite.create([
      { userId: owner._id, tmdbId: 551, genreIds: [18] },
      { userId: owner._id, tmdbId: 552, genreIds: [28] },
      { userId: visitor._id, tmdbId: 550, genreIds: [18, 53] },
      { userId: visitor._id, tmdbId: 553, genreIds: [28] },
      { userId: visitor._id, tmdbId: 554, genreIds: [35] },
    ])
    await invoke(updateFavoritesVisibilityController, {
      user: owner,
      body: { visibility: 'private' },
    })

    const privateResponse = await invoke(getDnaMatch, {
      user: visitor,
      params: { id: owner._id.toString() },
    })
    assert.deepEqual(privateResponse.body.dnaMatch, {
      status: 'eligible',
      sharedDnaGenres: [
        { genreId: 18, sharedGenreStrength: 25 },
        { genreId: 28, sharedGenreStrength: 25 },
        { genreId: 53, sharedGenreStrength: 25 },
      ],
      revealableSharedFavoriteTmdbIds: [],
    })
    for (const field of [
      'strategy',
      'strategyStatus',
      'sharedGenres',
      'favoriteComparisonAvailable',
      'sharedFavoriteCount',
      'sharedFavoriteTmdbIds',
      'favoritesPublic',
      'visibility',
      'matchScore',
      'genreSimilarity',
      'favoriteSimilarity',
      'internalSharedFavorites',
      'internalSharedFavoriteCount',
      'diagnostics',
    ]) {
      assert.equal(field in privateResponse.body.dnaMatch, false)
    }

    await invoke(updateFavoritesVisibilityController, {
      user: owner,
      body: { visibility: 'public' },
    })
    const publicResponse = await invoke(getDnaMatch, {
      user: visitor,
      params: { id: owner._id.toString() },
    })
    assert.deepEqual(
      publicResponse.body.dnaMatch.sharedDnaGenres,
      privateResponse.body.dnaMatch.sharedDnaGenres,
    )
    assert.deepEqual(publicResponse.body.dnaMatch.revealableSharedFavoriteTmdbIds, [550])
  })

  it('keeps Public Collection membership independent from a private Favorite relationship', async () => {
    await invoke(updateFavoritesVisibilityController, {
      user: owner,
      body: { visibility: 'private' },
    })
    const membership = await CollectionMembership.findOne({
      collectionId: collection._id,
      tmdbId: 550,
    }).lean()
    const storedOwner = await User.findById(owner._id).lean()
    assert.equal(membership.tmdbId, 550)
    assert.equal('favorite' in membership, false)
    assert.equal('isFavorite' in membership, false)
    assert.equal(storedOwner.favoritesPublic, false)
    assert.equal((await Collection.findById(collection._id).lean()).visibility, 'public')

    const publicDetail = await invoke(getCollectionController, {
      user: visitor,
      params: { collectionId: collection._id.toString() },
    })
    assert.deepEqual(publicDetail.body.collection.memberships, [{ tmdbId: 550, position: 0 }])
    assert.equal('favorite' in publicDetail.body.collection.memberships[0], false)
    assert.equal('isFavorite' in publicDetail.body.collection.memberships[0], false)

    collection.visibility = 'private'
    await collection.save()
    assert.equal((await User.findById(owner._id).lean()).favoritesPublic, false)
  })
})
