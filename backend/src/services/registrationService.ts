import mongoose, { Types, type ClientSession } from 'mongoose'
import { IdentifierClaim } from '../models/identifierClaimModel.js'
import { User } from '../models/userModel.js'
import {
  canonicalizeEmailIdentifier,
  canonicalizeUsernameIdentifier,
  type IdentifierKind,
} from '../utils/identifierPolicy.js'

export type RegistrationInput = Readonly<{
  account: string
  email: string
  password: string
}>

export type RegistrationConflictField = 'account' | 'email'

export class RegistrationConflictError extends Error {
  readonly field: RegistrationConflictField
  readonly code: 'REGISTRATION_ACCOUNT_CONFLICT' | 'REGISTRATION_EMAIL_CONFLICT'

  constructor(field: RegistrationConflictField) {
    const emailConflict = field === 'email'
    super(emailConflict ? 'Email already exists' : 'Account already exists')
    this.name = 'RegistrationConflictError'
    this.field = field
    this.code = emailConflict ? 'REGISTRATION_EMAIL_CONFLICT' : 'REGISTRATION_ACCOUNT_CONFLICT'
  }
}

type ClaimWrite = Readonly<{
  kind: IdentifierKind
  canonicalKey: string
  ownerUserId: Types.ObjectId
  state: 'active'
}>

type UserWrite = Readonly<{
  _id: Types.ObjectId
  account: string
  email: string
  password: string
}>

type SaveableUser = Readonly<{
  save: (options: Readonly<{ session: ClientSession }>) => Promise<unknown>
}>

type TransactionRunner = (operation: (session: ClientSession) => Promise<void>) => Promise<unknown>

export type RegistrationServiceDependencies = Readonly<{
  transactionRunner?: TransactionRunner
  generateUserId?: () => Types.ObjectId
  createClaim?: (claim: ClaimWrite, session: ClientSession) => Promise<unknown>
  createUserDocument?: (user: UserWrite) => SaveableUser
  afterClaimCreated?: (kind: IdentifierKind) => void | Promise<void>
}>

const isDuplicateKeyError = (error: unknown): error is { code: 11000 } =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 11000

const legacyUserConflictField = (error: unknown): RegistrationConflictField | undefined => {
  if (!isDuplicateKeyError(error) || !('keyPattern' in error)) return undefined
  const keyPattern = error.keyPattern
  if (typeof keyPattern !== 'object' || keyPattern === null) return undefined
  const keys = Object.keys(keyPattern)
  if (keys.length !== 1) return undefined
  if (keys[0] === 'email') return 'email'
  if (keys[0] === 'account') return 'account'
  return undefined
}

const defaultTransactionRunner: TransactionRunner = (operation) =>
  mongoose.connection.transaction(operation)

const defaultCreateClaim = (claim: ClaimWrite, session: ClientSession) =>
  IdentifierClaim.create([claim], { session })

const defaultCreateUserDocument = (user: UserWrite): SaveableUser => new User(user)

export const createRegistrationService = (dependencies: RegistrationServiceDependencies = {}) => {
  const transactionRunner = dependencies.transactionRunner ?? defaultTransactionRunner
  const generateUserId = dependencies.generateUserId ?? (() => new Types.ObjectId())
  const createClaim = dependencies.createClaim ?? defaultCreateClaim
  const createUserDocument = dependencies.createUserDocument ?? defaultCreateUserDocument
  const afterClaimCreated = dependencies.afterClaimCreated

  return async (input: RegistrationInput) => {
    const email = canonicalizeEmailIdentifier(input.email)
    const username = canonicalizeUsernameIdentifier(input.account)
    const password = input.password
    const userId = generateUserId()

    await transactionRunner(async (session) => {
      try {
        await createClaim(
          {
            kind: 'email',
            canonicalKey: email.canonicalKey,
            ownerUserId: userId,
            state: 'active',
          },
          session,
        )
      } catch (error) {
        if (isDuplicateKeyError(error)) throw new RegistrationConflictError('email')
        throw error
      }
      await afterClaimCreated?.('email')

      try {
        await createClaim(
          {
            kind: 'username',
            canonicalKey: username.canonicalKey,
            ownerUserId: userId,
            state: 'active',
          },
          session,
        )
      } catch (error) {
        if (isDuplicateKeyError(error)) throw new RegistrationConflictError('account')
        throw error
      }
      await afterClaimCreated?.('username')

      const user = createUserDocument({
        _id: userId,
        account: username.representation,
        email: email.representation,
        password,
      })
      try {
        await user.save({ session })
      } catch (error) {
        const field = legacyUserConflictField(error)
        if (field) throw new RegistrationConflictError(field)
        throw error
      }
    })

    return Object.freeze({ userId })
  }
}

export const registerUser = createRegistrationService()
