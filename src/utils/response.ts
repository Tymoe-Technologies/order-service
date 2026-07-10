import { Response } from 'express';

export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: any;
  };
}

export const successResponse = <T>(res: Response, data: T, statusCode: number = 200): Response => {
  return res.status(statusCode).json({
    success: true,
    data,
  });
};

export const errorResponse = (
  res: Response,
  code: string,
  message: string,
  statusCode: number = 400,
  details?: any
): Response => {
  return res.status(statusCode).json({
    success: false,
    error: {
      code,
      message,
      details,
    },
  });
};
