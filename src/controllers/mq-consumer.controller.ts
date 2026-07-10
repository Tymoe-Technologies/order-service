/**
 * MQ 消费者控制器
 * 处理来自 MQ Service 的订单消息
 */

import { Request, Response } from 'express';
import logger from '../utils/logger';
import mqConsumerService from '../services/mq-consumer.service';

interface MQMessage {
  type: string;
  payload: any;
  correlationId?: string;
}

class MQConsumerController {
  /**
   * 处理来自 MQ Service 的订单消息
   * 支持 ORDER_CREATED、ORDER_UPDATED、ORDER_CANCELLED 等消息类型
   */
  async handleOrderMessage(req: Request, res: Response) {
    try {
      const message: MQMessage = req.body;
      const tenantId = req.headers['x-tenant-id'] as string;
      const userId = req.user?.id || 'system';

      logger.info('收到 MQ 消息', {
        messageType: message.type,
        correlationId: message.correlationId,
        tenantId,
      });

      // 路由消息到相应的处理方法
      let result;
      switch (message.type) {
        case 'ORDER_CREATED':
          result = await mqConsumerService.handleOrderCreated(
            message,
            userId,
            tenantId
          );
          break;

        case 'ORDER_UPDATED':
          result = await mqConsumerService.handleOrderUpdated(message);
          break;

        case 'ORDER_CANCELLED':
          result = await mqConsumerService.handleOrderCancelled(
            message,
            tenantId
          );
          break;

        default:
          logger.warn('未知的消息类型', {
            messageType: message.type,
            correlationId: message.correlationId,
          });
          return res.status(400).json({
            success: false,
            error: {
              code: 'UNKNOWN_MESSAGE_TYPE',
              message: `Unknown message type: ${message.type}`,
            },
          });
      }

      // 返回成功响应
      return res.json({
        success: true,
        message: `Message processed successfully`,
        messageType: message.type,
        correlationId: message.correlationId,
        result,
      });
    } catch (error) {
      logger.error('处理 MQ 消息失败', {
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      });

      return res.status(500).json({
        success: false,
        error: {
          code: 'MESSAGE_PROCESSING_ERROR',
          message:
            error instanceof Error
              ? error.message
              : 'Failed to process message',
        },
      });
    }
  }
}

export default new MQConsumerController();
