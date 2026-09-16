/**
 * 打印任务分发器
 * 将打印任务推送到在线的 POS 设备
 */

import WebSocket from 'ws';
import prisma from '../utils/prisma';
import logger from '../utils/logger';
import { deviceRegistry } from './device-registry';
import { candidateScopes, ROLE_ONLINE_ORDER_RECEIVER } from '../services/print-routing';
import { sendMessage } from './ws-server';
import { taskToClientPayload } from './print-task-payload';
import type {
  WSDeliveryOrderMessage,
  WSDeliveryStatusUpdateMessage,
  WSThirdPartyOrderMessage,
  WSOrderStatusChangedMessage,
} from './types';

/**
 * 分发打印任务到在线设备。
 *
 * **定向推送**：任务按 PrinterAssignment 找到负责的设备，只推给它。
 * 原来是「向全店在线设备广播 + 客户端各自去重」，而去重键在各自的 localStorage 里、
 * 互相不知道 —— 多台 POS 在线时同一张单会被打多份。
 *
 * 没配归属的任务退回广播（升级期间必须保留：归属记录要等 POS 设置界面
 * 上报才有，那之前一条都没有，切断广播等于全店停印）。
 *
 * 没有可推的设备时任务保持 PENDING，等设备重连后通过 FETCH_PENDING 拉取。
 */
export async function dispatchPrintTasks(
  tasks: any[],
  tenantId: string,
): Promise<void> {
  if (tasks.length === 0) return;

  const assignments = await prisma.printerAssignment.findMany({ where: { tenantId } });
  const byScope = new Map(assignments.map((a) => [a.scope, a]));

  // taskId -> 推给了哪台设备（null = 广播，不绑定设备）
  const sent = new Map<string, string | null>();
  const stranded: Array<{ taskId: string; scope: string; deviceId: string }> = [];
  let broadcastCount = 0;

  for (const task of tasks) {
    const msg = {
      type: 'PRINT_TASK' as const,
      task: taskToClientPayload(task),
      timestamp: new Date().toISOString(),
    };

    const scopes = candidateScopes(task);
    const assignment = scopes.map((s) => byScope.get(s)).find((a) => !!a);
    const scope = scopes[0];

    if (!assignment) {
      // 未登记归属：退回广播
      const devices = deviceRegistry.getDevicesByStore(tenantId);
      let ok = false;
      for (const device of devices) {
        if (device.ws.readyState === WebSocket.OPEN && sendMessage(device.ws, msg)) ok = true;
      }
      if (ok) {
        sent.set(task.id, null);
        broadcastCount++;
      }
      continue;
    }

    // 主责 → fallback，都不在线就留 PENDING 并告警
    const target = [assignment.deviceId, assignment.fallbackDeviceId]
      .filter((d): d is string => !!d)
      .map((d) => deviceRegistry.getDevice(d))
      .find((d) => d && d.ws.readyState === WebSocket.OPEN);

    if (!target) {
      stranded.push({ taskId: task.id, scope, deviceId: assignment.deviceId });
      continue;
    }
    if (sendMessage(target.ws, msg)) sent.set(task.id, target.deviceId);
    else stranded.push({ taskId: task.id, scope, deviceId: assignment.deviceId });
  }

  // 按目标设备分组更新，broadcast 的那批 deviceId 留空
  const groups = new Map<string | null, string[]>();
  for (const [taskId, deviceId] of sent) {
    const bucket = groups.get(deviceId);
    if (bucket) bucket.push(taskId);
    else groups.set(deviceId, [taskId]);
  }
  for (const [deviceId, taskIds] of groups) {
    await prisma.printTask.updateMany({
      where: { id: { in: taskIds } },
      data: { status: 'SENT', sentAt: new Date(), ...(deviceId ? { deviceId } : {}) },
    });
  }

  if (stranded.length > 0) {
    // 收银员看得见的告警靠状态面板（Phase C）读 PENDING 任务，这里先留日志
    logger.warn('[Dispatcher] 负责设备离线，任务留 PENDING', { tenantId, stranded });
  }

  logger.info('[Dispatcher] 打印任务已推送', {
    tenantId,
    totalTasks: tasks.length,
    targetedCount: sent.size - broadcastCount,
    broadcastCount,
    strandedCount: stranded.length,
  });
}

/**
 * 推给**接单设备**：需要人工处理的来单只该弹在一台机上。
 *
 * 广播的后果不是「多打一张纸」而是**竞态**：三台 POS 同时弹出「Uber Eats
 * 新订单 · 接单/拒单」，两个人各点一下，谁赢看网络。选备餐时间同理。
 *
 * 没有任何设备认领接单角色时退回广播 —— 对餐厅来说「单子没人看见」
 * 是丢单，比弹三次严重得多。但这属于配置缺失，要 warn 出来。
 *
 * @returns 实际推送成功的设备数
 */
async function sendToOnlineOrderReceiver(
  tenantId: string,
  msg: WSDeliveryOrderMessage | WSThirdPartyOrderMessage,
  ctx: Record<string, unknown>,
): Promise<{ sentCount: number; targeted: boolean }> {
  const assignment = await prisma.printerAssignment.findUnique({
    where: { tenantId_scope: { tenantId, scope: ROLE_ONLINE_ORDER_RECEIVER } },
  });

  if (assignment) {
    // 主责 → fallback，和打印任务用同一套顺序
    const target = [assignment.deviceId, assignment.fallbackDeviceId]
      .filter((d): d is string => !!d)
      .map((d) => deviceRegistry.getDevice(d))
      .find((d) => d && d.ws.readyState === WebSocket.OPEN);

    if (target) {
      const ok = sendMessage(target.ws, msg);
      return { sentCount: ok ? 1 : 0, targeted: true };
    }
    logger.warn('[Dispatcher] 接单设备不在线，退回广播', {
      ...ctx, tenantId, receiverDeviceId: assignment.deviceId,
    });
  } else {
    logger.warn('[Dispatcher] 未指定接单设备，退回广播', { ...ctx, tenantId });
  }

  let sentCount = 0;
  for (const device of deviceRegistry.getDevicesByStore(tenantId)) {
    if (device.ws.readyState === WebSocket.OPEN && sendMessage(device.ws, msg)) sentCount++;
  }
  return { sentCount, targeted: false };
}

/**
 * 配送订单 → 接单设备。
 * POS 收到后展示备餐时间选择，员工选择后调用 uber service 创建配送单
 */
export async function broadcastDeliveryOrder(
  tenantId: string,
  delivery: WSDeliveryOrderMessage['delivery'],
): Promise<void> {
  if (deviceRegistry.getDevicesByStore(tenantId).length === 0) {
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

  const { sentCount, targeted } = await sendToOnlineOrderReceiver(
    tenantId, msg, { orderId: delivery.orderId },
  );

  logger.info('[Dispatcher] 配送订单已推送到 POS', {
    tenantId,
    orderId: delivery.orderId,
    sentCount,
    targeted,
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
    orderId: update.orderId,
    status: update.status,
    courier: update.courier,
    dropoff_eta: update.dropoff_eta,
    pickup_eta: update.pickup_eta,
    tracking_url: update.tracking_url,
    cancelation_reason: update.cancelation_reason,
    undeliverable_reason: update.undeliverable_reason,
    undeliverable_action: update.undeliverable_action,
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
 * 第三方平台来单（Uber Eats 等）→ 接单设备。
 * POS 收到后弹窗展示订单，员工选择接单或拒单
 */
export async function broadcastThirdPartyOrder(
  tenantId: string,
  order: WSThirdPartyOrderMessage['order'],
): Promise<void> {
  if (deviceRegistry.getDevicesByStore(tenantId).length === 0) {
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

  const { sentCount, targeted } = await sendToOnlineOrderReceiver(
    tenantId, msg, { orderId: order.orderId, platform: order.platform },
  );

  logger.info('[Dispatcher] 第三方订单已推送到 POS', {
    tenantId,
    orderId: order.orderId,
    platform: order.platform,
    externalDisplayId: order.externalDisplayId,
    sentCount,
    targeted,
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
