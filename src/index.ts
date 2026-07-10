import dotenv from 'dotenv';
import path from 'path';
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

// Load environment variables
const envFile = process.env.NODE_ENV === 'production' ? '.env.production' : '.env.development';
dotenv.config({ path: path.resolve(process.cwd(), envFile) });

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
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
};

startServer();
