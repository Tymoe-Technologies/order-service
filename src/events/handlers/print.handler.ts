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

/**
 * 建单时该不该由服务端触发打印。
 *
 * POS 不该：它建的是 **PENDING 单** —— 收银员点开礼品卡/组合支付时就先建好
 * 拿 orderId，钱一分还没收。挂在这个事件上等于「进结算页就出票」，
 * 顾客临时改主意或者换支付方式，票已经打出来了。
 * （这正是跨设备转交那次改动带进来的回归：原来 POS 在这里直接 return。）
 *
 * Web / Uber 走这里是对的：它们到达 order-service 时钱已经收过了。
 */
export function shouldPrintOnCreate(clientOrigin: string): boolean {
  return clientOrigin !== 'POS';
}

/**
 * 支付成功时该不该由服务端触发打印。
 *
 * previousStatus 必须是 PENDING：updatePaymentStatus 被重复调用时
 * （补记一笔、对账修正）第二次的 previousStatus 已经不是 PENDING 了，
 * 靠它防重复出票。
 *
 * POS 单要求带 deviceId：老版本 POS 不发这个字段，服务端分不出是谁开的单，
 * 生成任务会和那台机的本地打印**重复**。所以两端可以分开部署。
 */
export function shouldPrintOnPaid(e: {
  clientOrigin: string;
  previousStatus: string;
  deviceId?: string | null;
}): boolean {
  if (e.previousStatus !== 'PENDING') return false;
  if (e.clientOrigin === 'WEB') return true;
  return e.clientOrigin === 'POS' && !!e.deviceId;
}

export function registerPrintHandler(bus: IEventBus): void {
  // Web/Uber 建单即打印：它们到这儿时钱已经收过了。POS 等付款，见上面
  bus.on('ORDER_CREATED', async function print_ORDER_CREATED(event) {
    const e = event as OrderCreatedEvent;
    if (!shouldPrintOnCreate(e.clientOrigin)) return;
    await triggerPrint(e.order, e.tenantId, e.clientOrigin);
  });

  // 从快照创建订单（Webhook 路径，支付已成功，直接打印）
  bus.on('ORDER_CREATED_FROM_SNAPSHOT', async function print_ORDER_CREATED_FROM_SNAPSHOT(event) {
    const e = event as OrderCreatedFromSnapshotEvent;
    await triggerPrint(e.order, e.tenantId, 'WEB');
  });

  /*
    支付成功（PENDING → CONFIRMED，非预约单）。POS 单也在这里出票 ——
    它建单时那张还是没付钱的 PENDING。
    预约单 previousStatus === 'SCHEDULED'，到时间才打印，不在此处理。
  */
  bus.on('ORDER_PAID', async function print_ORDER_PAID(event) {
    const e = event as OrderPaidEvent;

    // deviceId 只在订单上，事件里没有，所以要先查
    const fullOrder = await prisma.order.findUnique({
      where: { id: e.orderId },
      include: { orderItems: { include: { orderItemModifiers: true } } },
    });
    if (!fullOrder) return;

    if (!shouldPrintOnPaid({
      clientOrigin: e.clientOrigin,
      previousStatus: e.previousStatus,
      deviceId: (fullOrder as any).deviceId,
    })) return;

    await triggerPrint(fullOrder, e.tenantId, e.clientOrigin);
  });
}
