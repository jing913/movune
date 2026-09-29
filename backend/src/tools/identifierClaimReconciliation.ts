import { Types } from 'mongoose'
import { IdentifierClaim } from '../models/identifierClaimModel.js'
import { User } from '../models/userModel.js'
import { scanEligibleUsers, type EligibleUser } from './identifierClaimBackfill.js'

export type ReconciliationResult = Readonly<{
  outcome: 'PASS' | 'PENDING' | 'STOP'
  usersExamined: number
  requiredEmailClaims: number
  requiredUsernameClaims: number
  matchedEmailClaims: number
  matchedUsernameClaims: number
  missingEmailClaims: number
  missingUsernameClaims: number
  wrongOwnerClaims: number
  incorrectStateClaims: number
  duplicateNamespaceGroups: number
  duplicateNamespaceDocuments: number
  orphanClaims: number
  unexpectedClaims: number
  invalidClaims: number
  coveragePercent: number
}>

type ReconciliationDependencies = Readonly<{
  userModel?: typeof User
  claimModel?: typeof IdentifierClaim
}>

const namespaceKey = (kind: 'email' | 'username', canonicalKey: string) =>
  `${kind}\u0000${canonicalKey}`

const expectedNamespace = (user: EligibleUser) => [
  {
    kind: 'email' as const,
    canonicalKey: user.emailCanonicalKey,
    ownerUserId: user.userId.toString(),
  },
  {
    kind: 'username' as const,
    canonicalKey: user.usernameCanonicalKey,
    ownerUserId: user.userId.toString(),
  },
]

export const runIdentifierClaimReconciliation = async ({
  userModel = User,
  claimModel = IdentifierClaim,
}: ReconciliationDependencies = {}): Promise<ReconciliationResult> => {
  const users = await scanEligibleUsers({ userModel })
  const expectedByNamespace = new Map<
    string,
    Readonly<{ kind: 'email' | 'username'; ownerUserId: string }>
  >()
  const userIds = new Set<string>()
  for (const user of users) {
    userIds.add(user.userId.toString())
    for (const expected of expectedNamespace(user)) {
      expectedByNamespace.set(namespaceKey(expected.kind, expected.canonicalKey), {
        kind: expected.kind,
        ownerUserId: expected.ownerUserId,
      })
    }
  }

  const namespaceCounts = new Map<string, number>()
  const matchedNamespaces = new Set<string>()
  let wrongOwnerClaims = 0
  let incorrectStateClaims = 0
  let orphanClaims = 0
  let unexpectedClaims = 0
  let invalidClaims = 0

  const cursor = claimModel
    .find()
    .select('_id kind canonicalKey ownerUserId state')
    .sort({ _id: 1 })
    .lean()
    .cursor()
  for await (const value of cursor) {
    const claim = value as {
      kind?: unknown
      canonicalKey?: unknown
      ownerUserId?: unknown
      state?: unknown
    }
    if (
      (claim.kind !== 'email' && claim.kind !== 'username') ||
      typeof claim.canonicalKey !== 'string' ||
      !(claim.ownerUserId instanceof Types.ObjectId) ||
      (claim.state !== 'active' && claim.state !== 'reserved')
    ) {
      invalidClaims += 1
      continue
    }

    const key = namespaceKey(claim.kind, claim.canonicalKey)
    namespaceCounts.set(key, (namespaceCounts.get(key) ?? 0) + 1)
    const ownerUserId = claim.ownerUserId.toString()
    const expected = expectedByNamespace.get(key)

    if (!userIds.has(ownerUserId)) {
      orphanClaims += 1
      continue
    }
    if (!expected) {
      unexpectedClaims += 1
      continue
    }
    if (expected.ownerUserId !== ownerUserId) {
      wrongOwnerClaims += 1
      continue
    }
    if (claim.state !== 'active') {
      incorrectStateClaims += 1
      continue
    }
    matchedNamespaces.add(key)
  }

  let duplicateNamespaceGroups = 0
  let duplicateNamespaceDocuments = 0
  for (const count of namespaceCounts.values()) {
    if (count > 1) {
      duplicateNamespaceGroups += 1
      duplicateNamespaceDocuments += count
    }
  }

  let matchedEmailClaims = 0
  let matchedUsernameClaims = 0
  for (const [key, expected] of expectedByNamespace) {
    if (!matchedNamespaces.has(key)) continue
    if (expected.kind === 'email') matchedEmailClaims += 1
    else matchedUsernameClaims += 1
  }
  const missingEmailClaims = users.length - matchedEmailClaims
  const missingUsernameClaims = users.length - matchedUsernameClaims
  const requiredClaims = users.length * 2
  const matchedClaims = matchedEmailClaims + matchedUsernameClaims
  const coveragePercent = requiredClaims === 0 ? 100 : (matchedClaims / requiredClaims) * 100
  const conflictCount =
    wrongOwnerClaims +
    incorrectStateClaims +
    duplicateNamespaceGroups +
    orphanClaims +
    unexpectedClaims +
    invalidClaims
  const missingClaims = missingEmailClaims + missingUsernameClaims
  const outcome: ReconciliationResult['outcome'] =
    conflictCount > 0 ? 'STOP' : missingClaims > 0 ? 'PENDING' : 'PASS'

  return {
    outcome,
    usersExamined: users.length,
    requiredEmailClaims: users.length,
    requiredUsernameClaims: users.length,
    matchedEmailClaims,
    matchedUsernameClaims,
    missingEmailClaims,
    missingUsernameClaims,
    wrongOwnerClaims,
    incorrectStateClaims,
    duplicateNamespaceGroups,
    duplicateNamespaceDocuments,
    orphanClaims,
    unexpectedClaims,
    invalidClaims,
    coveragePercent,
  }
}
