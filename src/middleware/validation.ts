import { Request, Response, NextFunction } from 'express';
import Joi from 'joi';
import { errorResponse } from '../utils/response';

export const validate = (schema: Joi.ObjectSchema) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    const { error } = schema.validate(req.body, { abortEarly: false });

    if (error) {
      const details = error.details.map((detail) => ({
        field: detail.path.join('.'),
        message: detail.message,
      }));

      errorResponse(res, 'VALIDATION_ERROR', '请求参数验证失败', 400, details);
      return;
    }

    next();
  };
};
