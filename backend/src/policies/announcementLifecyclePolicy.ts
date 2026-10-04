export const ANNOUNCEMENT_CATEGORIES = [
  'platform_announcement',
  'feature_update',
  'system_maintenance',
] as const

export const ANNOUNCEMENT_PRIORITIES = ['normal', 'important'] as const
export const ANNOUNCEMENT_PUBLICATION_STATUSES = ['draft', 'published', 'withdrawn'] as const
export const ANNOUNCEMENT_GOVERNANCE_STATUSES = ['normal', 'exceptionally_removed'] as const
export const ANNOUNCEMENT_MAINTENANCE_STATUSES = ['scheduled', 'in_progress', 'completed'] as const

export type AnnouncementCategory = (typeof ANNOUNCEMENT_CATEGORIES)[number]
export type AnnouncementPriority = (typeof ANNOUNCEMENT_PRIORITIES)[number]
export type AnnouncementPublicationStatus = (typeof ANNOUNCEMENT_PUBLICATION_STATUSES)[number]
export type AnnouncementGovernanceStatus = (typeof ANNOUNCEMENT_GOVERNANCE_STATUSES)[number]
export type AnnouncementMaintenanceStatus = (typeof ANNOUNCEMENT_MAINTENANCE_STATUSES)[number]

export type AnnouncementMaintenanceData = Readonly<{
  status: AnnouncementMaintenanceStatus
  startsAt: Date
  endsAt: Date
  affectedAreas: readonly string[]
  expectedImpact: string
  actualCompletionTime?: Date
}>

const isValidDate = (value: unknown): value is Date =>
  value instanceof Date && Number.isFinite(value.valueOf())

const isNonemptyTrimmedText = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value === value.trim()

export const isValidAnnouncementMaintenanceData = (
  value: unknown,
): value is AnnouncementMaintenanceData => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const maintenance = value as Record<string, unknown>
  const allowedKeys = new Set([
    'status',
    'startsAt',
    'endsAt',
    'affectedAreas',
    'expectedImpact',
    'actualCompletionTime',
  ])
  if (Object.keys(maintenance).some((key) => !allowedKeys.has(key))) return false
  if (!(ANNOUNCEMENT_MAINTENANCE_STATUSES as readonly unknown[]).includes(maintenance.status)) {
    return false
  }
  if (!isValidDate(maintenance.startsAt) || !isValidDate(maintenance.endsAt)) return false
  if (maintenance.startsAt >= maintenance.endsAt) return false
  if (
    !Array.isArray(maintenance.affectedAreas) ||
    maintenance.affectedAreas.length === 0 ||
    !maintenance.affectedAreas.every(isNonemptyTrimmedText)
  ) {
    return false
  }
  if (!isNonemptyTrimmedText(maintenance.expectedImpact)) return false

  return maintenance.status === 'completed'
    ? isValidDate(maintenance.actualCompletionTime)
    : maintenance.actualCompletionTime === undefined
}

export const canOrdinarilyMutateAnnouncement = (governanceStatus: AnnouncementGovernanceStatus) =>
  governanceStatus === 'normal'

export const canTransitionAnnouncementGovernance = (
  from: AnnouncementGovernanceStatus,
  to: AnnouncementGovernanceStatus,
) => from === 'normal' && to === 'exceptionally_removed'

const publicationTransitions: Readonly<Record<AnnouncementPublicationStatus, readonly string[]>> = {
  draft: ['published'],
  published: ['withdrawn'],
  withdrawn: ['published'],
}

export const canTransitionAnnouncementPublication = (
  from: AnnouncementPublicationStatus,
  to: AnnouncementPublicationStatus,
  governanceStatus: AnnouncementGovernanceStatus = 'normal',
) => canOrdinarilyMutateAnnouncement(governanceStatus) && publicationTransitions[from].includes(to)

const maintenanceTransitions: Readonly<Record<AnnouncementMaintenanceStatus, readonly string[]>> = {
  scheduled: ['in_progress', 'completed'],
  in_progress: ['completed'],
  completed: [],
}

export const canTransitionAnnouncementMaintenance = (
  from: AnnouncementMaintenanceStatus,
  to: AnnouncementMaintenanceStatus,
  governanceStatus: AnnouncementGovernanceStatus = 'normal',
) => canOrdinarilyMutateAnnouncement(governanceStatus) && maintenanceTransitions[from].includes(to)

const isMaintenanceCategory = (category: AnnouncementCategory) => category === 'system_maintenance'

export const canTransitionAnnouncementCategory = ({
  from,
  to,
  currentMaintenance,
  nextMaintenance,
  governanceStatus = 'normal',
}: Readonly<{
  from: AnnouncementCategory
  to: AnnouncementCategory
  currentMaintenance?: AnnouncementMaintenanceData
  nextMaintenance?: AnnouncementMaintenanceData
  governanceStatus?: AnnouncementGovernanceStatus
}>) => {
  if (!canOrdinarilyMutateAnnouncement(governanceStatus)) return false
  if (from === to) return false

  if (!isMaintenanceCategory(from) && !isMaintenanceCategory(to)) {
    return currentMaintenance === undefined && nextMaintenance === undefined
  }

  if (!isMaintenanceCategory(from) && isMaintenanceCategory(to)) {
    return (
      currentMaintenance === undefined &&
      isValidAnnouncementMaintenanceData(nextMaintenance) &&
      nextMaintenance.status === 'scheduled'
    )
  }

  return (
    isValidAnnouncementMaintenanceData(currentMaintenance) &&
    currentMaintenance.status === 'scheduled' &&
    nextMaintenance === undefined
  )
}
