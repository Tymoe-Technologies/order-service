import prisma from '../utils/prisma';
import logger from '../utils/logger';
import { sendOverdueUnconfirmedAlert } from '../services/alert.service';

// 待确认配送订单超时告警：支付成功后 15 分钟内如果还没有人工/自动确认(deliveryConfirmedAt 仍为 null)，
// 说明"接单"这个动作在前端全靠推送触发的旧链路里可能又丢了，先记录+告警，不做任何自动处理。
// C 阶段的自动接单 job 上线后，这里改为兜底双保险（正常情况下 C 阶段应该会先一步处理掉）。

const WATCHDOG_INTERVAL_MS = 60 * 1000; // 每 60 秒检查一次
const OVERDUE_MINUTES = 15;             // 支付成功超过 15 分钟未确认视为超时
const ALERT_COOLDOWN_MS = 30 * 60 * 1000; // 同一订单 30 分钟内只告警一次，防止刷屏

let timer: NodeJS.Timeout | null = null;
let running = false; // 重入锁：上一轮没跑完不开新一轮

// orderId -> 上次告警时间，进程内限流（重启后重置，可接受）
const lastAlertedAt = new Map<string, number>();

/**
 * 超时未确认告警：先记 error 日志（方便日志监控发现问题），再发 Twilio 短信作为
 * "自动接单 job 本身失效"的双保险（正常情况下 C1 应该会先一步处理掉，这里很少触发）
 */
async function notifyOverdueDeliveryConfirmation(order: {
  id: string;
  tenantId: string;
  orderNumber: string | null;
  paidAt: Date | null;
}): Promise<void> {
  const now = Date.now();
  const last = lastAlertedAt.get(order.id);
  if (last && now - last < ALERT_COOLDOWN_MS) return;
  lastAlertedAt.set(order.id, now);

  logger.error('[DeliveryConfirmationWatchdog] 配送订单超时未确认', {
    orderId: order.id,
    tenantId: order.tenantId,
    orderNumber: order.orderNumber,
    paidAt: order.paidAt,
    overdueMinutes: OVERDUE_MINUTES,
  });

  await sendOverdueUnconfirmedAlert({
    orderId: order.id,
    tenantId: order.tenantId,
    orderNumber: order.orderNumber,
  });
}

async function tick(): Promise<void> {
  if (running) {
    logger.warn('[DeliveryConfirmationWatchdog] 上一轮检查仍在执行，跳过本轮');
    return;
  }
  running = true;
  try {
    const deadline = new Date(Date.now() - OVERDUE_MINUTES * 60 * 1000);
    const overdueOrders = await prisma.order.findMany({
      where: {
        orderType: 'DELIVERY',
        /*
          只捞**本店自配送**单。

          漏了这个条件时，Uber Eats 平台单（同样是 DELIVERY、建单即 PAID、
          deliveryConfirmedAt 永远为 null）会全部命中，被当成超时未确认的
          配送订单处理 —— 而那些单本店根本不负责配送，没有「确认备餐时间」
          这一步可做。
        */
        deliveryProvider: 'MERCHANT',
        paymentStatus: 'PAID',
        deliveryConfirmedAt: null,
        cancelledAt: null,
        paidAt: { lte: deadline },
      },
      select: { id: true, tenantId: true, orderNumber: true, paidAt: true },
    });

    if (overdueOrders.length > 0) {
      logger.warn(`[DeliveryConfirmationWatchdog] 发现 ${overdueOrders.length} 个超时未确认的配送订单`);
    }

    for (const order of overdueOrders) {
      await notifyOverdueDeliveryConfirmation(order);
    }

    // 限流 Map 顺手清理已确认/已取消订单的残留 key，避免无限增长
    if (lastAlertedAt.size > 1000) {
      const overdueIds = new Set(overdueOrders.map(o => o.id));
      for (const id of lastAlertedAt.keys()) {
        if (!overdueIds.has(id)) lastAlertedAt.delete(id);
      }
    }
  } catch (err) {
    logger.error('[DeliveryConfirmationWatchdog] 检查超时未确认订单失败', { err });
  } finally {
    running = false;
  }
}

export function startDeliveryConfirmationWatchdog(): void {
  if (timer) return;
  void tick();
  timer = setInterval(() => void tick(), WATCHDOG_INTERVAL_MS);
  logger.info(`[DeliveryConfirmationWatchdog] 定时器已启动，每 ${WATCHDOG_INTERVAL_MS / 1000}s 检查一次，超时阈值 ${OVERDUE_MINUTES} 分钟`);
}

export function stopDeliveryConfirmationWatchdog(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    logger.info('[DeliveryConfirmationWatchdog] 定时器已停止');
  }
}
