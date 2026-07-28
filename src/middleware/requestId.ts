import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { requestContext } from '../utils/requestContext';

/**
 * X-Request-Id 中间件（关联 ID 地基）。
 *
 * - 请求头带了 x-request-id（比如网关/上游服务已生成）就沿用，实现跨服务串联；
 * - 没带就自己生成；回写到响应头；
 * - 用 requestContext.run 把后续所有处理都包进同一个上下文，logger 据此自动给每条日志打上该 id。
 *
 * 非侵入：不读 body、不改路由、不改任何业务行为，只是"带上一个 id"。
 */
export function requestId(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.headers['x-request-id'];
  const id = (Array.isArray(incoming) ? incoming[0] : incoming) || randomUUID();
  res.setHeader('x-request-id', id);
  requestContext.run({ requestId: id }, () => next());
}
