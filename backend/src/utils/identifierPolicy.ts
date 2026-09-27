export const IDENTIFIER_KINDS = ['email', 'username'] as const
export type IdentifierKind = (typeof IDENTIFIER_KINDS)[number]

export const IDENTIFIER_CLAIM_STATES = ['active', 'reserved'] as const
export type IdentifierClaimState = (typeof IDENTIFIER_CLAIM_STATES)[number]

export const USERNAME_MIN_CODE_POINTS = 2
export const USERNAME_MAX_CODE_POINTS = 20

export type CanonicalizedIdentifier = Readonly<{
  representation: string
  canonicalKey: string
}>

export class IdentifierPolicyError extends Error {
  readonly code = 'IDENTIFIER_INVALID'

  constructor(message: string) {
    super(message)
    this.name = 'IdentifierPolicyError'
  }
}

const USERNAME_ALLOWED_PATTERN =
  /^(?:[\p{Letter}&&[\p{Script_Extensions=Latin}\p{Script_Extensions=Han}]]|[0-9_])+$/v
const DEFAULT_IGNORABLE_PATTERN = /\p{Default_Ignorable_Code_Point}/v

function assertString(input: unknown, label: string): asserts input is string {
  if (typeof input !== 'string') throw new IdentifierPolicyError(`${label} must be a string`)
}

export const canonicalizeEmailIdentifier = (input: unknown): CanonicalizedIdentifier => {
  assertString(input, 'Email identifier')

  const representation = input.trim()
  if (representation.length === 0)
    throw new IdentifierPolicyError('Email identifier cannot be empty')

  return {
    representation,
    canonicalKey: representation.toLowerCase(),
  }
}

export const canonicalizeUsernameIdentifier = (input: unknown): CanonicalizedIdentifier => {
  assertString(input, 'Username identifier')
  if (DEFAULT_IGNORABLE_PATTERN.test(input)) {
    throw new IdentifierPolicyError('Username identifier contains an invisible character')
  }

  const representation = input.normalize('NFC')
  const codePointLength = [...representation].length
  if (codePointLength < USERNAME_MIN_CODE_POINTS || codePointLength > USERNAME_MAX_CODE_POINTS) {
    throw new IdentifierPolicyError(
      `Username identifier must contain ${USERNAME_MIN_CODE_POINTS} to ${USERNAME_MAX_CODE_POINTS} Unicode code points`,
    )
  }
  if (representation !== representation.normalize('NFKC')) {
    throw new IdentifierPolicyError('Username identifier contains a compatibility character')
  }
  if (!USERNAME_ALLOWED_PATTERN.test(representation)) {
    throw new IdentifierPolicyError('Username identifier contains an unsupported character')
  }

  return {
    representation,
    canonicalKey: representation.toLowerCase(),
  }
}
