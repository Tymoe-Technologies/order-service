import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { errorResponse } from '../utils/response';
import logger from '../utils/logger';
import { jwksClient } from '../utils/jwks';

export interface JwtPayload {
  userId: string;
  tenantId: string;  // 组织ID (Organization ID) - 用于数据隔离
  email?: string;
  userType?: string;
  organizationIds?: string[];
  permissions?: string[];
  deviceId?: string | null;
}

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

export const authenticate = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      logger.warn('Missing or invalid Authorization header', {
        path: req.path,
        hasHeader: !!authHeader,
        headerStart: authHeader?.substring(0, 10),
      });
      errorResponse(res, 'UNAUTHORIZED', '未提供认证令牌', 401);
      return;
    }

    const token = authHeader.substring(7);
    
    // 优先使用环境变量中的公钥,否则从 JWKS 获取
    let jwtPublicKey = process.env.JWT_PUBLIC_KEY;

    if (!jwtPublicKey) {
      try {
        jwtPublicKey = await jwksClient.getPublicKey();
      } catch (error: any) {
        logger.error('Failed to get public key', { error: error.message });
        errorResponse(res, 'SERVER_ERROR', '服务器配置错误', 500);
        return;
      }
    }

    // 使用 RS256 验证
    const decoded = jwt.verify(token, jwtPublicKey, {
      algorithms: ['RS256'],
    }) as any;
    
    // 从请求头获取 orgId (前端传递的当前组织ID)
    const orgIdFromHeader = req.headers['x-organization-id'] as string;
    
    // 映射字段
    const user: JwtPayload = {
      userId: decoded.sub,  // JWT 的 sub 字段是用户ID
      tenantId: orgIdFromHeader || decoded.organizationId || (decoded.organizationIds && decoded.organizationIds[0]),
      email: decoded.email,
      userType: decoded.userType,
      organizationIds: decoded.organizationIds,
      permissions: decoded.permissions,
      deviceId: decoded.deviceId,
    };
    
    // 验证 tenantId 是否存在
    if (!user.tenantId) {
      logger.warn('Missing tenantId', {
        orgIdFromHeader,
        organizationIds: decoded.organizationIds,
        path: req.path,
      });
      errorResponse(res, 'UNAUTHORIZED', '缺少组织ID', 401);
      return;
    }
    
    logger.info('Authentication successful', {
      userId: user.userId,
      tenantId: user.tenantId,
      email: user.email,
      path: req.path,
    });
    
    req.user = user;
    next();
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      logger.warn('Token expired', { path: req.path });
      errorResponse(res, 'TOKEN_EXPIRED', '令牌已过期', 401);
    } else if (error instanceof jwt.JsonWebTokenError) {
      logger.warn('Invalid token', { path: req.path, error: error.message });
      errorResponse(res, 'INVALID_TOKEN', '无效的令牌', 401);
    } else {
      logger.error('Authentication error:', error);
      errorResponse(res, 'UNAUTHORIZED', '认证失败', 401);
    }
  }
};

// 导出别名以兼容不同的导入方式
export const authMiddleware = authenticate;

/**
 * 内部服务认证（Service-to-Service）
 * 验证 x-service-api-key 请求头
 */
export const internalAuth = (req: Request, res: Response, next: NextFunction): void => {
  const apiKey = req.headers['x-service-api-key'] as string;
  const expectedKey = process.env.INTERNAL_SERVICE_KEY;

  if (!expectedKey) {
    // 未配置密钥时（开发环境）直接放行，但记录警告
    logger.warn('[InternalAuth] INTERNAL_SERVICE_KEY 未配置，跳过校验', { path: req.path });
    next();
    return;
  }

  if (!apiKey || apiKey !== expectedKey) {
    errorResponse(res, 'UNAUTHORIZED', '无效的服务密钥', 401);
    return;
  }

  next();
};
