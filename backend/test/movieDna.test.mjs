import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { calculateMovieDna, shapeMovieDnaForViewer } from '../dist/services/movieDnaService.js'

describe('Movie DNA calculation', () => {
  it('returns an empty DNA when no Favorites exist', () => {
    assert.deepEqual(calculateMovieDna([]), {
      totalFavorites: 0,
      analyzedFavorites: 0,
      genres: [],
    })
  })

  it('ignores legacy Favorites without genreIds', () => {
    assert.deepEqual(calculateMovieDna([{ genreIds: undefined }, {}]), {
      totalFavorites: 2,
      analyzedFavorites: 0,
      genres: [],
    })
  })

  it('deduplicates a genre within one Favorite and calculates a stable distribution', () => {
    assert.deepEqual(
      calculateMovieDna([{ genreIds: [28, 12, 28] }, { genreIds: [18, 28] }, { genreIds: [18] }]),
      {
        totalFavorites: 3,
        analyzedFavorites: 3,
        genres: [
          { genreId: 18, count: 2, percentage: 40 },
          { genreId: 28, count: 2, percentage: 40 },
          { genreId: 12, count: 1, percentage: 20 },
        ],
      },
    )
  })

  it('ignores invalid genre values', () => {
    assert.deepEqual(calculateMovieDna([{ genreIds: [28, -1, 0, 3.5, '18'] }]), {
      totalFavorites: 1,
      analyzedFavorites: 1,
      genres: [{ genreId: 28, count: 1, percentage: 100 }],
    })
  })

  it('returns aggregate Movie DNA without private Favorite counts to another viewer', () => {
    const movieDna = calculateMovieDna([{ genreIds: [18, 28] }, { genreIds: [18] }])

    assert.deepEqual(shapeMovieDnaForViewer(movieDna, false), {
      genres: [
        { genreId: 18, percentage: 66.7 },
        { genreId: 28, percentage: 33.3 },
      ],
    })
  })

  it('preserves the full Movie DNA payload for its owner', () => {
    const movieDna = calculateMovieDna([{ genreIds: [18] }])

    assert.deepEqual(shapeMovieDnaForViewer(movieDna, true), movieDna)
  })
})
