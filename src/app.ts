import express, { Application, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import swaggerUi from 'swagger-ui-express';
import swaggerJsdoc from 'swagger-jsdoc';
import routes from './routes';
import internalRoutes from './routes/internal';
import twilioVoiceRoutes from './routes/twilio-voice.routes';
import { errorHandler } from './middleware/errorHandler';
import { validateMerchantId } from './middleware/validateMerchantId';
import logger from './utils/logger';

const app: Application = express();

// Swagger configuration
const swaggerOptions = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Order Service API',
      version: '1.0.0',
      description: '订单管理服务API文档',
    },
    servers: [
      {
        url: `http://localhost:${process.env.PORT || 3002}/api/order/v1`,
        description: 'Development server',
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
      },
    },
    security: [
      {
        bearerAuth: [],
      },
    ],
  },
  apis: ['./src/routes/*.ts'],
};

const swaggerSpec = swaggerJsdoc(swaggerOptions);

// CORS - 必须是第一个中间件
const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') || [
  'http://localhost:3000',
  'http://localhost:3005',  // OnlionShop Frontend
  'http://localhost:8888',
];

logger.info('CORS allowed origins:', { allowedOrigins });

app.use(
  cors({
    origin: function (origin, callback) {
      // 允许没有 origin 的请求 (如 Postman, curl)
      if (!origin) {
        return callback(null, true);
      }

      const originStr = String(origin);

      // 检查是否在白名单中
      if (allowedOrigins.includes(originStr)) {
        return callback(null, true);
      }

      // 检查是否是 Cloudflare Tunnel 域名 (*.trycloudflare.com)
      try {
        const url = new URL(originStr);
        if (url.hostname.endsWith('.trycloudflare.com')) {
          return callback(null, true);
        }
        // ngrok 隧道域名（开发测试用）
        if (url.hostname.endsWith('.ngrok-free.app') || url.hostname.endsWith('.ngrok-free.dev') || url.hostname.endsWith('.ngrok.io')) {
          return callback(null, true);
        }
        // 开发环境放行所有局域网 IP origin（任意端口）
        if (process.env.NODE_ENV !== 'production' && (
            /^192\.168\.\d{1,3}\.\d{1,3}$/.test(url.hostname)
            || /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(url.hostname)
            || /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(url.hostname)
        )) {
          return callback(null, true);
        }
      } catch (error) {
        // URL 解析失败，拒绝
      }

      // 拒绝其他来源
      logger.warn('CORS 拒绝:', { origin: originStr });
      callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-organization-id', 'x-tenant-id', 'x-merchant-id'],
    exposedHeaders: ['Content-Range', 'X-Content-Range'],
    maxAge: 600,
    preflightContinue: false,
    optionsSuccessStatus: 204
  })
);

// 信任反向代理（Cloudflare Tunnel / Nginx），确保 rate-limit 能正确识别客户端 IP
app.set('trust proxy', 1);

// Middleware
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));
app.use(compression());

// Rate limiting
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000'),
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '120'),
  message: '请求过于频繁,请稍后再试',
  skip: (req) => {
    // POS/内部请求不限流：带 Bearer token 的都是已认证的 POS 或后台请求
    if (req.headers.authorization?.startsWith('Bearer ')) return true;
    // order-service 内部路由（health check 等）
    if (req.path === '/health') return true;
    return false;
  },
});
app.use('/api', limiter);

// Body parser
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 请求日志（过滤 health check 和高频轮询）
app.use((req: Request, _res: Response, next) => {
  // 跳过 health check 和 web 订单轮询
  if (req.path === '/health' || (req.method === 'GET' && req.path.startsWith('/api/order/v1/web/orders/'))) {
    return next();
  }
  logger.info(`${req.method} ${req.path}`, {
    ip: req.ip,
  });
  next();
});

// Health check
app.get('/health', (req: Request, res: Response) => {
  res.json({
    status: 'healthy',
    service: process.env.SERVICE_NAME || 'order-service',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// API Documentation
app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// 内部服务接口（服务间调用，不需要 merchantId 验证）
app.use('/internal', internalRoutes);

// Twilio 语音回调（公网可访问，不走 merchantId/租户校验，用共享 token 保护，见 alert.service.ts）
app.use('/public/twilio', twilioVoiceRoutes);

// API Routes - 先应用商家 ID 验证中间件 (async 中间件)
app.use('/api/order/v1', (req, res, next) => {
  validateMerchantId(req, res, next).catch(next);
});
app.use('/api/order/v1', routes);

// 404 handler
app.use((req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    error: {
      code: 'NOT_FOUND',
      message: '请求的资源不存在',
    },
  });
});

// Error handler
app.use(errorHandler);

export default app;
