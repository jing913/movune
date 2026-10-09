export const ANNOUNCEMENT_HISTORICAL_TIME_ZONE = 'Asia/Taipei'

export const ANNOUNCEMENT_EFFECTIVE_AT_BASES = ['production_verified_no_later_than'] as const

export type AnnouncementEffectiveAtBasis = (typeof ANNOUNCEMENT_EFFECTIVE_AT_BASES)[number]

type CalendarParts = Readonly<{
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}>

const taipeiFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: ANNOUNCEMENT_HISTORICAL_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})

const calendarPartsAt = (instant: Date): CalendarParts => {
  const formatted = taipeiFormatter.formatToParts(instant)
  const value = (type: string) => {
    const part = formatted.find((candidate) => candidate.type === type)
    if (!part) throw new RangeError('Asia/Taipei calendar normalization is unavailable')
    return Number(part.value)
  }
  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    hour: value('hour'),
    minute: value('minute'),
    second: value('second'),
  }
}

const sameCalendarParts = (left: CalendarParts, right: CalendarParts) =>
  left.year === right.year &&
  left.month === right.month &&
  left.day === right.day &&
  left.hour === right.hour &&
  left.minute === right.minute &&
  left.second === right.second

export const normalizeAnnouncementEffectiveDate = (value: string): Date => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) throw new RangeError('effectiveAt must be a canonical YYYY-MM-DD date')

  const target: CalendarParts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: 0,
    minute: 0,
    second: 0,
  }
  const calendarCheck = new Date(Date.UTC(target.year, target.month - 1, target.day))
  if (
    calendarCheck.getUTCFullYear() !== target.year ||
    calendarCheck.getUTCMonth() + 1 !== target.month ||
    calendarCheck.getUTCDate() !== target.day
  ) {
    throw new RangeError('effectiveAt must be a real calendar date')
  }

  const targetWallClock = Date.UTC(
    target.year,
    target.month - 1,
    target.day,
    target.hour,
    target.minute,
    target.second,
  )
  let candidate = targetWallClock
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const represented = calendarPartsAt(new Date(candidate))
    const representedWallClock = Date.UTC(
      represented.year,
      represented.month - 1,
      represented.day,
      represented.hour,
      represented.minute,
      represented.second,
    )
    const adjustment = targetWallClock - representedWallClock
    candidate += adjustment
    if (adjustment === 0) break
  }

  const normalized = new Date(candidate)
  if (!sameCalendarParts(calendarPartsAt(normalized), target)) {
    throw new RangeError('effectiveAt cannot be normalized in Asia/Taipei')
  }
  return normalized
}

export const formatAnnouncementEffectiveDate = (value: Date): string => {
  const parts = calendarPartsAt(value)
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`
}
