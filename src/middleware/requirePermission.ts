import { Request, Response, NextFunction } from 'express';

/**
 * 细粒度权限校验：只限制 ACCOUNT（员工）token，USER（老板）token 永远放行。
 * 默认按 HTTP 方法推断：GET/HEAD 需要 `${module}.view`，其余方法需要 `${module}.edit`。
 * 部分路由用 POST 做查询，这种可以传 `forceAction` 显式指定，不走方法推断。
 * 必须放在 authenticate 之后，依赖 req.user.userType/permissions 已经被填充
 * （auth.ts 里已经把 JWT 的 userType/permissions 透传到 req.user，见 middleware/auth.ts）。
 */
export function requireModulePermission(module: string, forceAction?: 'view' | 'edit') {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = req.user;

    if (user?.userType !== 'ACCOUNT') {
      next();
      return;
    }

    const action = forceAction ?? (['GET', 'HEAD'].includes(req.method) ? 'view' : 'edit');
    const permissions = user.permissions || [];
    const required = `${module}.${action}`;

    if (!permissions.includes(required)) {
      res.status(403).json({ error: 'forbidden', detail: `Missing permission: ${required}` });
      return;
    }

    next();
  };
}
