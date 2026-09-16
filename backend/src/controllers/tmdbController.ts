import type { NextFunction, Request, Response } from 'express'
import { requestTmdb } from '../services/tmdbMetadataService.js'
import { ApiProblem } from '../utils/messagingPolicy.js'

type QueryValue = string | number | boolean | undefined

const handler =
  (operation: (req: Request, res: Response) => Promise<unknown>) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await operation(req, res)
    } catch (error) {
      next(error)
    }
  }

const invalidRequest = (field: string) =>
  new ApiProblem(400, 'TMDB_REQUEST_INVALID', `Invalid ${field}`)

const optionalString = (value: unknown, field: string) => {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw invalidRequest(field)
  return value
}

const requiredString = (value: unknown, field: string) => {
  const result = optionalString(value, field)
  if (!result?.trim() || result.length > 200) throw invalidRequest(field)
  return result
}

const optionalInteger = (value: unknown, field: string, maximum = Number.MAX_SAFE_INTEGER) => {
  const result = optionalString(value, field)
  if (result === undefined) return undefined
  const number = Number(result)
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) throw invalidRequest(field)
  return number
}

const requiredInteger = (value: unknown, field: string) => {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 1) throw invalidRequest(field)
  return number
}

const optionalEnum = <T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
): T | undefined => {
  const result = optionalString(value, field)
  if (result === undefined) return undefined
  if (!allowed.includes(result as T)) throw invalidRequest(field)
  return result as T
}

const optionalPattern = (value: unknown, field: string, pattern: RegExp) => {
  const result = optionalString(value, field)
  if (result !== undefined && !pattern.test(result)) throw invalidRequest(field)
  return result
}

const commonParams = (req: Request): Record<string, QueryValue> => ({
  language: optionalEnum(req.query.language, 'language', ['zh-TW', 'en-US']) ?? 'zh-TW',
})

export const popularMoviesController = handler(async (req, res) => {
  res.json(
    await requestTmdb('/movie/popular', {
      ...commonParams(req),
      page: optionalInteger(req.query.page, 'page', 500),
      region: optionalEnum(req.query.region, 'region', ['TW']),
    }),
  )
})

export const nowPlayingMoviesController = handler(async (req, res) => {
  res.json(
    await requestTmdb('/movie/now_playing', {
      ...commonParams(req),
      page: optionalInteger(req.query.page, 'page', 500),
      region: optionalEnum(req.query.region, 'region', ['TW']),
    }),
  )
})

export const searchMoviesController = handler(async (req, res) => {
  res.json(
    await requestTmdb('/search/movie', {
      ...commonParams(req),
      query: requiredString(req.query.query, 'query'),
      page: optionalInteger(req.query.page, 'page', 500),
      include_adult: optionalEnum(req.query.include_adult, 'include_adult', ['false']),
      region: optionalEnum(req.query.region, 'region', ['TW']),
    }),
  )
})

export const discoverMoviesController = handler(async (req, res) => {
  res.json(
    await requestTmdb('/discover/movie', {
      ...commonParams(req),
      page: optionalInteger(req.query.page, 'page', 500),
      region: optionalEnum(req.query.region, 'region', ['TW']),
      include_adult: optionalEnum(req.query.include_adult, 'include_adult', ['false']),
      include_video: optionalEnum(req.query.include_video, 'include_video', ['false']),
      with_genres: optionalPattern(req.query.with_genres, 'with_genres', /^\d+(?:\|\d+)*$/),
      sort_by: optionalEnum(req.query.sort_by, 'sort_by', [
        'popularity.asc',
        'popularity.desc',
        'vote_average.asc',
        'vote_average.desc',
        'primary_release_date.asc',
        'primary_release_date.desc',
      ]),
      'vote_count.gte': optionalInteger(req.query['vote_count.gte'], 'vote_count.gte'),
      without_genres: optionalPattern(
        req.query.without_genres,
        'without_genres',
        /^\d+(?:\|\d+)*$/,
      ),
      with_release_type: optionalPattern(
        req.query.with_release_type,
        'with_release_type',
        /^\d(?:\|\d)*$/,
      ),
      'release_date.gte': optionalPattern(
        req.query['release_date.gte'],
        'release_date.gte',
        /^\d{4}-\d{2}-\d{2}$/,
      ),
      'release_date.lte': optionalPattern(
        req.query['release_date.lte'],
        'release_date.lte',
        /^\d{4}-\d{2}-\d{2}$/,
      ),
    }),
  )
})

export const movieDetailsController = handler(async (req, res) => {
  const movieId = requiredInteger(req.params.movieId, 'movieId')
  res.json(await requestTmdb(`/movie/${movieId}`, commonParams(req)))
})

export const movieRecommendationsController = handler(async (req, res) => {
  const movieId = requiredInteger(req.params.movieId, 'movieId')
  res.json(await requestTmdb(`/movie/${movieId}/recommendations`, commonParams(req)))
})

export const movieGenresController = handler(async (req, res) => {
  res.json(await requestTmdb('/genre/movie/list', commonParams(req)))
})
