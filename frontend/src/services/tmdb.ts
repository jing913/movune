import api from './api'

const primaryLocale = 'zh-TW'
const fallbackLocale = 'en-US'
let taiwanTraditionalConverterPromise: Promise<(text: string) => string> | null = null

function getTaiwanTraditionalConverter() {
  taiwanTraditionalConverterPromise ??= Promise.all([
    import('opencc-js/core'),
    import('opencc-js/preset/cn2t'),
  ]).then(([{ ConverterFactory }, preset]) => ConverterFactory(preset.from.cn, preset.to.twp))
  return taiwanTraditionalConverterPromise
}

export interface Movie {
  id: number
  title: string
  original_title?: string
  original_language?: string
  poster_path: string | null
  overview: string
  vote_average: number
  release_date?: string
  genre_ids?: number[]
  genres?: MovieGenre[]
  overviewLocale?: typeof primaryLocale | typeof fallbackLocale | 'none'
}

export interface MovieDetails extends Movie {
  runtime?: number | null
}

export interface MoviePage {
  page: number
  results: Movie[]
  total_pages: number
  total_results: number
}

export interface MovieGenre {
  id: number
  name: string
}

interface MovieGenresResponse {
  genres: MovieGenre[]
}

export type MovieSort = 'popular' | 'rating' | 'newest'
export type MovieSortDirection = 'asc' | 'desc'
export type MovieDiscoveryState = 'all' | 'now-playing' | 'acclaimed'

export interface DiscoverMoviesInput {
  page?: number
  genreIds?: number[]
  state?: MovieDiscoveryState
  sort?: MovieSort
  sortDirection?: MovieSortDirection
}

export async function normalizeTmdbChineseText(value: string | null | undefined) {
  const text = value?.trim() ?? ''
  if (!text) return ''
  const converter = await getTaiwanTraditionalConverter()
  return converter(text)
}

async function fetchTmdb<T>(
  path: string,
  params: Record<string, string | number | undefined> = {},
  errorMessage: string,
): Promise<T> {
  try {
    const response = await api.get<T>(`/api/tmdb${path}`, {
      params: { language: primaryLocale, ...params },
    })
    return response.data
  } catch {
    throw new Error(errorMessage)
  }
}

async function normalizeMovie(
  movie: Movie,
  overviewLocale: Movie['overviewLocale'] = primaryLocale,
): Promise<Movie> {
  const localizedTitle = await normalizeTmdbChineseText(movie.title)
  const overview =
    overviewLocale === primaryLocale
      ? await normalizeTmdbChineseText(movie.overview)
      : (movie.overview?.trim() ?? '')
  const genres = movie.genres
    ? await Promise.all(
        movie.genres.map(async (genre) => ({
          ...genre,
          name: await normalizeTmdbChineseText(genre.name),
        })),
      )
    : undefined

  return {
    ...movie,
    title: localizedTitle || movie.original_title?.trim() || '未命名電影',
    original_title: movie.original_title?.trim() || undefined,
    overview,
    overviewLocale: movie.overview?.trim() ? overviewLocale : 'none',
    genres,
  }
}

async function normalizeMoviePage(page: MoviePage): Promise<MoviePage> {
  return {
    ...page,
    results: await Promise.all(page.results.map((movie) => normalizeMovie(movie))),
  }
}

export function getMoviePrimaryTitle(movie: Pick<Movie, 'title' | 'original_title'>) {
  return movie.title?.trim() || movie.original_title?.trim() || '未命名電影'
}

export function getMovieSecondaryTitle(movie: Pick<Movie, 'title' | 'original_title'>) {
  const primary = getMoviePrimaryTitle(movie)
  const secondary = movie.original_title?.trim()

  if (!secondary || secondary.localeCompare(primary, undefined, { sensitivity: 'accent' }) === 0) {
    return null
  }

  return secondary
}

export async function getPopularMovies(): Promise<Movie[]> {
  const page = await fetchTmdb<MoviePage>('/movie/popular', {}, '取得熱門電影失敗')
  return (await normalizeMoviePage(page)).results
}

export async function getNowPlayingMovies(): Promise<Movie[]> {
  const page = await fetchTmdb<MoviePage>(
    '/movie/now_playing',
    { region: 'TW' },
    '取得近期上映電影失敗',
  )
  return (await normalizeMoviePage(page)).results
}

export async function searchMoviePage(query: string, page = 1): Promise<MoviePage> {
  const result = await fetchTmdb<MoviePage>(
    '/search/movie',
    { query, page, include_adult: 'false', region: 'TW' },
    '取得搜尋電影失敗',
  )
  return normalizeMoviePage(result)
}

export async function searchMovies(query: string): Promise<Movie[]> {
  return (await searchMoviePage(query)).results
}

export async function discoverMovies(input: DiscoverMoviesInput = {}): Promise<MoviePage> {
  const page = input.page ?? 1
  const sort = input.sort ?? 'popular'
  const sortDirection = input.sortDirection ?? 'desc'
  const state = input.state ?? 'all'
  const genreIds = (input.genreIds ?? []).filter(
    (genreId) => Number.isInteger(genreId) && genreId > 0,
  )
  const params: Record<string, string | number | undefined> = {
    page,
    region: 'TW',
    include_adult: 'false',
    include_video: 'false',
    with_genres: genreIds.length ? genreIds.join('|') : undefined,
    sort_by: `${
      sort === 'rating' ? 'vote_average' : sort === 'newest' ? 'primary_release_date' : 'popularity'
    }.${sortDirection}`,
    'vote_count.gte': state === 'acclaimed' ? 200 : undefined,
    without_genres: state === 'acclaimed' ? '99|10755' : undefined,
  }

  if (state === 'now-playing') {
    const today = new Date()
    const earliest = new Date(today)
    earliest.setUTCDate(earliest.getUTCDate() - 60)
    params.with_release_type = '2|3'
    params['release_date.gte'] = earliest.toISOString().slice(0, 10)
    params['release_date.lte'] = today.toISOString().slice(0, 10)
  }

  const result = await fetchTmdb<MoviePage>('/discover/movie', params, '取得探索電影失敗')
  return normalizeMoviePage(result)
}

const movieDetailsPromiseCache = new Map<number, Promise<MovieDetails>>()

export function getMovieDetails(movieId: number): Promise<MovieDetails> {
  const cached = movieDetailsPromiseCache.get(movieId)
  if (cached) return cached

  const request = fetchTmdb<MovieDetails>(`/movie/${movieId}`, {}, '取得電影詳細資訊失敗')
    .then(async (localized) => (await normalizeMovie(localized)) as MovieDetails)
    .catch((error) => {
      movieDetailsPromiseCache.delete(movieId)
      throw error
    })
  movieDetailsPromiseCache.set(movieId, request)
  return request
}

export async function getMovieDetailsWithFallback(movieId: number): Promise<MovieDetails> {
  const localizedRequest = fetchTmdb<MovieDetails>(`/movie/${movieId}`, {}, '取得電影詳細資訊失敗')
  const englishRequest = fetchTmdb<MovieDetails>(
    `/movie/${movieId}`,
    { language: fallbackLocale },
    '取得英文電影詳細資訊失敗',
  )
  const [localized, english] = await Promise.all([localizedRequest, englishRequest])
  const hasLocalizedOverview = Boolean(localized.overview?.trim())

  const normalized = (await normalizeMovie(
    {
      ...localized,
      original_title: localized.original_title || english.original_title,
      overview: hasLocalizedOverview ? localized.overview : english.overview?.trim() || '',
      genres: localized.genres?.length ? localized.genres : english.genres,
    },
    hasLocalizedOverview ? primaryLocale : english.overview?.trim() ? fallbackLocale : 'none',
  )) as MovieDetails

  return {
    ...normalized,
    title:
      (await normalizeTmdbChineseText(localized.title)) ||
      english.title?.trim() ||
      localized.original_title?.trim() ||
      '未命名電影',
  }
}

export async function getRecommendedMovies(movieId: number): Promise<Movie[]> {
  const page = await fetchTmdb<MoviePage>(
    `/movie/${movieId}/recommendations`,
    {},
    '取得推薦電影列表失敗',
  )
  return (await normalizeMoviePage(page)).results
}

let movieGenresPromise: Promise<MovieGenre[]> | null = null

export function getMovieGenres(): Promise<MovieGenre[]> {
  if (movieGenresPromise) return movieGenresPromise

  movieGenresPromise = Promise.allSettled([
    fetchTmdb<MovieGenresResponse>('/genre/movie/list', {}, '取得中文電影類型失敗'),
    fetchTmdb<MovieGenresResponse>(
      '/genre/movie/list',
      { language: fallbackLocale },
      '取得英文電影類型失敗',
    ),
  ])
    .then(async ([localizedResult, englishResult]) => {
      if (localizedResult.status === 'rejected' && englishResult.status === 'rejected') {
        throw localizedResult.reason
      }

      const localizedGenres =
        localizedResult.status === 'fulfilled' ? localizedResult.value.genres : []
      const englishGenres = englishResult.status === 'fulfilled' ? englishResult.value.genres : []
      const localizedNames = new Map(
        await Promise.all(
          localizedGenres.map(
            async (genre) => [genre.id, await normalizeTmdbChineseText(genre.name)] as const,
          ),
        ),
      )

      return englishGenres
        .map((genre) => ({
          id: genre.id,
          name: localizedNames.get(genre.id) || genre.name,
        }))
        .concat(
          await Promise.all(
            localizedGenres
              .filter((genre) => !englishGenres.some(({ id }) => id === genre.id))
              .map(async (genre) => ({
                ...genre,
                name: await normalizeTmdbChineseText(genre.name),
              })),
          ),
        )
        .sort((first, second) => first.name.localeCompare(second.name, primaryLocale))
    })
    .catch((error) => {
      movieGenresPromise = null
      throw error
    })

  return movieGenresPromise
}

export function getPosterUrl(posterPath: string): string {
  return `https://image.tmdb.org/t/p/w500${posterPath}`
}
