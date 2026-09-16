import { ApiProblem } from '../utils/messagingPolicy.js'

type TmdbMovieResponse = { id?: number; title?: string; poster_path?: string | null }
type TmdbQueryValue = string | number | boolean | undefined

const TMDB_API_BASE_URL = 'https://api.themoviedb.org/3/'
const TMDB_TIMEOUT_MS = 8_000

export type MovieSnapshot = { title: string; posterPath: string | null }

export async function requestTmdb<T>(
  path: string,
  params: Record<string, TmdbQueryValue> = {},
): Promise<T> {
  const token = process.env.TMDB_READ_ACCESS_TOKEN
  if (!token) throw new ApiProblem(503, 'TMDB_UNAVAILABLE', 'Movie metadata is not configured')

  const url = new URL(path.replace(/^\//, ''), TMDB_API_BASE_URL)
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value))
  }

  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(TMDB_TIMEOUT_MS),
    })
    if (response.status === 404) throw new ApiProblem(404, 'RESOURCE_NOT_FOUND', 'Movie not found')
    if (!response.ok) {
      throw new ApiProblem(503, 'TMDB_UNAVAILABLE', 'Movie metadata is temporarily unavailable')
    }

    try {
      return (await response.json()) as T
    } catch {
      throw new ApiProblem(502, 'TMDB_INVALID_RESPONSE', 'Movie metadata response is invalid')
    }
  } catch (error) {
    if (error instanceof ApiProblem) throw error
    throw new ApiProblem(503, 'TMDB_UNAVAILABLE', 'Movie metadata is temporarily unavailable')
  }
}

export async function getAuthoritativeMovieSnapshot(tmdbId: number): Promise<MovieSnapshot> {
  const movie = await requestTmdb<TmdbMovieResponse>(`/movie/${tmdbId}`, { language: 'zh-TW' })
  if (movie.id !== tmdbId || !movie.title) {
    throw new ApiProblem(502, 'TMDB_INVALID_RESPONSE', 'Movie metadata response is invalid')
  }
  return { title: movie.title, posterPath: movie.poster_path ?? null }
}
