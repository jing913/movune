type FrontendEnvironment = {
  FRONTEND_APP_URL?: string
  FRONTEND_ORIGIN?: string
}

export type FrontendConfiguration = {
  applicationUrl: URL
  origin: string
}

const requiredValue = (environment: FrontendEnvironment, name: keyof FrontendEnvironment) => {
  const value = environment[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

const parseHttpUrl = (value: string, name: keyof FrontendEnvironment) => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${name} must be a valid URL`)
  }

  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error(`${name} must be an HTTP(S) URL without credentials`)
  }

  return url
}

export const resolveFrontendConfiguration = (
  environment: FrontendEnvironment = process.env,
): FrontendConfiguration => {
  const applicationUrl = parseHttpUrl(
    requiredValue(environment, 'FRONTEND_APP_URL'),
    'FRONTEND_APP_URL',
  )
  const configuredOrigin = requiredValue(environment, 'FRONTEND_ORIGIN')
  const originUrl = parseHttpUrl(configuredOrigin, 'FRONTEND_ORIGIN')

  if (applicationUrl.search || applicationUrl.hash || !applicationUrl.pathname.endsWith('/')) {
    throw new Error('FRONTEND_APP_URL must end with / and must not include a query or fragment')
  }

  if (configuredOrigin !== originUrl.origin) {
    throw new Error('FRONTEND_ORIGIN must contain only the frontend origin')
  }

  if (applicationUrl.origin !== originUrl.origin) {
    throw new Error('FRONTEND_APP_URL and FRONTEND_ORIGIN must use the same origin')
  }

  return { applicationUrl, origin: originUrl.origin }
}

let frontendConfiguration: FrontendConfiguration | undefined

export const getFrontendConfiguration = () =>
  (frontendConfiguration ??= resolveFrontendConfiguration())

export const createFrontendApplicationUrl = (
  relativePath: string,
  configuration: FrontendConfiguration = getFrontendConfiguration(),
) => new URL(relativePath.replace(/^\/+/, ''), configuration.applicationUrl)
