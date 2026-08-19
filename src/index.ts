import dotenv from 'dotenv';
import path from 'path';

// 必须在其他模块 import 之前加载环境变量：
// 后面 import 的模块（如 utils/jwks.ts 的单例）会在加载时就读取 process.env，
// 如果 dotenv.config() 放在这些 import 之后，它们读到的永远是 undefined。
const envFile = process.env.NODE_ENV === 'production' ? '.env.production' : '.env.development';
dotenv.config({ path: path.resolve(process.cwd(), envFile) });

import { createServer } from 'http';
import app from './app';
import logger from './utils/logger';
import prisma from './utils/prisma';
import { initializeRabbitMQ } from './utils/rabbitmq';
import { startRabbitMQConsumer, stopRabbitMQConsumer } from './services/rabbitmq-consumer';
import { initWebSocketServer, closeWebSocketServer } from './websocket/ws-server';
import { initQueueDisplayServer } from './websocket/queue-display-server';
import { registerAllHandlers } from './events';
import { startScheduledOrderRelease, stopScheduledOrderRelease } from './jobs/scheduled-order-release';
import { startDeliveryConfirmationWatchdog, stopDeliveryConfirmationWatchdog } from './jobs/delivery-confirmation-watchdog';
import { startAutoDeliveryConfirmation, stopAutoDeliveryConfirmation } from './jobs/auto-delivery-confirmation';
import { purgeExpiredIdempotencyKeys } from './services/idempotency.service';
import { startOutboxRelay } from './services/outbox.service';

const PORT = process.env.PORT || 3002;

// ========== RabbitMQ 配置 ==========
const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672';
const RABBITMQ_EXCHANGE = process.env.RABBITMQ_EXCHANGE || 'orders';
const RABBITMQ_QUEUE = process.env.RABBITMQ_QUEUE || 'order.service.queue';
const RABBITMQ_ROUTING_KEY = process.env.RABBITMQ_ROUTING_KEY || 'order.#';

// Graceful shutdown
const gracefulShutdown = async () => {
  logger.info('Shutting down gracefully...');

  try {
    // 停止预约单释放定时器
    stopScheduledOrderRelease();

    // 停止配送订单确认超时 watchdog
    stopDeliveryConfirmationWatchdog();

    // 停止 15 分钟自动接单定时器
    stopAutoDeliveryConfirmation();

    // 关闭 WebSocket 服务
    await closeWebSocketServer();

    // 停止 RabbitMQ 消费者
    if (process.env.RABBITMQ_ENABLED !== 'false') {
      await stopRabbitMQConsumer();
    }

    await prisma.$disconnect();
    logger.info('Database connection closed');
    process.exit(0);
  } catch (error) {
    logger.error('Error during shutdown:', error);
    process.exit(1);
  }
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// Start server
const startServer = async () => {
  try {
    // Test database connection
    await prisma.$connect();
    logger.info('Database connected successfully');

    // 注册事件总线处理器
    registerAllHandlers();

    // ========== 初始化 RabbitMQ（非阻塞）==========
    const isRabbitMQEnabled = process.env.RABBITMQ_ENABLED !== 'false';

    if (isRabbitMQEnabled) {
      logger.info('初始化 RabbitMQ 连接...');
      const rabbitmq = initializeRabbitMQ({
        url: RABBITMQ_URL,
        exchange: RABBITMQ_EXCHANGE,
        queue: RABBITMQ_QUEUE,
        routingKey: RABBITMQ_ROUTING_KEY,
        prefetch: 1,
      });

      // 尝试连接到 RabbitMQ（失败不影响服务启动）
      try {
        await rabbitmq.connect();
        // 启动 RabbitMQ 消费者
        await startRabbitMQConsumer();
        logger.info('RabbitMQ consumer is running');
      } catch (rabbitmqError) {
        logger.warn('⚠️  RabbitMQ 连接失败，服务将在没有消息队列的情况下运行', {
          error: rabbitmqError instanceof Error ? rabbitmqError.message : 'Unknown error',
        });
        logger.warn('💡 提示：如需使用消息队列功能，请确保 RabbitMQ 服务已启动');
      }
    } else {
      logger.info('RabbitMQ is disabled by configuration (RABBITMQ_ENABLED != true)');
    }

    // ========== 启动 HTTP + WebSocket 服务器 ==========
    const httpServer = createServer(app);

    // 初始化 WebSocket 打印队列服务
    initWebSocketServer(httpServer);

    // 初始化叫号屏 WebSocket 服务
    initQueueDisplayServer(httpServer);

    httpServer.listen(PORT, () => {
      logger.info(`Order Service running on port ${PORT}`);
      logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
      logger.info(`API Documentation: http://localhost:${PORT}/api/docs`);
      logger.info(`WebSocket print queue: ws://localhost:${PORT}/ws/print-queue`);
    });

    // ========== 启动预约单释放定时器 ==========
    // 取代 DB pg_cron(release-scheduled-orders)：到点自动 CONFIRMED + 打印 + 广播
    startScheduledOrderRelease();

    // ========== 启动配送订单确认超时 watchdog ==========
    // 支付成功 15 分钟后仍未创建 Uber 配送单（deliveryConfirmedAt 为 null）就告警，
    // 兜底"接单弹窗因锁屏/未登录等原因错过、员工从未点击确认"的场景
    startDeliveryConfirmationWatchdog();

    // ========== 启动 15 分钟自动接单定时器 ==========
    // 支付成功 15 分钟内员工未确认时，系统自动用默认备餐时间建配送单；
    // 建单失败则自动取消订单 + 退款 + Twilio 告警（见 auto-delivery-confirmation.ts）
    startAutoDeliveryConfirmation();

    // ========== 启动事件待发板 relay ==========
    /*
      间隔短是因为**厨房打印在这条路上** —— 出单慢一拍店员就会抱怨。
      500ms 空转的成本是一条走索引的查询，可以忽略。
    */
    startOutboxRelay(500);

    // ========== 幂等键过期清理 ==========
    /*
      纯控表大小，**不是正确性依赖** —— 记录清掉之后同一个 key 再来会被当成新
      请求，走到 orders.id 主键那道兜底。所以跑不跑、什么时候跑都不影响对错。
      每小时一次即可；启动时先跑一次，免得进程频繁重启时永远轮不到。
    */
    void purgeExpiredIdempotencyKeys().catch(() => {});
    setInterval(() => { void purgeExpiredIdempotencyKeys().catch(() => {}); }, 3600_000);
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
};

startServer();
