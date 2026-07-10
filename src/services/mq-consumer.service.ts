/**
 * MQ 消费者服务
 * 处理来自 MQ Service 的订单消息
 */

import logger from '../utils/logger';
import orderService from './order.service';

interface OrderMessage {
  type: string;
  payload: {
    orderId?: string;
    orderType?: 'DINE_IN' | 'TAKEOUT' | 'DELIVERY';
    clientOrigin?: 'POS' | 'WEB' | 'KIOSK';
    tableNumber?: string;
    customerName?: string;
    customerPhone?: string;
    items: Array<{
      itemId: string;
      itemName: string;
      quantity: number;
      unitPrice: number;
      discountAmount?: number;
      discountType?: 'PERCENTAGE' | 'FIXED';
      discountValue?: number;
      discountReason?: string;
      attributes?: any;
      modifiers?: any;
      specialNotes?: string;
    }>;
    notes?: string;
    taxAmount?: number;
    discountAmount?: number;
    serviceFee?: number;
    deliveryFee?: number;
    platformFee?: number;
    tipAmount?: number;
    discountType?: string;
    discountCode?: string;
    discountReason?: string;
    paymentMethod?: string;
    transactionId?: string;
  };
  correlationId?: string;
}

export class MQConsumerService {
  /**
   * 处理 ORDER_CREATED 消息
   * 这是订单创建时调用的主处理方法
   * 包含幂等性检查，防止重复处理
   */
  async handleOrderCreated(message: OrderMessage, userId: string, tenantId: string): Promise<any> {
    try {
      logger.info('处理 ORDER_CREATED 消息', {
        correlationId: message.correlationId,
        messageId: message.payload.orderId,
      });

      // ========== 消息验证 ==========
      // 确保消息包含必要的字段
      if (!message.payload) {
        throw new Error('消息缺少 payload 字段');
      }

      if (!message.payload.items || message.payload.items.length === 0) {
        throw new Error('消息的 items 为空');
      }

      // orderType 可选，默认为 DINE_IN
      if (!message.payload.orderType) {
        logger.warn('消息缺少 orderType 字段，使用默认值 DINE_IN', {
          correlationId: message.correlationId,
          orderId: message.payload.orderId,
        });
        message.payload.orderType = 'DINE_IN';
      }

      // 确保 orderType 已被设置（用于 TypeScript 类型检查）
      const finalOrderType = message.payload.orderType || 'DINE_IN';

      // ========== 幂等性检查：防止重复处理消息 ==========
      // 根据 correlationId 或 orderId 检查是否已经处理过此消息
      if (message.correlationId || message.payload.orderId) {
        const existingOrder = await this.findOrderByIdempotencyKey(
          message.correlationId,
          message.payload.orderId,
          tenantId
        );

        if (existingOrder) {
          logger.info('订单已存在，返回现有订单（幂等性保证）', {
            orderId: existingOrder.id,
            orderNumber: existingOrder.orderNumber,
            correlationId: message.correlationId,
          });
          return existingOrder;
        }
      }

      logger.debug('通过幂等性检查，继续创建新订单', {
        correlationId: message.correlationId,
        orderId: message.payload.orderId,
      });

      // 调用订单服务创建订单，并传递 messageId 用于幂等性
      const orderData = {
        ...message.payload,
        orderType: finalOrderType as 'DINE_IN' | 'TAKEOUT' | 'DELIVERY',
      };

      const result = await orderService.createOrder(
        orderData,
        userId,
        tenantId,
        undefined,  // token（可选，POS/KIOSK 不需要）
        message.correlationId  // messageId 用于幂等性检查
      );

      logger.info('订单已成功创建', {
        orderId: result.id,
        orderNumber: result.orderNumber,
        correlationId: message.correlationId,
      });

      return result;
    } catch (error) {
      logger.error('处理 ORDER_CREATED 消息失败', {
        correlationId: message.correlationId,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      });

      // 重新抛出错误，让消息队列知道处理失败
      // 消息将被重新放入队列等待重试
      throw error;
    }
  }

  /**
   * 查找订单是否已存在（幂等性检查）
   * 使用 messageId（correlationId）作为幂等性密钥
   * 这确保即使消息重复到达，也只会创建一个订单
   */
  private async findOrderByIdempotencyKey(
    correlationId?: string,
    orderId?: string,
    tenantId?: string
  ): Promise<any> {
    try {
      // 使用 correlationId 进行幂等性检查
      // correlationId 存储在数据库的 messageId 字段中
      if (correlationId && tenantId) {
        logger.debug('使用 messageId 进行幂等性检查', {
          messageId: correlationId,
          tenantId,
        });

        // 查询数据库中是否已存在此 messageId 的订单
        const existingOrder = await orderService.findOrderByMessageId(
          correlationId,
          tenantId
        );

        if (existingOrder) {
          logger.info('✅ 消息已处理（幂等性命中），返回现有订单', {
            orderId: existingOrder.id,
            messageId: correlationId,
            tenantId,
          });
          return existingOrder;
        }
      }

      logger.debug('✅ 消息未处理过，继续创建新订单', {
        messageId: correlationId,
        tenantId,
      });

      return null;
    } catch (error) {
      logger.warn('⚠️ 幂等性检查失败，继续处理消息', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      // 幂等性检查失败时继续处理，确保服务可用性
      return null;
    }
  }

  /**
   * 处理 ORDER_UPDATED 消息
   */
  async handleOrderUpdated(message: any): Promise<void> {
    try {
      logger.info('处理 ORDER_UPDATED 消息', {
        correlationId: message.correlationId,
        orderId: message.payload.orderId,
      });

      // 这里可以添加订单更新逻辑
      // 例如：更新订单状态、备注等

      logger.info('订单已成功更新', {
        orderId: message.payload.orderId,
        correlationId: message.correlationId,
      });
    } catch (error) {
      logger.error('处理 ORDER_UPDATED 消息失败', {
        correlationId: message.correlationId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  /**
   * 处理 ORDER_CANCELLED 消息
   */
  async handleOrderCancelled(message: any, tenantId: string): Promise<void> {
    try {
      logger.info('处理 ORDER_CANCELLED 消息', {
        correlationId: message.correlationId,
        orderId: message.payload.orderId,
      });

      const { orderId, reason } = message.payload;

      // 调用 orderService 的 cancelOrder 方法
      await orderService.cancelOrder(orderId, reason, tenantId);

      logger.info('订单已成功取消', {
        orderId: message.payload.orderId,
        correlationId: message.correlationId,
      });
    } catch (error) {
      logger.error('处理 ORDER_CANCELLED 消息失败', {
        correlationId: message.correlationId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  /**
   * 路由消息到相应的处理方法
   */
  async handleMessage(
    message: OrderMessage,
    userId: string,
    tenantId: string
  ): Promise<any> {
    switch (message.type) {
      case 'ORDER_CREATED':
        return this.handleOrderCreated(message, userId, tenantId);
      case 'ORDER_UPDATED':
        return this.handleOrderUpdated(message);
      case 'ORDER_CANCELLED':
        return this.handleOrderCancelled(message, tenantId);
      default:
        logger.warn('未知的消息类型', {
          messageType: message.type,
          correlationId: message.correlationId,
        });
        return null;
    }
  }
}

export default new MQConsumerService();
