/**
 * 打印任务的保留期。
 *
 * ## 为什么需要
 * 每条 print_task 存的是**整份订单快照**，生产库实测平均 14 KB、最大 71 KB
 * （86 条就占了 1.4 MB）。原来全仓一条 `deleteMany` 都没有 ——
 * 量上来之后是 WAL 和 autovacuum 的持续压力，而这张表的行一旦打完就没人再看。
 *
 * ## 分两档
 *   · 已结束（COMPLETED / FAILED）→ 保留 7 天。留这么久只为排查
 *     「那天那单到底打没打」，不是业务需要
 *   · 未结束（PENDING / SENT）→ 保留 30 天才删。它们本不该积压，
 *     留久一点是为了让「一直没打出来」这种问题还查得到现场；
 *     补印本身早就被 MAX_REPRINT_AGE_MS（2 小时）挡住了
 *
 * 和幂等键清理一样，**不是正确性依赖**：跑不跑、什么时候跑都不影响对错。
 *
 * ponytail: 一把 deleteMany 删完，不分批。现在全库 86 行，
 * 等单次删除的持锁时间成为问题时再换成 raw SQL 带 LIMIT 的循环。
 */

import prisma from '../utils/prisma';
import logger from '../utils/logger';

export const FINISHED_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const UNFINISHED_RETENTION_MS = 30 * 24 * 60 * 60_000;

export async function purgeOldPrintTasks(now: number = Date.now()): Promise<number> {
  const finished = await prisma.printTask.deleteMany({
    where: {
      status: { in: ['COMPLETED', 'FAILED'] },
      createdAt: { lt: new Date(now - FINISHED_RETENTION_MS) },
    },
  });

  const unfinished = await prisma.printTask.deleteMany({
    where: {
      status: { in: ['PENDING', 'SENT'] },
      createdAt: { lt: new Date(now - UNFINISHED_RETENTION_MS) },
    },
  });

  const count = finished.count + unfinished.count;
  if (count > 0) {
    logger.info('[PrintTasks] 清理过期任务', {
      finished: finished.count,
      unfinished: unfinished.count,
    });
  }
  return count;
}
