/**
 * RabbitMQ 消费者初始化和管理
 */

import logger from '../utils/logger';
import { getRabbitMQConnection } from '../utils/rabbitmq';
import mqConsumerService from './mq-consumer.service';

/**
 * 启动 RabbitMQ 消费者
 */
export async function startRabbitMQConsumer(): Promise<void> {
  try {
    const connection = getRabbitMQConnection();

    logger.info('🚀 启动 RabbitMQ 消费者...');

    // 开始消费消息
    await connection.consume(
      async (message) => {
        // 处理消息
        await handleRabbitMQMessage(message);
      },
      async (error) => {
        // 处理错误
        logger.error('消费消息时出错', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    );

    logger.info('✅ RabbitMQ 消费者已启动');
  } catch (error) {
    logger.error('启动 RabbitMQ 消费者失败', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    throw error;
  }
}

/**
 * 处理 RabbitMQ 消息
 */
async function handleRabbitMQMessage(message: any): Promise<void> {
  try {
    const { v4: uuidv4 } = require('uuid');
    const messageType = message.type;
    const correlationId = message.correlationId;
    // 从消息中提取 tenantId，优先使用 payload 中的值
    let tenantId = message.payload?.tenantId || message.tenantId;

    // 如果没有 tenantId，记录警告并使用默认值（生成一个 UUID）
    if (!tenantId) {
      tenantId = uuidv4();
      logger.warn('消息缺少 tenantId，使用生成的默认值', {
        correlationId,
        generatedTenantId: tenantId,
      });
    }
    // RabbitMQ 消息由系统处理，生成一个系统用户 UUID
    // 使用固定的 UUID 确保所有系统创建的订单都属于同一个系统用户
    const systemUserId = '00000000-0000-0000-0000-000000000000'; // 系统用户 UUID
    const userId = systemUserId;

    logger.info('处理 RabbitMQ 消息', {
      messageType,
      correlationId,
      tenantId,
    });

    // 根据消息类型路由到相应的处理器
    switch (messageType) {
      case 'ORDER_CREATED':
        const createdResult = await mqConsumerService.handleOrderCreated(
          message,
          userId,
          tenantId
        );
        logger.info('ORDER_CREATED 处理完成', {
          correlationId,
          orderId: createdResult?.id,
        });
        break;

      case 'ORDER_UPDATED':
        await mqConsumerService.handleOrderUpdated(message);
        logger.info('ORDER_UPDATED 处理完成', {
          correlationId,
          orderId: message.payload?.orderId,
        });
        break;

      case 'ORDER_CANCELLED':
        await mqConsumerService.handleOrderCancelled(message, tenantId);
        logger.info('ORDER_CANCELLED 处理完成', {
          correlationId,
          orderId: message.payload?.orderId,
        });
        break;

      default:
        logger.warn('未知的消息类型', {
          messageType,
          correlationId,
        });
    }
  } catch (error) {
    logger.error('处理 RabbitMQ 消息失败', {
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error; // 重新抛出错误，让 RabbitMQ 连接管理器处理重试
  }
}

/**
 * 停止 RabbitMQ 消费者
 */
export async function stopRabbitMQConsumer(): Promise<void> {
  try {
    const connection = getRabbitMQConnection();
    await connection.close();
    logger.info('RabbitMQ 消费者已停止');
  } catch (error) {
    logger.error('停止 RabbitMQ 消费者失败', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
