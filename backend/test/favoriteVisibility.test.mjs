import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { resolveFavoritesVisibility } from '../dist/utils/favoriteVisibility.js'
import { canViewFavorites, loadVisibleFavorites } from '../dist/utils/favoritesDisclosurePolicy.js'
import {
  loadFavoritesForMatch,
  loadFavoritesForMovieDna,
  mayProcessFavoritesForMatch,
  mayProcessFavoritesForMovieDna,
} from '../dist/utils/favoritesProcessingPolicy.js'
import { User } from '../dist/models/userModel.js'

const ownerId = '64b64c0a4f4c6a2e9c6d1001'
const otherUserId = '64b64c0a4f4c6a2e9c6d1002'

describe('Favorites visibility mapping', () => {
  it('maps a missing legacy value to private', () => {
    assert.equal(resolveFavoritesVisibility(undefined), 'private')
  })

  it('maps false to private', () => {
    assert.equal(resolveFavoritesVisibility(false), 'private')
  })

  it('maps only true to public', () => {
    assert.equal(resolveFavoritesVisibility(true), 'public')
    assert.equal(resolveFavoritesVisibility('true'), 'private')
    assert.equal(resolveFavoritesVisibility(1), 'private')
  })

  it('keeps favoritesPublic as the only persisted Favorites visibility state', () => {
    assert.ok(User.schema.path('favoritesPublic'))
    assert.equal(User.schema.path('favoritesSettings'), undefined)
    assert.equal(User.schema.path('favoritesVisibility'), undefined)
  })
})

describe('Favorites disclosure policy', () => {
  it('always allows the owner to view Favorites', () => {
    assert.equal(canViewFavorites(ownerId, ownerId, 'private'), true)
  })

  it('allows another user only when Favorites are explicitly public', () => {
    assert.equal(canViewFavorites(ownerId, otherUserId, 'public'), true)
    assert.equal(canViewFavorites(ownerId, otherUserId, 'private'), false)
  })

  it('does not load private or legacy Favorites for another user', async () => {
    let loadCount = 0
    const loadFavorites = async () => {
      loadCount += 1
      return [{ tmdbId: 550 }]
    }

    assert.equal(
      await loadVisibleFavorites(ownerId, otherUserId, 'private', loadFavorites),
      undefined,
    )
    assert.equal(loadCount, 0)
  })

  it('loads Favorites for the owner and for another user when public', async () => {
    let loadCount = 0
    const loadFavorites = async () => {
      loadCount += 1
      return [{ tmdbId: 550 }]
    }

    assert.deepEqual(await loadVisibleFavorites(ownerId, ownerId, 'private', loadFavorites), [
      { tmdbId: 550 },
    ])
    assert.deepEqual(await loadVisibleFavorites(ownerId, otherUserId, 'public', loadFavorites), [
      { tmdbId: 550 },
    ])
    assert.equal(loadCount, 2)
  })
})

describe('Favorites processing policy', () => {
  it('allows private Favorites to participate in authorized Movie DNA processing', () => {
    assert.equal(resolveFavoritesVisibility(false), 'private')
    assert.equal(mayProcessFavoritesForMovieDna(), true)
  })

  it('allows private Favorites to participate in authorized Match processing', () => {
    assert.equal(resolveFavoritesVisibility(false), 'private')
    assert.equal(mayProcessFavoritesForMatch(), true)
  })

  it('keeps processing eligibility independent from viewer disclosure', () => {
    assert.equal(canViewFavorites(ownerId, otherUserId, 'private'), false)
    assert.equal(mayProcessFavoritesForMovieDna(), true)
    assert.equal(mayProcessFavoritesForMatch(), true)
  })

  it('loads private Favorites for Movie DNA and Match processing without making them disclosable', async () => {
    let loadCount = 0
    const loadFavorites = async () => {
      loadCount += 1
      return [{ tmdbId: 550, genreIds: [18] }]
    }

    assert.equal(canViewFavorites(ownerId, otherUserId, 'private'), false)
    assert.deepEqual(await loadFavoritesForMovieDna(loadFavorites), [
      { tmdbId: 550, genreIds: [18] },
    ])
    assert.deepEqual(await loadFavoritesForMatch(loadFavorites), [{ tmdbId: 550, genreIds: [18] }])
    assert.equal(loadCount, 2)
  })
})
