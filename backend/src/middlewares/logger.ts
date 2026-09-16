import type { Request, Response, NextFunction } from 'express'

export const logger = (req: Request, res: Response, next: NextFunction) => {
  const requestPath = req.originalUrl.split('?')[0]
  console.log(req.method, requestPath)
  next()
}
