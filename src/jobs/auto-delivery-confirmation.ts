import prisma from '../utils/prisma';
import logger from '../utils/logger';
import orderService from '../services/order.service';
import { confirmDeliveryOrder } from '../services/delivery-confirmation.service';
import { refundOrder } from '../services/refund.service';
import { sendAutoConfirmFailedAlert } from '../services/alert.service';
import { AppError } from '../middleware/errorHandler';

// 15 分钟自动接单：支付成功后如果 15 分钟内没有人工确认，系统自动用默认备餐时间建配送单；
// 建单失败则自动取消订单 + 退款 + Twilio 告警。取代"完全依赖员工点击弹窗"的旧链路，
// 与 B1 共用 delivery-confirmation.service.ts，写入同一批状态字段（deliveryConfirmedBy='AUTO'）

const TICK_INTERVAL_MS = 60 * 1000; // 每 60 秒检查一次
const DEFAULT_PREP_MINUTES = Number(process.env.AUTO_CONFIRM_DEFAULT_PREP_MINUTES) || 20;
// 认领互斥窗口：tick 周期与建单耗时可能重叠，超过这个时长还没写回确认字段的认领视为失效，允许下一轮重新认领
const CLAIM_STALE_MS = 2 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;
let running = false; // 重入锁：上一轮没跑完不开新一轮

async function processOverdueOrder(order: { id: string; tenantId: string; orderNumber: string | null }): Promise<void> {
  try {
    const result = await confirmDeliveryOrder(order.id, order.tenantId, DEFAULT_PREP_MINUTES, 'AUTO');
    if (result.success) {
      logger.info('[AutoDeliveryConfirmation] 自动接单成功', { orderId: order.id, orderNumber: order.orderNumber });
      return;
    }

    logger.error('[AutoDeliveryConfirmation] 自动接单建单失败，转入取消退款流程', {
      orderId: order.id,
      orderNumber: order.orderNumber,
      errorCode: result.errorCode,
      error: result.error,
    });

    await orderService.cancelOrder(order.id, 'SYSTEM_CANCEL', order.tenantId);
    const refundResult = await refundOrder({
      orderId: order.id,
      tenantId: order.tenantId,
      reason: `自动接单建配送单失败：${result.errorCode || result.error || '未知错误'}`,
    });

    await sendAutoConfirmFailedAlert({
      orderId: order.id,
      tenantId: order.tenantId,
      orderNumber: order.orderNumber,
      refundOk: refundResult.ok,
    });
  } catch (err: any) {
    // 竞态：认领之后、真正建单之前，员工手动确认/取消抢先了一步 —— 这不是失败，是正常的并发让步，
    // 绝不能按"建单失败"处理，否则会把一笔刚刚人工合法确认的订单错误地取消退款
    if (err instanceof AppError && (err.code === 'ALREADY_CONFIRMED' || err.code === 'ALREADY_CANCELLED')) {
      logger.info('[AutoDeliveryConfirmation] 订单已被其他路径处理，跳过', { orderId: order.id, code: err.code });
      return;
    }
    // 其余单个订单处理异常不能影响本轮其他订单，也要告警——这种未预期异常同样可能意味着顾客钱卡在了半途
    logger.error('[AutoDeliveryConfirmation] 处理超时订单异常', { orderId: order.id, error: err.message });
    await sendAutoConfirmFailedAlert({
      orderId: order.id,
      tenantId: order.tenantId,
      orderNumber: order.orderNumber,
      refundOk: false,
    }).catch(() => {});
  }
}

async function tick(): Promise<void> {
  if (running) {
    logger.warn('[AutoDeliveryConfirmation] 上一轮处理仍在执行，跳过本轮');
    return;
  }
  running = true;
  try {
    const now = new Date();
    const staleClaimBefore = new Date(now.getTime() - CLAIM_STALE_MS);

    const candidates = await prisma.order.findMany({
      where: {
        orderType: 'DELIVERY',
        paymentStatus: 'PAID',
        deliveryConfirmedAt: null,
        cancelledAt: null,
        deliveryConfirmDeadlineAt: { lte: now },
        OR: [
          { autoConfirmProcessingAt: null },
          { autoConfirmProcessingAt: { lt: staleClaimBefore } },
        ],
      },
      select: { id: true, tenantId: true, orderNumber: true },
    });

    if (candidates.length === 0) return;
    logger.info(`[AutoDeliveryConfirmation] 发现 ${candidates.length} 个超时未确认订单，尝试自动接单`);

    for (const order of candidates) {
      // 认领互斥：只有真正抢到认领（deliveryConfirmedAt 仍为 null 且认领字段满足条件）的这一次才处理，
      // 防止 tick 周期与建单耗时重叠导致同一订单被并发处理两次
      const claimed = await prisma.order.updateMany({
        where: {
          id: order.id,
          deliveryConfirmedAt: null,
          OR: [
            { autoConfirmProcessingAt: null },
            { autoConfirmProcessingAt: { lt: staleClaimBefore } },
          ],
        },
        data: { autoConfirmProcessingAt: now },
      });
      if (claimed.count === 0) continue;

      await processOverdueOrder(order);
    }
  } catch (err) {
    logger.error('[AutoDeliveryConfirmation] 检查超时订单失败', { err });
  } finally {
    running = false;
  }
}

export function startAutoDeliveryConfirmation(): void {
  if (timer) return;
  void tick();
  timer = setInterval(() => void tick(), TICK_INTERVAL_MS);
  logger.info(`[AutoDeliveryConfirmation] 定时器已启动，每 ${TICK_INTERVAL_MS / 1000}s 检查一次`);
}

export function stopAutoDeliveryConfirmation(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    logger.info('[AutoDeliveryConfirmation] 定时器已停止');
  }
}
