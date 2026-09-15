/**
 * 渠道整单折扣。
 *
 * ⚠️ 这份计算在 **POS 也有一份**（`src/services/channelService.ts` 的
 * `calcChannelDiscount`），两边必须算出同一个数 —— 同一张单前后端不一致的话：
 *   · 挂账单：小票印一个数、账上记另一个数
 *   · 现金/刷卡单：POS 按自己的数收款，而 finance 的应收取自 order.totalAmount，
 *     已收 > 应收 → settlePayment 判成 overpaid → 「记录照写但不标 PAID」。
 *     钱收了、单结不清，店员看到「未支付」很可能再收一次。
 *
 * 实测踩过一次（订单 260914-P02-1WLQ）：后端拿**原始** subtotal 当基数、
 * POS 拿**整单折扣后**的，POS 显示 $3.05、库里记 $2.92，差 13 分。
 */

export interface ChannelOrderDiscountRule {
  enabled?: boolean;
  type?: 'PERCENTAGE' | 'FIXED';
  /** PERCENTAGE 时是 0-100 的百分比；FIXED 时是分 */
  value?: number;
}

/**
 * @param subtotal          小计（分，已扣商品级折扣）
 * @param orderLevelDiscount 整单折扣（分，会员券 + 店员手动）
 *
 * 基数是**整单折扣之后**的小计：折扣不该叠加在原价上 —— 券先减 10%、
 * 渠道再按原价减 20%，等于同一块钱打两次折，商家白让一截。
 */
export function calcChannelDiscount(
  rule: ChannelOrderDiscountRule | null | undefined,
  subtotal: number,
  orderLevelDiscount: number,
): number {
  if (!rule?.enabled || !rule.value) return 0;
  const base = Math.max(0, subtotal - orderLevelDiscount);
  if (rule.type === 'PERCENTAGE') return Math.round(base * (rule.value / 100));
  if (rule.type === 'FIXED') return Math.min(rule.value, base);
  return 0;
}
