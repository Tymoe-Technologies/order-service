import { Request, Response, NextFunction } from 'express';
import logger from '../utils/logger';
import { errorResponse } from '../utils/response';

export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: any
  ) {
    super(message);
    this.name = 'AppError';
    Error.captureStackTrace(this, this.constructor);
  }
}

export const errorHandler = (
  err: Error | AppError,
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  logger.error('Error:', {
    message: err.message,
    stack: err.stack,
    url: req.url,
    method: req.method,
  });

  if (err instanceof AppError) {
    errorResponse(res, err.code, err.message, err.statusCode, err.details);
    return;
  }

  // Handle Prisma errors
  if (err.name === 'PrismaClientKnownRequestError') {
    const prismaError = err as any;
    if (prismaError.code === 'P2002') {
      errorResponse(res, 'DUPLICATE_ENTRY', '记录已存在', 409);
      return;
    }
    if (prismaError.code === 'P2025') {
      errorResponse(res, 'NOT_FOUND', '记录不存在', 404);
      return;
    }
  }

  // Default error
  errorResponse(res, 'INTERNAL_ERROR', '服务器内部错误', 500);
};
