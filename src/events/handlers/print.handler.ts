/**
 * 打印任务 Handler
 * 订单支付成功后，生成打印任务并推送到 POS
 *
 * 幂等性：检查 order 是否已有关联的打印任务（通过日志标记）
 */

import type { IEventBus } from '../event-bus';
import type { OrderCreatedEvent, OrderCreatedFromSnapshotEvent, OrderPaidEvent } from '../types';
import prisma from '../../utils/prisma';
import logger from '../../utils/logger';
import { generatePrintTasksForOrder } from '../../websocket/print-task-generator';
import { dispatchPrintTasks } from '../../websocket/print-task-dispatcher';

async function triggerPrint(order: any, tenantId: string, clientOrigin: string): Promise<void> {
  logger.info('[PrintHandler] 开始生成打印任务', { orderId: order.id, tenantId, clientOrigin });
  const tasks = await generatePrintTasksForOrder(order, tenantId, clientOrigin);
  if (tasks.length > 0) {
    await dispatchPrintTasks(tasks, tenantId);
    logger.info('[PrintHandler] 打印任务已分发', { orderId: order.id, taskCount: tasks.length });
  }
}

export function registerPrintHandler(bus: IEventBus): void {
  // POS/KIOSK 创建订单后直接打印（POS 本地打印，不走 WebSocket）
  bus.on('ORDER_CREATED', async (event) => {
    const e = event as OrderCreatedEvent;
    if (e.clientOrigin === 'POS') return; // POS 本地打印，不走 WebSocket
    await triggerPrint(e.order, e.tenantId, e.clientOrigin);
  });

  // 从快照创建订单（Webhook 路径，支付已成功，直接打印）
  bus.on('ORDER_CREATED_FROM_SNAPSHOT', async (event) => {
    const e = event as OrderCreatedFromSnapshotEvent;
    await triggerPrint(e.order, e.tenantId, 'WEB');
  });

  // 支付成功（临时订单 PENDING → CONFIRMED 路径，非预约单）
  bus.on('ORDER_PAID', async (event) => {
    const e = event as OrderPaidEvent;
    // 仅 WEB 普通订单从 PENDING 变为 CONFIRMED/COMPLETED 时触发打印
    // 预约单 previousStatus === 'SCHEDULED'，到时间才打印，不在此处理
    if (e.clientOrigin !== 'WEB' || e.previousStatus !== 'PENDING') return;

    const fullOrder = await prisma.order.findUnique({
      where: { id: e.orderId },
      include: { orderItems: { include: { orderItemModifiers: true } } },
    });
    if (!fullOrder) return;

    await triggerPrint(fullOrder, e.tenantId, 'WEB');
  });
}
