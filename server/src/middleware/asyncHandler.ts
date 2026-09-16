import { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * Wraps an async route handler so a rejected promise (e.g. Prisma losing
 * the DB connection) is forwarded to Express's error middleware instead of
 * becoming an unhandled rejection — which crashes the whole Node process
 * on Node 18+.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
