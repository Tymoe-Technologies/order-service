/**
 * 打印任务分发器
 * 将打印任务推送到在线的 POS 设备
 */

import WebSocket from 'ws';
import prisma from '../utils/prisma';
import logger from '../utils/logger';
import { deviceRegistry } from './device-registry';
import { sendMessage } from './ws-server';
import type {
  PrintTaskPayloadForClient,
  WSDeliveryOrderMessage,
  WSDeliveryStatusUpdateMessage,
  WSThirdPartyOrderMessage,
  WSOrderStatusChangedMessage,
} from './types';

/**
 * 分发打印任务到在线设备
 * 如果没有在线设备，任务保持 PENDING，等设备重连后通过 FETCH_PENDING 拉取
 */
export async function dispatchPrintTasks(
  tasks: any[],
  tenantId: string,
): Promise<void> {
  if (tasks.length === 0) return;

  // 获取该门店的在线设备
  const devices = deviceRegistry.getDevicesByStore(tenantId);

  if (devices.length === 0) {
    logger.info('[Dispatcher] 无在线设备，任务保持 PENDING 等待拉取', {
      tenantId,
      taskCount: tasks.length,
    });
    return;
  }

  // 向所有在线设备广播打印任务（由客户端去重）
  const sentTaskIds: string[] = [];

  for (const task of tasks) {
    const clientPayload: PrintTaskPayloadForClient = {
      id: task.id,
      orderId: task.orderId,
      ticketType: task.ticketType,
      source: task.source,
      priority: task.priority,
      payload: task.payload,
      createdAt: task.createdAt instanceof Date ? task.createdAt.toISOString() : task.createdAt,
    };

    let sent = false;
    for (const device of devices) {
      if (device.ws.readyState === WebSocket.OPEN) {
        const success = sendMessage(device.ws, {
          type: 'PRINT_TASK',
          task: clientPayload,
          timestamp: new Date().toISOString(),
        });
        if (success) {
          sent = true;
        }
      }
    }

    if (sent) {
      sentTaskIds.push(task.id);
    }
  }

  // 批量更新已发送的任务状态
  if (sentTaskIds.length > 0) {
    await prisma.printTask.updateMany({
      where: { id: { in: sentTaskIds } },
      data: {
        status: 'SENT',
        sentAt: new Date(),
        // 广播模式不绑定特定 deviceId
      },
    });

    logger.info('[Dispatcher] 打印任务已推送', {
      tenantId,
      sentCount: sentTaskIds.length,
      totalTasks: tasks.length,
      deviceCount: devices.length,
    });
  }
}

/**
 * 广播配送订单到在线 POS 设备
 * POS 收到后展示备餐时间选择，员工选择后调用 uber service 创建配送单
 */
export function broadcastDeliveryOrder(
  tenantId: string,
  delivery: WSDeliveryOrderMessage['delivery'],
): void {
  const devices = deviceRegistry.getDevicesByStore(tenantId);

  if (devices.length === 0) {
    logger.warn('[Dispatcher] 无在线设备，配送订单通知丢失', {
      tenantId,
      orderId: delivery.orderId,
    });
    return;
  }

  const msg: WSDeliveryOrderMessage = {
    type: 'DELIVERY_ORDER',
    delivery,
    timestamp: new Date().toISOString(),
  };

  let sentCount = 0;
  for (const device of devices) {
    if (device.ws.readyState === WebSocket.OPEN) {
      if (sendMessage(device.ws, msg)) sentCount++;
    }
  }

  logger.info('[Dispatcher] 配送订单已推送到 POS', {
    tenantId,
    orderId: delivery.orderId,
    sentCount,
    deviceCount: devices.length,
  });
}

/**
 * 广播配送状态变更到在线 POS 设备
 * 由 uber-service webhook 触发，通过内部 API 调用
 */
export function broadcastDeliveryStatusUpdate(
  tenantId: string,
  update: Omit<WSDeliveryStatusUpdateMessage, 'type' | 'timestamp'>,
): void {
  const devices = deviceRegistry.getDevicesByStore(tenantId);

  if (devices.length === 0) {
    logger.debug('[Dispatcher] 无在线设备，配送状态更新跳过', {
      tenantId,
      deliveryId: update.deliveryId,
    });
    return;
  }

  const msg: WSDeliveryStatusUpdateMessage = {
    type: 'DELIVERY_STATUS_UPDATE',
    deliveryId: update.deliveryId,
    status: update.status,
    courier: update.courier,
    dropoff_eta: update.dropoff_eta,
    pickup_eta: update.pickup_eta,
    tracking_url: update.tracking_url,
    timestamp: new Date().toISOString(),
  };

  let sentCount = 0;
  for (const device of devices) {
    if (device.ws.readyState === WebSocket.OPEN) {
      if (sendMessage(device.ws, msg)) sentCount++;
    }
  }

  logger.info('[Dispatcher] 配送状态更新已推送到 POS', {
    tenantId,
    deliveryId: update.deliveryId,
    status: update.status,
    sentCount,
  });
}

/**
 * 广播第三方平台来单（Uber Eats 等）到在线 POS 设备
 * POS 收到后弹窗展示订单，员工选择接单或拒单
 */
export function broadcastThirdPartyOrder(
  tenantId: string,
  order: WSThirdPartyOrderMessage['order'],
): void {
  const devices = deviceRegistry.getDevicesByStore(tenantId);

  if (devices.length === 0) {
    logger.warn('[Dispatcher] 无在线设备，第三方订单通知丢失', {
      tenantId,
      orderId: order.orderId,
      platform: order.platform,
    });
    return;
  }

  const msg: WSThirdPartyOrderMessage = {
    type: 'THIRD_PARTY_ORDER',
    order,
    timestamp: new Date().toISOString(),
  };

  let sentCount = 0;
  for (const device of devices) {
    if (device.ws.readyState === WebSocket.OPEN) {
      if (sendMessage(device.ws, msg)) sentCount++;
    }
  }

  logger.info('[Dispatcher] 第三方订单已推送到 POS', {
    tenantId,
    orderId: order.orderId,
    platform: order.platform,
    externalDisplayId: order.externalDisplayId,
    sentCount,
    deviceCount: devices.length,
  });
}

/**
 * 广播订单状态变更到在线 POS 设备（多设备同步）
 * 任何订单状态变化都通过此函数广播，POS 收到后刷新对应订单
 */
export function broadcastOrderStatusChanged(
  tenantId: string,
  update: Omit<WSOrderStatusChangedMessage, 'type' | 'timestamp'>,
): void {
  const devices = deviceRegistry.getDevicesByStore(tenantId);

  if (devices.length === 0) return;

  const msg: WSOrderStatusChangedMessage = {
    type: 'ORDER_STATUS_CHANGED',
    orderId: update.orderId,
    orderNumber: update.orderNumber,
    externalOrderId: update.externalOrderId,
    platform: update.platform,
    status: update.status,
    previousStatus: update.previousStatus,
    tenantId: update.tenantId,
    timestamp: new Date().toISOString(),
  };

  let sentCount = 0;
  for (const device of devices) {
    if (device.ws.readyState === WebSocket.OPEN) {
      if (sendMessage(device.ws, msg)) sentCount++;
    }
  }

  logger.info('[Dispatcher] 订单状态变更已广播', {
    tenantId,
    orderId: update.orderId,
    status: update.status,
    previousStatus: update.previousStatus,
    sentCount,
  });
}
