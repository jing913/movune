import { isObjectIdOrHexString } from 'mongoose'

export const ENCOUNTER_ROUND_LIMIT = 5
export const ENCOUNTER_SESSION_EXCLUSION_LIMIT = 1000
export const ENCOUNTER_COOLDOWN_EXCLUSION_LIMIT = ENCOUNTER_ROUND_LIMIT

const parseEncounterIds = (value: unknown, limit: number): string[] | null => {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > limit) return null
  if (value.some((id) => typeof id !== 'string' || !isObjectIdOrHexString(id))) return null
  return [...new Set(value as string[])]
}

export const parseEncounterSessionExclusionIds = (value: unknown) =>
  parseEncounterIds(value, ENCOUNTER_SESSION_EXCLUSION_LIMIT)

export const parseEncounterCooldownIds = (value: unknown) =>
  parseEncounterIds(value, ENCOUNTER_COOLDOWN_EXCLUSION_LIMIT)

export const parseEncounterExclusionIds = parseEncounterSessionExclusionIds
