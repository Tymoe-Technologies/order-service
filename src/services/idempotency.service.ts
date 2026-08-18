/**
 * 幂等键存储。
 *
 * ## 替掉了什么
 * 原来 createOrder 靠**比对订单当前明细**判断「这是重发还是 id 撞车」。
 * 那套只在「订单建好就不会变」时成立 —— 一旦支持加菜/撤菜，一次正常的补传
 * 会因为明细对不上被判成撞车，客户端换个 id 重发，同一桌变成两张单，
 * 而且是已经收过钱的单。
 *
 * ## 现在的做法（Stripe 的语义）
 * 记下「这个 key 处理过、当时回了什么」，重发直接回放**原始响应**。
 * 判重从此和订单当前长什么样彻底无关。
 *
 * 回放原始响应而不是重新序列化当前订单，是有区别的：订单后来被改过的话，
 * 重新序列化出来的和第一次给调用方的不是同一个东西 —— 而幂等的定义正是
 * 「调用方拿到的响应和第一次成功时完全一样，它不需要知道自己在重放」。
 *
 * ## 为什么是通用表，不是往 orders 上加个指纹字段
 * 以后 addItems / voidItem / 改数量 这些可重试的写操作都需要幂等。
 * 一张表一次解决，比每个操作各想一遍强。
 */

import { createHash } from 'crypto';
import prisma from '../utils/prisma';
import logger from '../utils/logger';
import { AppError } from '../middleware/errorHandler';

/** 存多久。过期只是清理，不是正确性依赖 —— 见 runWithIdempotency 末尾的说明 */
const TTL_HOURS = 24;

export type IdempotencyOutcome<T> =
  | { replayed: false; result: T }
  | { replayed: true; result: T };

/**
 * 把请求体压成一个指纹。
 *
 * ⚠️ **不能对整个请求体做 hash**。POS 补传时会带 `clientCreatedAt` 这类
 * 每次都可能不同的字段，全量 hash 会让每一次正常重发都变成「指纹不符」→ 拒绝。
 * 只取**影响结果**的字段，且顺序无关（数组先排序）。
 */
export const fingerprintOf = (parts: unknown): string =>
  createHash('sha256').update(JSON.stringify(parts)).digest('hex');

/**
 * 在幂等保护下跑一段业务。
 *
 * @param key         客户端提供的幂等键（建单用 orders.id）
 * @param endpoint    区分不同操作，同一个 key 在不同操作上互不干扰
 * @param fingerprint 见 fingerprintOf
 * @param run         真正的业务。只有第一次会执行
 * @param onMissingRecord 键记录不存在、但业务层发现资源已存在时的兜底
 *                        （TTL 过期后的重发会走到这里）
 */
export async function runWithIdempotency<T>(
  tenantId: string,
  endpoint: string,
  key: string,
  fingerprint: string,
  run: () => Promise<T>,
): Promise<IdempotencyOutcome<T>> {
  const expiresAt = new Date(Date.now() + TTL_HOURS * 3600 * 1000);

  // ── 抢占：插入成功 = 我是第一个，由我执行业务 ──
  try {
    await prisma.idempotencyKey.create({
      data: { tenantId, endpoint, key, fingerprint, status: 'IN_PROGRESS', expiresAt },
    });
  } catch (e: any) {
    if (e?.code !== 'P2002') throw e;
    return { replayed: true, result: await replay<T>(tenantId, endpoint, key, fingerprint) };
  }

  // ── 我抢到了，执行业务 ──
  try {
    const result = await run();
    /*
      ★ 首次也过一遍 JSON，和回放走同一条路。

      存下来再读出来，Date 会变成字符串。首次直接返回原对象的话，
      「第一次拿到 Date、重发拿到字符串」—— 调用方就能分辨自己是不是在重放了，
      而幂等的定义恰恰是**分辨不出来**。存的是 TEXT 不是 jsonb，
      所以连键顺序都一样（jsonb 会重排键，那样回放出来就不是同一串字符了）。
      现有三个调用方（controller ×2、MQ consumer）都只是把结果丢去序列化
      或读 id/orderNumber，没人用 Date 方法，所以统一成序列化形态是安全的。
    */
    const body = JSON.stringify(result);
    await prisma.idempotencyKey.update({
      where: { tenantId_endpoint_key: { tenantId, endpoint, key } },
      data: { status: 'SUCCEEDED', responseBody: body },
    });
    return { replayed: false, result: JSON.parse(body) as T };
  } catch (err) {
    /*
      业务失败：把占位删掉，让下次重试能重新抢占。
      留着的话这个 key 就永远卡在 IN_PROGRESS —— 而它很可能只是网络抖了一下，
      重试本该成功。删不掉也不致命（TTL 会兜底），所以失败只记日志。
    */
    await prisma.idempotencyKey.delete({
      where: { tenantId_endpoint_key: { tenantId, endpoint, key } },
    }).catch((e) => logger.error('[Idempotency] 清理占位失败，该 key 会卡到过期', { key, e }));
    throw err;
  }
}

/** 已有记录时怎么答 */
async function replay<T>(
  tenantId: string, endpoint: string, key: string, fingerprint: string,
): Promise<T> {
  const existing = await prisma.idempotencyKey.findUnique({
    where: { tenantId_endpoint_key: { tenantId, endpoint, key } },
  });

  // 极窄的竞态：刚才 P2002，现在又查不到（被并发的失败分支删了）。当成冲突让它重试
  if (!existing) {
    throw new AppError(409, 'IDEMPOTENCY_IN_PROGRESS', '同一请求正在处理中，请稍后重试');
  }

  /*
    ★ 指纹不同 = 两个**不同的请求**用了同一个 key。

    不比对的话，撞键会静默返回别人的结果 —— 第二个请求凭空消失，
    调用方却以为成功了。这比直接报错糟得多。
    Stripe 的原话：compares incoming parameters to those of the original request
    and errors if they're not the same to prevent accidental misuse。
  */
  if (existing.fingerprint !== fingerprint) {
    logger.warn('[Idempotency] 同一 key 收到不同内容的请求', { endpoint, key });
    throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED', '幂等键已被另一个请求占用');
  }

  /*
    还在处理中。**不等待** —— 等待会把这个连接挂住，而调用方本来就有重试机制。
    Stripe 同样是直接返回 409。
  */
  if (existing.status !== 'SUCCEEDED' || existing.responseBody == null) {
    throw new AppError(409, 'IDEMPOTENCY_IN_PROGRESS', '同一请求正在处理中，请稍后重试');
  }

  logger.info('[Idempotency] 重发，回放首次响应', { endpoint, key });
  return JSON.parse(existing.responseBody) as T;
}

/**
 * 清掉过期记录。
 *
 * 过期**不是正确性依赖**：记录没了之后，同一个 key 再来会被当成新请求，
 * 走到业务层撞 `orders.id` 主键 —— 那道兜底还在（见 order.service 的重放检查）。
 * 所以这个清理只是控表大小，跑不跑、什么时候跑都不影响正确性。
 */
export async function purgeExpiredIdempotencyKeys(): Promise<number> {
  const { count } = await prisma.idempotencyKey.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  if (count > 0) logger.info('[Idempotency] 清理过期键', { count });
  return count;
}
