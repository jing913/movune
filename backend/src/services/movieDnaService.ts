type FavoriteGenreSource = {
  genreIds?: unknown
}

export interface MovieDnaGenre {
  genreId: number
  count: number
  percentage: number
}

export interface MovieDna {
  totalFavorites: number
  analyzedFavorites: number
  genres: MovieDnaGenre[]
}

export interface PublicMovieDna {
  genres: Array<Pick<MovieDnaGenre, 'genreId' | 'percentage'>>
}

export const normalizeGenreIds = (value: unknown) => {
  if (!Array.isArray(value)) return []

  return [
    ...new Set(
      value.filter(
        (genreId): genreId is number => Number.isInteger(genreId) && Number(genreId) > 0,
      ),
    ),
  ]
}

export const calculateMovieDna = (favorites: FavoriteGenreSource[]): MovieDna => {
  const genreCounts = new Map<number, number>()
  let analyzedFavorites = 0

  for (const favorite of favorites) {
    const genreIds = normalizeGenreIds(favorite.genreIds)
    if (genreIds.length === 0) continue

    analyzedFavorites += 1
    for (const genreId of genreIds) {
      genreCounts.set(genreId, (genreCounts.get(genreId) ?? 0) + 1)
    }
  }

  const totalGenreSignals = [...genreCounts.values()].reduce((total, count) => total + count, 0)
  const genres = [...genreCounts.entries()]
    .map(([genreId, count]) => ({
      genreId,
      count,
      percentage: totalGenreSignals === 0 ? 0 : Math.round((count / totalGenreSignals) * 1000) / 10,
    }))
    .sort((first, second) => second.count - first.count || first.genreId - second.genreId)

  return {
    totalFavorites: favorites.length,
    analyzedFavorites,
    genres,
  }
}

export const shapeMovieDnaForViewer = (
  movieDna: MovieDna,
  mayRevealFavoriteFacts: boolean,
): MovieDna | PublicMovieDna => {
  if (mayRevealFavoriteFacts) {
    return movieDna
  }

  return {
    genres: movieDna.genres.map(({ genreId, percentage }) => ({ genreId, percentage })),
  }
}
