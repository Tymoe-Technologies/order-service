import orderService from '../services/order.service';
import logger from '../utils/logger';

// 预约单释放定时器：到点(预约时间前 leadMinutes 分钟)将 SCHEDULED 单
// 自动确认(CONFIRMED)、生成打印任务并广播给 POS。
// 取代原 DB pg_cron(那条裸 SQL 只置 PENDING、不打印也不广播)。

const RELEASE_INTERVAL_MS = 60 * 1000; // 每 60 秒检查一次
const LEAD_MINUTES = 30;               // 提前 30 分钟释放(与原 cron 保持一致)

let timer: NodeJS.Timeout | null = null;
let running = false; // 重入锁：上一轮没跑完不开新一轮

async function tick(): Promise<void> {
  if (running) {
    logger.warn('[ScheduledOrderRelease] 上一轮释放仍在执行，跳过本轮');
    return;
  }
  running = true;
  try {
    const released = await orderService.releaseScheduledOrders(LEAD_MINUTES);
    if (released > 0) {
      logger.info(`[ScheduledOrderRelease] 本轮释放 ${released} 个预约单`);
    }

    // 取餐时间过后 10 分钟自动完成（预约单）
    const completed = await orderService.autoCompleteOverdueScheduled(10);
    if (completed > 0) {
      logger.info(`[ScheduledOrderRelease] 本轮自动完成 ${completed} 个超时预约单`);
    }

    // 待取餐(READY)超过 5 分钟自动完成（叫号取餐单）
    const readyCompleted = await orderService.autoCompleteOverdueReady(5);
    if (readyCompleted > 0) {
      logger.info(`[ScheduledOrderRelease] 本轮自动完成 ${readyCompleted} 个超时待取餐单`);
    }
  } catch (err) {
    logger.error('[ScheduledOrderRelease] 释放/自动完成预约单失败', { err });
  } finally {
    running = false;
  }
}

export function startScheduledOrderRelease(): void {
  if (timer) return;
  // 启动时先跑一次，避免等满一个周期
  void tick();
  timer = setInterval(() => void tick(), RELEASE_INTERVAL_MS);
  logger.info(`[ScheduledOrderRelease] 定时器已启动，每 ${RELEASE_INTERVAL_MS / 1000}s 释放一次，提前 ${LEAD_MINUTES} 分钟`);
}

export function stopScheduledOrderRelease(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    logger.info('[ScheduledOrderRelease] 定时器已停止');
  }
}
