export type ReadInvalidation =
  | { resource: 'direct'; id: string }
  | { resource: 'discussion'; id: string }
  | { resource: 'notification'; id: string }
  | { resource: 'notifications' }

export function createLatestProjectionReconciler<T>(
  load: () => Promise<T>,
  apply: (value: T) => void,
) {
  let version = 0
  return async () => {
    const requestVersion = ++version
    const value = await load()
    if (requestVersion !== version) return false
    apply(value)
    return true
  }
}

type ReadInvalidationDependencies = {
  reconcileDirect(): Promise<unknown>
  reconcileDiscussion(): Promise<unknown>
  reconcileNotifications(): Promise<unknown>
  reconcileSummary(): Promise<unknown>
}

export function createReadInvalidationHandler(dependencies: ReadInvalidationDependencies) {
  return async (payload: ReadInvalidation) => {
    if (payload.resource === 'direct') {
      await Promise.allSettled([dependencies.reconcileDirect(), dependencies.reconcileSummary()])
      return
    }
    if (payload.resource === 'discussion') {
      await Promise.allSettled([
        dependencies.reconcileDiscussion(),
        dependencies.reconcileSummary(),
      ])
      return
    }
    await Promise.allSettled([
      dependencies.reconcileNotifications(),
      dependencies.reconcileSummary(),
    ])
  }
}
