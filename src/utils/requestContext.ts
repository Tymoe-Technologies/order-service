import { AsyncLocalStorage } from 'async_hooks';

/**
 * 请求级上下文（跨异步调用透传）。
 *
 * 用途：把每次请求的 X-Request-Id 存进来，logger 自动把它注入每一条日志——
 * 现有所有 logger 调用点一个都不用改，就能让整条请求的日志带上同一个 id，
 * 之后在 Loki 里按这个 id（或订单号等业务键）就能拉出一次请求横跨所有服务的全部日志。
 *
 * 非侵入：AsyncLocalStorage 基于 Node 的 async_hooks，不改变任何业务逻辑，
 * 没有上下文时（比如定时任务/消费者）getStore() 返回 undefined，安全降级。
 */
export interface RequestContext {
  requestId: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

/** 取当前请求的 requestId（不在请求上下文里时返回 undefined） */
export function getRequestId(): string | undefined {
  return requestContext.getStore()?.requestId;
}
