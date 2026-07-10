import { Request, Response, NextFunction } from 'express'
import { logger } from '../lib/logger.js'

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.session['userId']) {
    logger.info({ method: req.method, path: req.path, originalUrl: req.originalUrl }, 'requireAuth: rejected — no session userId')
    res.status(401).json({ error: 'Unauthorized' })
    return
  }
  next()
}
