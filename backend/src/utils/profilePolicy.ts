import * as yup from 'yup'

const updateProfileSchema = yup.object({
  displayName: yup
    .string()
    .trim()
    .required('顯示名稱為必填')
    .min(2, '顯示名稱至少需要 2 個字元')
    .max(40, '顯示名稱最多 40 個字元'),
  bio: yup.string().trim().max(160, '個人簡介最多 160 個字元').default(''),
})

export const parseProfileUpdate = (body: unknown) =>
  updateProfileSchema.validate(body, {
    abortEarly: true,
    stripUnknown: true,
  })
