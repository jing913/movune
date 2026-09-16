<template>
  <Dialog :open="props.open" @update:open="handleOpenChange">
    <DialogContent
      class="max-h-[calc(100dvh-2rem)] overflow-x-hidden overflow-y-auto overscroll-contain p-4 sm:max-h-none sm:max-w-md sm:overflow-visible sm:p-6"
    >
      <DialogHeader>
        <DialogTitle>{{ dialogTitle }}</DialogTitle>
        <DialogDescription>{{ dialogDescription }}</DialogDescription>
      </DialogHeader>

      <form class="space-y-4 sm:space-y-6" novalidate @submit="onSubmit">
        <FieldGroup class="gap-4 sm:gap-5">
          <Field v-if="mode === 'register'" :data-invalid="Boolean(errors.account)">
            <FieldLabel for="auth-account">帳號</FieldLabel>
            <Input
              id="auth-account"
              v-model="account"
              v-bind="accountAttrs"
              type="text"
              placeholder="請輸入帳號"
              autocomplete="username"
              :aria-invalid="Boolean(errors.account)"
              :aria-describedby="errors.account ? 'auth-account-error' : undefined"
            />
            <FieldError id="auth-account-error" :errors="[errors.account]" />
          </Field>

          <Field :data-invalid="Boolean(errors.email)">
            <FieldLabel for="auth-email">Email</FieldLabel>
            <Input
              id="auth-email"
              v-model="email"
              v-bind="emailAttrs"
              type="email"
              placeholder="請輸入 Email"
              autocomplete="email"
              :aria-invalid="Boolean(errors.email)"
              :aria-describedby="errors.email ? 'auth-email-error' : undefined"
            />
            <FieldError id="auth-email-error" :errors="[errors.email]" />
          </Field>

          <Field v-if="mode !== 'forgot'" :data-invalid="Boolean(errors.password)">
            <FieldLabel for="auth-password">密碼</FieldLabel>
            <div class="relative">
              <Input
                id="auth-password"
                v-model="password"
                v-bind="passwordAttrs"
                :type="showPassword ? 'text' : 'password'"
                placeholder="請輸入密碼"
                :autocomplete="mode === 'login' ? 'current-password' : 'new-password'"
                class="pr-10"
                :aria-invalid="Boolean(errors.password)"
                :aria-describedby="passwordDescribedBy"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                class="absolute top-0 right-0 h-9 w-9 text-muted-foreground hover:bg-transparent hover:text-foreground"
                :aria-label="showPassword ? '隱藏密碼' : '顯示密碼'"
                :aria-pressed="showPassword"
                @click="showPassword = !showPassword"
              >
                <EyeOffIcon v-if="showPassword" />
                <EyeIcon v-else />
              </Button>
            </div>
            <FieldDescription v-if="mode === 'register'" id="auth-password-description">
              密碼至少 8 個字元
            </FieldDescription>
            <FieldError id="auth-password-error" :errors="[errors.password]" />
          </Field>
        </FieldGroup>

        <div v-if="mode === 'login'" class="flex items-center justify-between gap-4">
          <Field orientation="horizontal" class="w-auto items-center gap-2">
            <Checkbox
              id="auth-remember-me"
              v-model="rememberMe"
              v-bind="rememberMeAttrs"
              :aria-invalid="Boolean(errors.rememberMe)"
            />
            <FieldLabel for="auth-remember-me">記住我</FieldLabel>
          </Field>
          <Button
            type="button"
            variant="link"
            class="h-auto p-0"
            :disabled="isSubmitting"
            @click="switchMode('forgot')"
          >
            忘記密碼？
          </Button>
        </div>

        <p
          v-if="successMessage"
          role="status"
          class="text-sm text-emerald-600 dark:text-emerald-400"
        >
          {{ successMessage }}
        </p>
        <p v-if="errorMessage" role="alert" class="text-destructive text-sm">
          {{ errorMessage }}
        </p>

        <Button type="submit" class="w-full" :disabled="isSubmitting">
          {{ submitLabel }}
        </Button>

        <div v-if="mode !== 'forgot'" class="flex items-center justify-center gap-1 text-sm">
          <span class="text-muted-foreground">
            {{ mode === 'login' ? '還沒有帳號？' : '已經有帳號？' }}
          </span>
          <Button
            type="button"
            variant="link"
            class="h-auto p-0"
            :disabled="isSubmitting"
            @click="switchMode(mode === 'login' ? 'register' : 'login')"
          >
            {{ mode === 'login' ? '註冊' : '返回登入' }}
          </Button>
        </div>
        <div v-else class="flex justify-center">
          <Button
            type="button"
            variant="link"
            class="h-auto p-0"
            :disabled="isSubmitting"
            @click="switchMode('login')"
          >
            返回登入
          </Button>
        </div>
      </form>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { EyeIcon, EyeOffIcon } from '@lucide/vue'
import { toTypedSchema } from '@vee-validate/yup'
import axios from 'axios'
import { useForm } from 'vee-validate'
import * as yup from 'yup'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { useUserStore } from '@/stores/user'

type AuthMode = 'login' | 'register' | 'forgot'

interface AuthFormValues {
  account: string
  email: string
  password: string
  rememberMe: boolean
}

interface ApiErrorResponse {
  message: string
}

const emptyFormValues: AuthFormValues = {
  account: '',
  email: '',
  password: '',
  rememberMe: false,
}

const props = defineProps<{
  open: boolean
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
}>()

const mode = ref<AuthMode>('login')
const showPassword = ref(false)
const errorMessage = ref('')
const successMessage = ref('')

const dialogTitle = computed(() => {
  if (mode.value === 'forgot') {
    return '忘記密碼'
  }

  return mode.value === 'login' ? '登入' : '註冊'
})

const dialogDescription = computed(() => {
  if (mode.value === 'forgot') return '輸入註冊 Email，我們會提供密碼重設方式。'
  if (mode.value === 'register') return '建立 Movune 帳號，從收藏電影開始整理你的電影品味。'
  return '登入後即可管理收藏、Movie DNA 與探索電影同好。'
})

const submitLabel = computed(() => {
  if (mode.value === 'forgot') {
    return '寄送重設連結'
  }

  return mode.value === 'login' ? '登入' : '註冊'
})

const loginSchema = toTypedSchema(
  yup.object({
    account: yup.string().default(''),
    email: yup.string().required('請輸入 Email').email('Email 格式不正確'),
    password: yup.string().required('請輸入密碼'),
    rememberMe: yup.boolean().required(),
  }),
)

const registerSchema = toTypedSchema(
  yup.object({
    account: yup.string().required('請輸入帳號'),
    email: yup.string().required('請輸入 Email').email('Email 格式不正確'),
    password: yup.string().required('請輸入密碼').min(8, '密碼至少需要 8 個字元'),
    rememberMe: yup.boolean().default(false),
  }),
)

const forgotPasswordSchema = toTypedSchema(
  yup.object({
    account: yup.string().default(''),
    email: yup.string().required('請輸入 Email').email('Email 格式不正確'),
    password: yup.string().default(''),
    rememberMe: yup.boolean().default(false),
  }),
)

const validationSchema = computed(() => {
  if (mode.value === 'forgot') {
    return forgotPasswordSchema
  }

  return mode.value === 'login' ? loginSchema : registerSchema
})

const { defineField, errors, handleSubmit, isSubmitting, resetForm } = useForm<AuthFormValues>({
  validationSchema,
  initialValues: emptyFormValues,
})

const [account, accountAttrs] = defineField('account')
const [email, emailAttrs] = defineField('email')
const [password, passwordAttrs] = defineField('password')
const [rememberMe, rememberMeAttrs] = defineField('rememberMe')

const passwordDescribedBy = computed(() => {
  const descriptions: string[] = []

  if (mode.value === 'register') {
    descriptions.push('auth-password-description')
  }

  if (errors.value.password) {
    descriptions.push('auth-password-error')
  }

  return descriptions.join(' ') || undefined
})

const userStore = useUserStore()

function clearMessages() {
  errorMessage.value = ''
  successMessage.value = ''
}

function resetAuthForm() {
  resetForm({ values: { ...emptyFormValues } })
  showPassword.value = false
}

function resetDialogState() {
  mode.value = 'login'
  resetAuthForm()
  clearMessages()
}

function switchMode(newMode: AuthMode) {
  mode.value = newMode
  resetAuthForm()
  clearMessages()
}

function handleOpenChange(open: boolean) {
  if (!open) {
    resetDialogState()
  }

  emit('update:open', open)
}

const onSubmit = handleSubmit(
  async (values) => {
    clearMessages()
    const submittedMode = mode.value

    try {
      if (submittedMode === 'login') {
        await userStore.login(values.email, values.password, values.rememberMe)
        resetDialogState()
        emit('update:open', false)
        return
      }

      if (submittedMode === 'register') {
        await userStore.register(values.account, values.email, values.password)
        mode.value = 'login'
        resetAuthForm()
        clearMessages()
        successMessage.value = '註冊成功，請登入'
        return
      }

      const message = await userStore.forgotPassword(values.email)
      resetAuthForm()
      clearMessages()
      successMessage.value = message
    } catch (error) {
      if (submittedMode === 'login') {
        if (axios.isAxiosError<ApiErrorResponse>(error) && error.response?.status === 401) {
          errorMessage.value = 'Email 或密碼錯誤'
        } else {
          errorMessage.value = '登入失敗，請稍後再試'
        }
        return
      }

      if (
        submittedMode === 'register' &&
        axios.isAxiosError<ApiErrorResponse>(error) &&
        (error.response?.status === 400 || error.response?.status === 409)
      ) {
        errorMessage.value = error.response.data.message
      } else if (submittedMode === 'register') {
        errorMessage.value = '註冊失敗，請稍後再試'
      } else {
        errorMessage.value = '寄送失敗，請稍後再試'
      }
    }
  },
  () => clearMessages(),
)

watch(
  () => props.open,
  () => resetDialogState(),
  { immediate: true },
)
</script>
