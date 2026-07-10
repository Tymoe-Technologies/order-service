import rateLimit from 'express-rate-limit';

// 订单源路由的限流中间件
export const rateLimitMiddleware = rateLimit({
  windowMs: 15 * 60 * 1000, // 15分钟时间窗口
  max: 100, // 限制每个IP在时间窗口内最多100个请求
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true, // 返回速率限制信息在 RateLimit-* 头中
  legacyHeaders: false, // 禁用 X-RateLimit-* 头
  skip: (req) => {
    // 允许带有有效令牌的请求绕过限流
    // 这可以基于用户权限或其他条件进行定制
    return false;
  },
});
