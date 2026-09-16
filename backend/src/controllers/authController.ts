import type { Request, Response } from 'express'
import { User } from '../models/userModel.js'
import { StatusCodes } from 'http-status-codes'
import * as yup from 'yup'
import { compare } from 'bcrypt'
import jwt from 'jsonwebtoken'
import { RefreshToken } from '../models/refreshTokenModel.js'
import { PasswordResetToken } from '../models/passwordResetTokenModel.js'
import {
  random,
  hash,
  refreshCookieOptions,
  getRefreshCookieOptions,
  REFRESH_TOKEN_TTL_MS,
} from '../utils/refreshToken.js'
import { sendPasswordResetEmail } from '../services/emailService.js'
import { createFrontendApplicationUrl } from '../configs/frontendConfiguration.js'

const PASSWORD_RESET_TOKEN_TTL_MS = 30 * 60 * 1000
const FORGOT_PASSWORD_MESSAGE = '如果此 Email 已註冊，我們會寄送密碼重設連結。'
const INVALID_RESET_TOKEN_MESSAGE = '密碼重設連結無效或已過期'

const registerSchema = yup.object({
  account: yup.string().required(),
  email: yup.string().required().email(),
  password: yup.string().required().min(8),
})

const loginSchema = yup.object({
  email: yup.string().required().email(),
  password: yup.string().required(),
  rememberMe: yup.boolean().default(false),
})

const forgotPasswordSchema = yup.object({
  email: yup.string().required().email(),
})

const resetPasswordSchema = yup.object({
  token: yup.string().required().max(256),
  password: yup.string().required().min(8),
  passwordConfirmation: yup
    .string()
    .required()
    .oneOf([yup.ref('password')], 'Password confirmation does not match'),
})

export const register = async (req: Request, res: Response) => {
  const parsedBody = await registerSchema.validate(req.body, { stripUnknown: true })

  await User.create(parsedBody)

  res.status(StatusCodes.CREATED).json({
    message: 'Register successful',
  })
}

export const login = async (req: Request, res: Response) => {
  const parsedBody = await loginSchema.validate(req.body, {
    stripUnknown: true,
  })

  const { email, password, rememberMe } = parsedBody

  const user = await User.findOne({ email }).select('+password')

  if (!user) {
    res.status(StatusCodes.UNAUTHORIZED).json({
      message: 'Invalid email or password',
    })

    return
  }
  const isPasswordValid = await compare(password, user.password)

  if (!isPasswordValid) {
    res.status(StatusCodes.UNAUTHORIZED).json({
      message: 'Invalid email or password',
    })

    return
  }

  const accessToken = jwt.sign({ userId: user._id }, process.env.JWT_SECRET!, {
    expiresIn: '15m',
  })

  const refreshToken = random()
  const hashedRefreshToken = hash(refreshToken)

  await RefreshToken.create({
    user: user._id,
    refreshToken: hashedRefreshToken,
    expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
    rememberMe,
  })

  res
    .status(StatusCodes.OK)
    .cookie('refresh', refreshToken, getRefreshCookieOptions(rememberMe))
    .json({
      message: 'Login successful',
      accessToken,
    })
}

export const refresh = async (req: Request, res: Response) => {
  // 取原始 RT
  const refreshToken = req.cookies.refresh

  // 沒有 RT
  if (!refreshToken) {
    res.status(StatusCodes.UNAUTHORIZED).json({
      message: 'Invalid refresh token',
    })

    return
  }
  const hashedRefreshToken = hash(refreshToken)

  const storedRefreshToken = await RefreshToken.findOne({
    refreshToken: hashedRefreshToken,
  })

  if (!storedRefreshToken) {
    res.status(StatusCodes.UNAUTHORIZED).json({
      message: 'Invalid refresh token',
    })

    return
  }

  // RT 已過期
  if (storedRefreshToken.expiresAt < new Date()) {
    // 清除這筆 RT
    await storedRefreshToken.deleteOne()

    res.status(StatusCodes.UNAUTHORIZED).json({
      message: 'Invalid refresh token',
    })

    return
  }

  // 簽發新的 AT
  const accessToken = jwt.sign({ userId: storedRefreshToken.user }, process.env.JWT_SECRET!, {
    expiresIn: '15m',
  })
  await storedRefreshToken.deleteOne()

  // 新 RT
  const newRefreshToken = random()
  const newHashedRefreshToken = hash(newRefreshToken)
  const rememberMe = storedRefreshToken.rememberMe ?? true

  await RefreshToken.create({
    user: storedRefreshToken.user,
    refreshToken: newHashedRefreshToken,
    expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
    rememberMe,
  })

  // .cookie 存新 RT 進 cookie
  // .json 將新的 AT response body 回傳給前端
  res
    .status(StatusCodes.OK)
    .cookie('refresh', newRefreshToken, getRefreshCookieOptions(rememberMe))
    .json({
      message: 'Refresh successful',
      accessToken,
    })
}

// 登出
export const logout = async (req: Request, res: Response) => {
  const refreshToken = req.cookies.refresh

  if (refreshToken) {
    const hashedRefreshToken = hash(refreshToken)

    // 有就刪除
    await RefreshToken.findOneAndDelete({
      refreshToken: hashedRefreshToken,
    })
  }
  // 清除 cookie
  res.status(StatusCodes.OK).clearCookie('refresh', refreshCookieOptions).json({
    message: 'Logout successful',
  })
}

const issuePasswordReset = async (email: string) => {
  const user = await User.findOne({ email })

  if (!user) {
    return
  }

  const rawToken = random()
  const tokenHash = hash(rawToken)

  await PasswordResetToken.findOneAndUpdate(
    { user: user._id },
    {
      tokenHash,
      expiresAt: new Date(Date.now() + PASSWORD_RESET_TOKEN_TTL_MS),
    },
    {
      upsert: true,
      runValidators: true,
    },
  )

  const resetUrl = createFrontendApplicationUrl('reset-password')
  resetUrl.searchParams.set('token', rawToken)

  await sendPasswordResetEmail(user.email, resetUrl.toString())
}

export const forgotPassword = async (req: Request, res: Response) => {
  const { email } = await forgotPasswordSchema.validate(req.body, {
    stripUnknown: true,
  })

  void issuePasswordReset(email).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.error('Password reset request processing failed: ' + message)
  })

  res.status(StatusCodes.OK).json({
    message: FORGOT_PASSWORD_MESSAGE,
  })
}

export const resetPassword = async (req: Request, res: Response) => {
  const { token, password } = await resetPasswordSchema.validate(req.body, {
    stripUnknown: true,
  })

  const resetToken = await PasswordResetToken.findOneAndDelete({
    tokenHash: hash(token),
    expiresAt: {
      $gt: new Date(),
    },
  })

  if (!resetToken) {
    res.status(StatusCodes.BAD_REQUEST).json({
      message: INVALID_RESET_TOKEN_MESSAGE,
    })
    return
  }

  const user = await User.findById(resetToken.user)

  if (!user) {
    res.status(StatusCodes.BAD_REQUEST).json({
      message: INVALID_RESET_TOKEN_MESSAGE,
    })
    return
  }

  user.password = password
  await user.save()
  await RefreshToken.deleteMany({ user: user._id })

  res.status(StatusCodes.OK).json({
    message: '密碼重設成功，請重新登入',
  })
}
