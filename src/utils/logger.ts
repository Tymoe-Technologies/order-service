import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import { getRequestId } from './requestContext';
import { scrubPII } from './piiScrub';

const logLevel = process.env.LOG_LEVEL || 'info';

// 自动把当前请求的 requestId 注入每一条日志（有请求上下文时）。放在 combine 最前面，
// 各 transport 都能拿到——现有所有 logger 调用点无需改动。
const injectRequestId = winston.format((info) => {
  const requestId = getRequestId();
  if (requestId && !info.requestId) info.requestId = requestId;
  return info;
});

const logger = winston.createLogger({
  level: logLevel,
  format: winston.format.combine(
    injectRequestId(),
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    scrubPII(), // 落盘前打码手机号/邮箱（订单里的 customerPhone/customerEmail 等）
    winston.format.splat(),
    winston.format.json()
  ),
  defaultMeta: { service: process.env.SERVICE_NAME || 'order-service' },
  transports: [
    // 本地文件只是"Loki 采集前的缓冲 + Loki 不可达时的应急兜底"，长期存储/检索交给 Loki
    // （它的 retention 独立可调，不占应用服务器磁盘），所以本地只留很短时间。
    new DailyRotateFile({
      filename: 'logs/error-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      level: 'error',
      maxSize: '20m',
      maxFiles: '3d',
    }),
    new DailyRotateFile({
      filename: 'logs/combined-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxSize: '20m',
      maxFiles: '2d',
    }),
  ],
});

if (process.env.NODE_ENV !== 'production') {
  logger.add(
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(
          ({ level, message, timestamp, ...metadata }) => {
            let msg = `${timestamp} [${level}]: ${message}`;
            if (Object.keys(metadata).length > 0) {
              msg += ` ${JSON.stringify(metadata)}`;
            }
            return msg;
          }
        )
      ),
    })
  );
}

export default logger;
