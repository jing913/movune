import express from 'express'
import { rateLimit } from 'express-rate-limit'
import {
  register,
  login,
  refresh,
  logout,
  forgotPassword,
  resetPassword,
} from '../controllers/authController.js'

const router = express.Router()

const forgotPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    message: '請稍後再嘗試寄送密碼重設連結。',
  },
})

router.post('/register', register)
router.post('/login', login)
router.post('/refresh', refresh)
router.post('/logout', logout)
router.post('/forgot-password', forgotPasswordLimiter, forgotPassword)
router.post('/reset-password', resetPassword)

export default router
