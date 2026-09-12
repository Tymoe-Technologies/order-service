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
import { tasksForOtherDevices } from '../../websocket/print-task-ownership';

async function triggerPrint(order: any, tenantId: string, clientOrigin: string): Promise<void> {
  logger.info('[PrintHandler] 开始生成打印任务', { orderId: order.id, tenantId, clientOrigin });
  let tasks = await generatePrintTasksForOrder(order, tenantId, clientOrigin);

  /*
    POS 单只生成**下单那台机打不了的**那些。

    它自己负责的仍然由它本地打 —— 那条路不经过服务端，后端挂了照样出票，
    这是不能丢的性质。规则和 POS 那边严格互补，见 print-task-ownership.ts。

    非 POS 来源（Web / Uber / 预约单）不走这个过滤：那时候没有「下单设备」，
    每张票都该按归属定向推。
  */
  if (clientOrigin === 'POS' && tasks.length > 0) {
    const assignments = await prisma.printerAssignment.findMany({ where: { tenantId } });
    const owners = new Map(assignments.map((a) => [a.scope, a.deviceId]));
    const before = tasks.length;
    tasks = tasksForOtherDevices(tasks, owners, order.deviceId);
    logger.info('[PrintHandler] POS 单跨设备转交', {
      orderId: order.id, deviceId: order.deviceId, before, transferred: tasks.length,
    });
  }

  if (tasks.length > 0) {
    await dispatchPrintTasks(tasks, tenantId);
    logger.info('[PrintHandler] 打印任务已分发', { orderId: order.id, taskCount: tasks.length });
  }
}

export function registerPrintHandler(bus: IEventBus): void {
  // POS/KIOSK 创建订单后直接打印（POS 本地打印，不走 WebSocket）
  bus.on('ORDER_CREATED', async function print_ORDER_CREATED(event) {
    const e = event as OrderCreatedEvent;
    /*
      POS 单以前在这里直接 return（「本地打印，不走 WebSocket」），
      结果是备餐站的打印机挂在别的设备上时那几张票根本到不了。
      现在也生成，但只生成下单设备打不了的（见 triggerPrint）。

      **deviceId 为空时保持旧行为**：老版本 POS 不发这个字段，
      服务端分不出是谁开的单，生成任务就会和那台机的本地打印重复。
      所以这次改动对没升级的收银机是无感的 —— 两端可以分开部署。
    */
    if (e.clientOrigin === 'POS' && !e.order?.deviceId) return;
    await triggerPrint(e.order, e.tenantId, e.clientOrigin);
  });

  // 从快照创建订单（Webhook 路径，支付已成功，直接打印）
  bus.on('ORDER_CREATED_FROM_SNAPSHOT', async function print_ORDER_CREATED_FROM_SNAPSHOT(event) {
    const e = event as OrderCreatedFromSnapshotEvent;
    await triggerPrint(e.order, e.tenantId, 'WEB');
  });

  // 支付成功（临时订单 PENDING → CONFIRMED 路径，非预约单）
  bus.on('ORDER_PAID', async function print_ORDER_PAID(event) {
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
