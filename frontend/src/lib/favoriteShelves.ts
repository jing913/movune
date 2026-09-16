import type { Favorite } from '@/services/favorites'
import type { Movie } from '@/services/tmdb'

export interface FavoriteShelf {
  id: number | 'other'
  name: string
  movies: Movie[]
}

export function groupFavoriteMovies(
  favorites: Favorite[],
  movies: Movie[],
  genreNames: Record<number, string>,
): FavoriteShelf[] {
  const moviesById = new Map(movies.map((movie) => [movie.id, movie]))
  const shelves = new Map<number | 'other', FavoriteShelf>()

  for (const favorite of favorites) {
    const movie = moviesById.get(favorite.tmdbId)
    if (!movie) continue

    const groupingGenreId = favorite.genreIds?.find(
      (genreId) => Number.isInteger(genreId) && genreId > 0 && Boolean(genreNames[genreId]),
    )
    const id = groupingGenreId ?? 'other'
    const shelf = shelves.get(id) ?? {
      id,
      name: groupingGenreId ? genreNames[groupingGenreId] : '其他',
      movies: [],
    }
    shelf.movies.push(movie)
    shelves.set(id, shelf)
  }

  return [...shelves.values()].sort(
    (first, second) =>
      second.movies.length - first.movies.length || first.name.localeCompare(second.name, 'zh-TW'),
  )
}
