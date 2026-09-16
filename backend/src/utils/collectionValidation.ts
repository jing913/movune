import * as yup from 'yup'

const visibilitySchema = yup.string().oneOf(['private', 'public']).required()
const membershipTmdbIdSchema = yup
  .mixed<number>()
  .required('A valid tmdbId is required')
  .test(
    'valid-membership-tmdb-id',
    'A valid tmdbId is required',
    (value) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0,
  )

const collectionMetadataSchema = {
  name: yup.string().trim().required('Collection name is required'),
  description: yup.string().trim().optional(),
  visibility: visibilitySchema,
}

const createCollectionSchema = yup.object({
  ...collectionMetadataSchema,
  visibility: visibilitySchema.default('private'),
})

const updateCollectionSchema = yup
  .object({
    name: collectionMetadataSchema.name.optional(),
    description: collectionMetadataSchema.description,
    visibility: visibilitySchema.optional(),
  })
  .test(
    'collection-update-not-empty',
    'At least one Collection metadata field is required',
    (value) =>
      value.name !== undefined || value.description !== undefined || value.visibility !== undefined,
  )

const addCollectionMembershipSchema = yup.object({
  tmdbId: membershipTmdbIdSchema,
})

const reorderCollectionMembershipsSchema = yup.object({
  tmdbIds: yup
    .array()
    .of(membershipTmdbIdSchema)
    .required('tmdbIds must be an array')
    .test(
      'collection-order-unique',
      'tmdbIds must not contain duplicates',
      (tmdbIds) => new Set(tmdbIds).size === tmdbIds.length,
    ),
})

const validationOptions = {
  abortEarly: true,
  stripUnknown: true,
}

export type CreateCollectionInput = yup.InferType<typeof createCollectionSchema>
export type UpdateCollectionInput = yup.InferType<typeof updateCollectionSchema>
export type AddCollectionMembershipInput = yup.InferType<typeof addCollectionMembershipSchema>
export type ReorderCollectionMembershipsInput = yup.InferType<
  typeof reorderCollectionMembershipsSchema
>

export const parseCreateCollection = (body: unknown) =>
  createCollectionSchema.validate(body, validationOptions)

export const parseUpdateCollection = (body: unknown) =>
  updateCollectionSchema.validate(body, validationOptions)

export const parseAddCollectionMembership = (body: unknown) =>
  addCollectionMembershipSchema.validate(body, validationOptions)

export const parseReorderCollectionMemberships = (body: unknown) =>
  reorderCollectionMembershipsSchema.validate(body, validationOptions)

export const parseCollectionMembershipTmdbId = async (value: unknown) => {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new yup.ValidationError('A valid tmdbId is required')
  }
  return membershipTmdbIdSchema.validate(Number(value), validationOptions)
}
