/**
 * 耗材行（餐具 / 购物袋 / 打包费）的口径。
 *
 * 它们当成普通商品行落在 order_items 里（lineKind=SUPPLY），是为了不另开
 * 一条并行的账。代价是**每一个「按商品」的口径都得记得排除它** ——
 * 折扣、积分、商品件数、标签、厨房单，漏一个就静默出错。
 * POS 侧的同名判断在 utils/supplyLine.ts。
 */

import type { Prisma } from '.prisma/client-order';
import prisma from '../utils/prisma';

type Db = Prisma.TransactionClient | typeof prisma;

/**
 * 这一单的耗材小计（分）。
 *
 * 用处：把它从 subtotal 里减掉，就得到「可参与折扣 / 可计积分」的商品小计。
 * 走 @@index([orderId, lineKind])，一次聚合。
 *
 * 不在 orders 上冗余存一列：它能从订单行算出来，而且只在发事件时用到几次，
 * 多一列就多一处要维护的真相。
 */
export async function sumSupplySubtotal(db: Db, orderId: string): Promise<number> {
  const r = await db.orderItem.aggregate({
    where: { orderId, lineKind: 'SUPPLY' },
    _sum: { totalPrice: true },
  });
  return r._sum.totalPrice ?? 0;
}
