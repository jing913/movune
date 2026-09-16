import nodemailer from 'nodemailer'

const SMTP_ENV_KEYS = [
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_SECURE',
  'SMTP_USER',
  'SMTP_PASS',
  'SMTP_FROM',
] as const

interface SmtpConfiguration {
  host: string
  port: number
  secure: boolean
  user: string
  pass: string
  from: string
}

const getMissingSmtpEnvKeys = () => {
  return SMTP_ENV_KEYS.filter((key) => !process.env[key])
}

const getSmtpConfiguration = (): SmtpConfiguration | null => {
  const missingKeys = getMissingSmtpEnvKeys()

  if (missingKeys.length > 0) {
    return null
  }

  const port = Number(process.env.SMTP_PORT)
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error('SMTP_PORT must be a positive integer')
  }

  const secureValue = process.env.SMTP_SECURE
  if (secureValue !== 'true' && secureValue !== 'false') {
    throw new Error('SMTP_SECURE must be either true or false')
  }

  return {
    host: process.env.SMTP_HOST!,
    port,
    secure: secureValue === 'true',
    user: process.env.SMTP_USER!,
    pass: process.env.SMTP_PASS!,
    from: process.env.SMTP_FROM!,
  }
}

export const validateEmailConfiguration = () => {
  const missingKeys = getMissingSmtpEnvKeys()

  if (missingKeys.length === 0) {
    getSmtpConfiguration()
    return
  }

  const message = 'Missing SMTP environment variables: ' + missingKeys.join(', ')

  if (process.env.NODE_ENV === 'production') {
    throw new Error(message)
  }

  console.warn('[DEV ONLY] ' + message + '. Password reset URLs will be written to the console.')
}

export const sendPasswordResetEmail = async (recipient: string, resetUrl: string) => {
  const smtp = getSmtpConfiguration()

  if (!smtp) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('SMTP configuration is required in production')
    }

    console.warn('[DEV ONLY] Password reset URL: ' + resetUrl)
    return
  }

  const transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: {
      user: smtp.user,
      pass: smtp.pass,
    },
  })

  await transporter.sendMail({
    from: smtp.from,
    to: recipient,
    subject: 'Movune 密碼重設',
    text: [
      '我們收到你的 Movune 密碼重設請求。',
      '',
      '請在 30 分鐘內使用以下連結設定新密碼：',
      resetUrl,
      '',
      '如果你沒有提出此要求，可以忽略這封信。',
    ].join('\n'),
  })
}
