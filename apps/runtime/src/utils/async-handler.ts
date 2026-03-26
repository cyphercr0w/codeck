import { Request, Response, NextFunction } from "express";

/**
 * Express 4 does NOT catch rejected promises from async route handlers.
 * Wrap async handlers with this utility to forward errors to Express error middleware.
 */
export const asyncHandler =
	(fn: (req: Request, res: Response, next: NextFunction) => Promise<any>) =>
	(req: Request, res: Response, next: NextFunction) =>
		Promise.resolve(fn(req, res, next)).catch(next);
