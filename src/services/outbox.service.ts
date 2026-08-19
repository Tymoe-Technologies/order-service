/**
 * 事件待发板（transactional outbox）。
 *
 * ## 补的是哪道缝
 * `eventBus.emit` 是进程内 fire-and-forget，而且发生在业务写入**提交之后**。
 * 进程在这中间挂掉 —— 订单在库里、通知没人收到，之后再也不会重试。
 * 你没法把「改数据库」和「发通知」合成一件事：它们是两个系统。
 *
 * 通知板的办法：把「要通知的事」当成一条数据，**和业务数据写在同一个事务里**。
 * 两者要么都成、要么都不成，没有中间态。再由 relay 一条条投递，投到了才标记。
 *
 * ## 一个事件一个 handler 一行
 * 不是「一行装一个事件、投递时跑所有 handler」—— 那样一个 handler 失败会把整批
 * 重跑，已经成功的（比如给会员加积分）会**再执行一遍**。拆到 handler 粒度，
 * 重试只重试失败的那个。
 *
 * ## 语义是 at-least-once，不是 exactly-once
 * 投递成功之后、标记之前挂掉，这一条会再投一次 —— 分布式系统里这是不可避免的，
 * 硬做 exactly-once 的代价远大于收益。**所以 handler 必须自己幂等**。
 * 拆到 handler 粒度已经把最常见的那种重复（一个失败拖累一批）消掉了，
 * 剩下的窗口只有"投完就挂"这一瞬。
 */

import type { Prisma } from '.prisma/client-order';
import prisma from '../utils/prisma';
import logger from '../utils/logger';
import { eventBus } from '../events';
import type { OrderEvent } from '../events/types';

/** 一批最多认领多少条。小一点，让多实例能分摊 */
const BATCH = 20;
/** 认领后先把下次重试推到多久之后 —— 这段时间就是本次投递的"租约" */
const LEASE_SECONDS = 300;
/** 退避上限。超过这个就固定间隔重试，别退到几小时后 */
const MAX_BACKOFF_SECONDS = 600;

/** 能写库的东西：普通 client 或事务 client 都行 */
type Db = Prisma.TransactionClient | typeof prisma;

/**
 * 把一个事件放进待发板。
 *
 * ⚠️ **必须传事务里的那个 client**（`prisma.$transaction(async tx => ...)` 的 tx）。
 * 传普通 client 的话就退化成「先写业务、再写板」两个独立操作 —— 中间挂掉照样丢，
 * 整个机制的意义就没了。
 */
export async function enqueueEvent(db: Db, event: OrderEvent): Promise<number> {
  const handlers = eventBus.handlerNamesFor(event.type);
  if (handlers.length === 0) return 0;

  const payload = JSON.stringify(event);
  await db.outboxEvent.createMany({
    data: handlers.map((handler) => ({
      tenantId: event.tenantId,
      eventType: event.type,
      handler,
      aggregateId: (event as any).orderId ?? null,
      payload,
    })),
  });
  return handlers.length;
}

/** 退避：2^n 秒，封顶。attempts 是认领时已经 +1 过的 */
const backoffSeconds = (attempts: number) =>
  Math.min(2 ** Math.min(attempts, 12), MAX_BACKOFF_SECONDS);

interface ClaimedRow {
  id: string;
  handler: string;
  payload: string;
  attempts: number;
  event_type: string;
}

/**
 * 跑一轮投递。
 *
 * 认领用 `FOR UPDATE SKIP LOCKED` + 一次性把 next_attempt_at 推到未来：
 * 多个实例同时跑也不会认领到同一条，而且**认领即占用**——
 * 本次没跑完（进程挂了）的，等租约到期自然会被下一轮捞起来重试。
 *
 * @returns 这一轮投出去几条、失败几条
 */
export async function drainOutbox(): Promise<{ ok: number; failed: number }> {
  const claimed = await prisma.$queryRaw<ClaimedRow[]>`
    UPDATE outbox_events
       SET attempts        = attempts + 1,
           next_attempt_at = NOW() + (${LEASE_SECONDS} || ' seconds')::interval
     WHERE id IN (
       SELECT id FROM outbox_events
        WHERE published_at IS NULL
          AND next_attempt_at <= NOW()
        ORDER BY created_at
        LIMIT ${BATCH}
        FOR UPDATE SKIP LOCKED
     )
    RETURNING id, handler, payload, attempts, event_type
  `;
  if (claimed.length === 0) return { ok: 0, failed: 0 };

  let ok = 0;
  let failed = 0;

  for (const row of claimed) {
    try {
      const event = reviveEvent(row.payload);
      await eventBus.runHandler(row.handler, event);
      await prisma.outboxEvent.update({
        where: { id: row.id },
        data: { publishedAt: new Date(), lastError: null },
      });
      ok += 1;
    } catch (e) {
      failed += 1;
      const wait = backoffSeconds(row.attempts);
      await prisma.outboxEvent.update({
        where: { id: row.id },
        data: {
          nextAttemptAt: new Date(Date.now() + wait * 1000),
          lastError: String((e as Error)?.message ?? e).slice(0, 1000),
        },
      }).catch(() => {});
      logger.error('[Outbox] 投递失败，稍后重试', {
        id: row.id, handler: row.handler, eventType: row.event_type,
        attempts: row.attempts, 等待秒: wait,
        error: (e as Error)?.message,
      });
    }
  }

  if (ok > 0) logger.info('[Outbox] 投递完成', { ok, failed });
  return { ok, failed };
}

/** 严格的 ISO-8601 时间串（JSON.stringify 对 Date 的输出格式） */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

/**
 * 从 JSON 还原事件，**把所有 ISO 时间串变回 Date**。
 *
 * 不能只还原顶层的 `timestamp`：事件里常常整个带着一行订单
 * （`order.createdAt` / `scheduledAt` / `paidAt`…），handler 会把它们当 Date 用。
 * 实测漏还原的表现是 `Invalid time value` —— 而且**只在走通知板这条路时才炸**，
 * 进程内直发那条路一直是真 Date 对象，看不出来。逐个字段列白名单迟早会漏，
 * 所以按格式统一还原。
 *
 * 误伤的代价可以接受：一个「整串正好是 ISO 时间格式」的普通字符串会被变成 Date，
 * 但它再序列化出去还是同一串字符。
 */
function reviveEvent(payload: string): OrderEvent {
  return JSON.parse(payload, (_k, v) =>
    (typeof v === 'string' && ISO_DATE.test(v) ? new Date(v) : v)) as OrderEvent;
}

let timer: NodeJS.Timeout | null = null;

/**
 * 启动 relay。
 *
 * 间隔要短：**厨房打印在这条路上**，出单慢一拍店员就会抱怨。
 * 500ms 的空转成本是一条走索引的查询，可以忽略；等量真的上来了再换成
 * LISTEN/NOTIFY 或独立进程。
 */
export function startOutboxRelay(intervalMs = 500): void {
  if (timer) return;
  const tick = () => {
    drainOutbox().catch((e) => logger.error('[Outbox] relay 本轮异常', { e }));
  };
  tick();
  timer = setInterval(tick, intervalMs);
  logger.info('[Outbox] relay 已启动', { intervalMs });
}

export function stopOutboxRelay(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
