/**
 * 叫号屏事件处理器
 * 监听订单创建/状态变更事件，广播给叫号屏
 */

import type { IEventBus } from '../event-bus';
import { broadcastOrderUpdate } from '../../websocket/queue-display-server';
import prisma from '../../utils/prisma';
import logger from '../../utils/logger';

export function registerQueueDisplayHandler(bus: IEventBus): void {
  // 订单创建（POS 下单通常直接 CONFIRMED/PREPARING）
  bus.on('ORDER_CREATED', async (event) => {
    await broadcastFullOrder(event.tenantId, event.orderId);
  });

  // 从快照创建订单（WEB/KIOSK 支付后）
  bus.on('ORDER_CREATED_FROM_SNAPSHOT', async (event) => {
    await broadcastFullOrder(event.tenantId, event.orderId);
  });

  // 订单支付成功（可能触发状态变更到 CONFIRMED）
  bus.on('ORDER_PAID', async (event) => {
    await broadcastFullOrder(event.tenantId, event.orderId);
  });

  // 订单完成
  bus.on('ORDER_COMPLETED', async (event) => {
    await broadcastFullOrder(event.tenantId, event.orderId);
  });

  logger.info('[EventBus] 叫号屏 handler 已注册');
}

async function broadcastFullOrder(tenantId: string, orderId: string): Promise<void> {
  try {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        orderNumber: true,
        pickupNumber: true,
        status: true,
        tenantId: true,
        orderType: true,
        orderSource: true,
        customerName: true,
        customerPhone: true,
        memberId: true,
        createdAt: true,
      },
    });
    if (order) {
      broadcastOrderUpdate(order.tenantId, order);
    }
  } catch (err: any) {
    logger.error('[QueueDisplay] 广播订单失败', { orderId, error: err.message });
  }
}
