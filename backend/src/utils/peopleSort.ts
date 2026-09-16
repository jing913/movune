import type { PipelineStage } from 'mongoose'

export const PEOPLE_SORTS = ['recent'] as const
export type PeopleSort = (typeof PEOPLE_SORTS)[number]

export const isPeopleSort = (value: string): value is PeopleSort =>
  PEOPLE_SORTS.includes(value as PeopleSort)

export const buildPeopleSortStages = (): PipelineStage[] => [{ $sort: { createdAt: -1, _id: -1 } }]
