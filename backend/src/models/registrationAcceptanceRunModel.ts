import { Schema, model, type Types } from 'mongoose'
import {
  REGISTRATION_ACCEPTANCE_OPERATIONS,
  REGISTRATION_ACCEPTANCE_STATES,
  type RegistrationAcceptanceFixtureBinding,
  type RegistrationAcceptanceOperation,
  type RegistrationAcceptanceState,
} from '../utils/registrationAcceptanceManifest.js'

export type RegistrationAcceptanceAuditEvent = Readonly<{
  operationId: string
  operation: RegistrationAcceptanceOperation
  outcome: string
  at: Date
}>

export interface IRegistrationAcceptanceRun {
  _id: string
  version: 1
  keyId: string
  environment: string
  serviceId: string
  releaseSha: string
  state: RegistrationAcceptanceState
  successBinding: RegistrationAcceptanceFixtureBinding
  conflictBinding: RegistrationAcceptanceFixtureBinding
  fixtureUserId?: Types.ObjectId
  consumedOperationIds: string[]
  revokedOperationIds: string[]
  auditEvents: RegistrationAcceptanceAuditEvent[]
  createdAt: Date
  updatedAt: Date
}

const bindingSchema = new Schema<RegistrationAcceptanceFixtureBinding>(
  {
    accountFingerprint: { type: String, required: true, immutable: true },
    emailFingerprint: { type: String, required: true, immutable: true },
    usernameCanonicalFingerprint: { type: String, required: true, immutable: true },
    emailCanonicalFingerprint: { type: String, required: true, immutable: true },
    passwordFingerprint: { type: String, required: true, immutable: true },
    requestFingerprint: { type: String, required: true, immutable: true },
  },
  { _id: false },
)

const auditEventSchema = new Schema<RegistrationAcceptanceAuditEvent>(
  {
    operationId: { type: String, required: true, immutable: true },
    operation: { type: String, enum: REGISTRATION_ACCEPTANCE_OPERATIONS, required: true },
    outcome: { type: String, required: true },
    at: { type: Date, required: true },
  },
  { _id: false },
)

const registrationAcceptanceRunSchema = new Schema<IRegistrationAcceptanceRun>(
  {
    _id: { type: String, required: true },
    version: { type: Number, required: true, immutable: true },
    keyId: { type: String, required: true, immutable: true },
    environment: { type: String, required: true, immutable: true },
    serviceId: { type: String, required: true, immutable: true },
    releaseSha: { type: String, required: true, immutable: true },
    state: { type: String, enum: REGISTRATION_ACCEPTANCE_STATES, required: true },
    successBinding: { type: bindingSchema, required: true, immutable: true },
    conflictBinding: { type: bindingSchema, required: true, immutable: true },
    fixtureUserId: { type: Schema.Types.ObjectId, ref: 'User' },
    consumedOperationIds: { type: [String], required: true, default: [] },
    revokedOperationIds: { type: [String], required: true, default: [] },
    auditEvents: { type: [auditEventSchema], required: true, default: [] },
  },
  { timestamps: true, autoCreate: false, autoIndex: false },
)

registrationAcceptanceRunSchema.index({ consumedOperationIds: 1 }, { unique: true })

export const RegistrationAcceptanceRun = model<IRegistrationAcceptanceRun>(
  'RegistrationAcceptanceRun',
  registrationAcceptanceRunSchema,
)
