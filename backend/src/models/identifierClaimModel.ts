import { Schema, model, type Types } from 'mongoose'
import {
  IDENTIFIER_CLAIM_STATES,
  IDENTIFIER_KINDS,
  type IdentifierClaimState,
  type IdentifierKind,
} from '../utils/identifierPolicy.js'

export interface IIdentifierClaim {
  kind: IdentifierKind
  canonicalKey: string
  ownerUserId: Types.ObjectId
  state: IdentifierClaimState
  createdAt: Date
  updatedAt: Date
}

const identifierClaimSchema = new Schema<IIdentifierClaim>(
  {
    kind: {
      type: String,
      enum: IDENTIFIER_KINDS,
      required: true,
      immutable: true,
    },
    canonicalKey: {
      type: String,
      required: true,
      immutable: true,
    },
    ownerUserId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      immutable: true,
    },
    state: {
      type: String,
      enum: IDENTIFIER_CLAIM_STATES,
      required: true,
    },
  },
  {
    timestamps: true,
    autoIndex: false,
    autoCreate: false,
  },
)

identifierClaimSchema.index({ kind: 1, canonicalKey: 1 }, { unique: true })

export const IdentifierClaim = model<IIdentifierClaim>('IdentifierClaim', identifierClaimSchema)
