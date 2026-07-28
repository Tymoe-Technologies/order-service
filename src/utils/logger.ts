import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import { getRequestId } from './requestContext';

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
    winston.format.splat(),
    winston.format.json()
  ),
  defaultMeta: { service: process.env.SERVICE_NAME || 'order-service' },
  transports: [
    // 按天轮转 + 单文件最大 20MB 强制切分；超出总量上限自动删最老的一份——
    // 防止日志文件无限增长（此前 combined.log 曾长到数十 MB 从未清理）
    new DailyRotateFile({
      filename: 'logs/error-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      level: 'error',
      maxSize: '20m',
      maxFiles: '30d',
    }),
    new DailyRotateFile({
      filename: 'logs/combined-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxSize: '20m',
      maxFiles: '14d',
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
