import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { buildPeopleSortStages, isPeopleSort } from '../dist/utils/peopleSort.js'

const readSource = (path) => readFile(new URL(path, import.meta.url), 'utf8')

describe('Explore discovery contract', () => {
  it('filters candidate Public Favorites directly with ANY selected genre', async () => {
    const source = await readSource('../src/controllers/userController.ts')
    const start = source.indexOf('export const getUsers')
    const end = source.indexOf('export const getMoviePeople')
    const discoverySource = source.slice(start, end)
    const genreStart = discoverySource.indexOf('if (uniqueGenreIds.length > 0)')
    const genreEnd = discoverySource.indexOf('if (sharedFavorites)')
    const genreSource = discoverySource.slice(genreStart, genreEnd)

    assert.match(
      genreSource,
      /Favorite\.distinct\('userId', \{\s*genreIds: \{ \$in: uniqueGenreIds \}/,
    )
    assert.match(genreSource, /PUBLIC_FAVORITES_PERSISTENCE_MATCH/)
    assert.doesNotMatch(genreSource, /req\.user\._id/)
    assert.doesNotMatch(genreSource, /viewerGenreIds|sharedSelectedGenreIds/)
    assert.doesNotMatch(genreSource, /Collection|CollectionMembership/)
  })

  it('keeps shared-Favorite and follow-state filters as independent AND constraints', async () => {
    const source = await readSource('../src/controllers/userController.ts')
    const discoverySource = source.slice(
      source.indexOf('export const getUsers'),
      source.indexOf('export const getMoviePeople'),
    )

    assert.match(discoverySource, /Follow\.distinct\('followingId'/)
    assert.match(discoverySource, /Favorite\.distinct\('tmdbId', \{ userId: req\.user\._id \}\)/)
    assert.match(discoverySource, /tmdbId: \{ \$in: viewerTmdbIds \}/)
    assert.match(discoverySource, /PUBLIC_FAVORITES_PERSISTENCE_MATCH/)
    assert.match(discoverySource, /filter\.\$and = idConstraints/)
  })

  it('returns identity and social metadata without legacy or canonical Match evidence', async () => {
    const source = await readSource('../src/services/peopleService.ts')

    assert.doesNotMatch(
      source,
      /Favorite\.find|sharedGenreIds|sharedFavoriteCount|sharedFavoriteTmdbIds/,
    )
    for (const field of [
      '_id',
      'account',
      'displayName',
      'isFollowing',
      'followerCount',
      'followingCount',
    ]) {
      assert.match(source, new RegExp(`\\b${field}\\b`))
    }
  })

  it('accepts only deterministic recent ordering', () => {
    assert.equal(isPeopleSort('recent'), true)
    assert.equal(isPeopleSort('favorites'), false)
    assert.deepEqual(buildPeopleSortStages(), [{ $sort: { createdAt: -1, _id: -1 } }])
  })

  it('uses an explicit evidence-free Discovery card presentation', async () => {
    const exploreSource = await readSource('../../frontend/src/views/ExplorePeopleView.vue')
    const cardSource = await readSource('../../frontend/src/components/user/PeopleCard.vue')

    assert.match(exploreSource, /recommendation-mode="discovery"/)
    assert.match(exploreSource, /收藏類型/)
    assert.match(exploreSource, /依會員公開收藏的電影類型篩選。/)
    assert.doesNotMatch(exploreSource, /SortSelect|sortOptions|sort: sort\.value/)
    assert.match(cardSource, /'discovery'/)
    assert.doesNotMatch(cardSource, /'legacy'|sharedGenreIds|person\.sharedFavoriteCount/)
  })

  it('keeps every PeopleCard caller explicit after removing no-op compatibility props', async () => {
    const paths = [
      '../../frontend/src/views/HomeView.vue',
      '../../frontend/src/views/ExplorePeopleView.vue',
      '../../frontend/src/views/MovieDetailView.vue',
      '../../frontend/src/views/MovieSpaceView.vue',
    ]
    const sources = await Promise.all(paths.map(readSource))
    const cardSource = await readSource('../../frontend/src/components/user/PeopleCard.vue')

    for (const source of sources) {
      for (const [peopleCard] of source.matchAll(/<PeopleCard[\s\S]*?\/>/g)) {
        assert.match(peopleCard, /(?:recommendation-mode|:recommendation-mode)=/)
        assert.doesNotMatch(peopleCard, /\scompact(?:\s|\/>)/)
      }
    }

    assert.doesNotMatch(cardSource, /compact|recommendationMode\?:/)
    assert.match(cardSource, /v-if="sharedFavoriteCount > 0"/)
    assert.match(cardSource, /v-else-if="recommendationMode === 'current-movie'"/)
    assert.match(cardSource, /也收藏了這部電影/)
  })

  it('drops raw visibility typing while retaining the canonical visibility client', async () => {
    const userTypes = await readSource('../../frontend/src/services/users.ts')
    const favoritesService = await readSource('../../frontend/src/services/favorites.ts')

    assert.doesNotMatch(userTypes, /favoritesPublic|alsoFavorited\?:/)
    assert.match(userTypes, /MovieDetailPerson[\s\S]*alsoFavorited: true/)
    assert.match(
      favoritesService,
      /get<FavoritesVisibilityResponse>\('\/api\/favorites\/visibility'/,
    )
    assert.match(
      favoritesService,
      /patch<FavoritesVisibilityResponse>[\s\S]*'\/api\/favorites\/visibility'/,
    )
  })
})
