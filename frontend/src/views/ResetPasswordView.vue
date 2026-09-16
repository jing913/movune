<template>
  <section class="mx-auto w-full max-w-md px-4 py-12">
    <div class="bg-background space-y-6 rounded-lg border p-6 shadow-sm">
      <header class="space-y-2">
        <h1 class="text-2xl font-semibold">重設密碼</h1>
        <p class="text-muted-foreground text-sm">請設定至少 8 個字元的新密碼。</p>
      </header>

      <form v-if="!successMessage" class="space-y-6" novalidate @submit="onSubmit">
        <FieldGroup class="gap-5">
          <Field :data-invalid="Boolean(errors.password)">
            <FieldLabel for="reset-password">新密碼</FieldLabel>
            <div class="relative">
              <Input
                id="reset-password"
                v-model="password"
                v-bind="passwordAttrs"
                :type="showPassword ? 'text' : 'password'"
                autocomplete="new-password"
                placeholder="請輸入新密碼"
                class="pr-10"
                :aria-invalid="Boolean(errors.password)"
                :aria-describedby="passwordDescribedBy"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                class="absolute top-0 right-0 h-9 w-9 text-muted-foreground hover:bg-transparent hover:text-foreground"
                :aria-label="showPassword ? '隱藏新密碼' : '顯示新密碼'"
                :aria-pressed="showPassword"
                @click="showPassword = !showPassword"
              >
                <EyeOffIcon v-if="showPassword" />
                <EyeIcon v-else />
              </Button>
            </div>
            <FieldDescription id="reset-password-description">密碼至少 8 個字元</FieldDescription>
            <FieldError id="reset-password-error" :errors="[errors.password]" />
          </Field>

          <Field :data-invalid="Boolean(errors.passwordConfirmation)">
            <FieldLabel for="reset-password-confirmation">確認新密碼</FieldLabel>
            <div class="relative">
              <Input
                id="reset-password-confirmation"
                v-model="passwordConfirmation"
                v-bind="passwordConfirmationAttrs"
                :type="showPasswordConfirmation ? 'text' : 'password'"
                autocomplete="new-password"
                placeholder="請再次輸入新密碼"
                class="pr-10"
                :aria-invalid="Boolean(errors.passwordConfirmation)"
                :aria-describedby="
                  errors.passwordConfirmation ? 'reset-password-confirmation-error' : undefined
                "
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                class="absolute top-0 right-0 h-9 w-9 text-muted-foreground hover:bg-transparent hover:text-foreground"
                :aria-label="showPasswordConfirmation ? '隱藏確認密碼' : '顯示確認密碼'"
                :aria-pressed="showPasswordConfirmation"
                @click="showPasswordConfirmation = !showPasswordConfirmation"
              >
                <EyeOffIcon v-if="showPasswordConfirmation" />
                <EyeIcon v-else />
              </Button>
            </div>
            <FieldError
              id="reset-password-confirmation-error"
              :errors="[errors.passwordConfirmation]"
            />
          </Field>
        </FieldGroup>

        <p v-if="displayError" role="alert" class="text-destructive text-sm">
          {{ displayError }}
        </p>

        <Button type="submit" class="w-full" :disabled="isSubmitting"> 重設密碼 </Button>
      </form>

      <div v-else class="space-y-4">
        <p role="status" class="text-sm text-emerald-600 dark:text-emerald-400">
          {{ successMessage }}
        </p>
        <Button type="button" class="w-full" @click="returnToLogin">返回登入</Button>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { EyeIcon, EyeOffIcon } from '@lucide/vue'
import { toTypedSchema } from '@vee-validate/yup'
import axios from 'axios'
import { useForm } from 'vee-validate'
import * as yup from 'yup'
import { useRoute, useRouter } from 'vue-router'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { useUserStore } from '@/stores/user'

interface ResetPasswordFormValues {
  password: string
  passwordConfirmation: string
}

interface ApiErrorResponse {
  message: string
}

const emit = defineEmits<{
  'open-login': []
}>()

const route = useRoute()
const router = useRouter()
const userStore = useUserStore()

const showPassword = ref(false)
const showPasswordConfirmation = ref(false)
const errorMessage = ref('')
const successMessage = ref('')

const resetToken = computed(() => {
  return typeof route.query.token === 'string' ? route.query.token : ''
})

const displayError = computed(() => {
  if (errorMessage.value) {
    return errorMessage.value
  }

  return resetToken.value ? '' : '密碼重設連結無效或已過期'
})

const resetPasswordSchema = toTypedSchema(
  yup.object({
    password: yup.string().required('請輸入新密碼').min(8, '密碼至少需要 8 個字元'),
    passwordConfirmation: yup
      .string()
      .required('請再次輸入新密碼')
      .oneOf([yup.ref('password')], '兩次輸入的密碼不一致'),
  }),
)

const { defineField, errors, handleSubmit, isSubmitting, resetForm } =
  useForm<ResetPasswordFormValues>({
    validationSchema: resetPasswordSchema,
    initialValues: {
      password: '',
      passwordConfirmation: '',
    },
  })

const [password, passwordAttrs] = defineField('password')
const [passwordConfirmation, passwordConfirmationAttrs] = defineField('passwordConfirmation')

const passwordDescribedBy = computed(() => {
  return errors.value.password
    ? 'reset-password-description reset-password-error'
    : 'reset-password-description'
})

const onSubmit = handleSubmit(async (values) => {
  errorMessage.value = ''

  if (!resetToken.value) {
    errorMessage.value = '密碼重設連結無效或已過期'
    return
  }

  try {
    const message = await userStore.resetPassword(
      resetToken.value,
      values.password,
      values.passwordConfirmation,
    )
    resetForm()
    showPassword.value = false
    showPasswordConfirmation.value = false
    successMessage.value = message
    await router.replace({ path: route.path })
  } catch (error) {
    if (axios.isAxiosError<ApiErrorResponse>(error) && error.response?.data.message) {
      errorMessage.value = error.response.data.message
    } else {
      errorMessage.value = '密碼重設失敗，請稍後再試'
    }
  }
})

async function returnToLogin() {
  emit('open-login')
  await router.push('/')
}
</script>
