export type DirectReconciliationTrigger =
  'direct.updated' | 'relationship.updated' | 'message.created' | 'reconnect'

export function directInvalidationPolicy(trigger: DirectReconciliationTrigger) {
  const reconcile = trigger !== 'message.created'
  return {
    reconcile,
    disableActions: reconcile,
    suppressSharedContext: trigger === 'direct.updated' || trigger === 'reconnect',
  } as const
}
