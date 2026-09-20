/**
 * 优惠叠加判定。
 *
 * ## 为什么判定在 order-service
 * 这里是**唯一知道一张订单上所有折扣的地方**。POS 只知道自己算的那部分，
 * member-service 只知道券，渠道折扣是服务端自己算的 —— 只有建单这一刻
 * 所有折扣才凑齐。前端也要拦（体验），但那是提示，不是判据。
 *
 * ## 为什么基于「折扣行」而不是「券的来源」
 * 会员券现在已经不止积分兑换一种（GrantedReward.source 有五种），以后还会有
 * 不走 Reward 的优惠：满减、限时活动、优惠码。如果判定写成
 * 「if 是生日券 then …」，每加一种优惠就要改一次判定，而漏改不会报错。
 *
 * 改成：任何优惠都产出一行 DiscountLine，带一个 `exclusive` 标志，
 * 判定只看这些行。**新增优惠类型时这个文件一个字都不用改。**
 *
 * ## 语义：排斥所有，订单级
 * `exclusive` 的那一行不能和**任何**其他折扣共存 —— 手动折扣、渠道折扣、
 * 以后的促销，一视同仁。不做「只排斥某几类」那种分组，
 * 因为那要为每一对组合定规则，而收银员在台前讲不清。
 *
 * ⚠️ 渠道折扣也在排斥之列。意味着配了渠道折扣的单（美团/饿了么这类）
 * 用不了不可叠加的券。这是商家设「不可叠加」时该有的预期；
 * 真要放开是在 OrderSourceConfig 上加开关，不该塞进券的规则里。
 */

/** 一张订单上的一项折扣 */
export interface DiscountLine {
  /** 折扣来源。加新类型不用改判定逻辑，只要能产出这一行 */
  source: 'LOYALTY' | 'MANUAL_ORDER' | 'MANUAL_ITEM' | 'CHANNEL' | 'PROMOTION';
  /** 金额（分）。0 的行不参与判定 —— 见 activeLines */
  amount: number;
  /** 这一项排不排斥其他优惠。手动折扣恒 false：它不主动排斥，但会被排斥 */
  exclusive: boolean;
  /** 溯源：券是 `GrantedReward:<id>`，渠道是 channelConfigId */
  ref?: string;
  /** 展示/审计用 */
  reason?: string;
}

export interface StackingConflict {
  /** 排斥别人的那一项 */
  exclusiveSource: DiscountLine['source'];
  exclusiveRef?: string;
  /** 和它冲突的其他项 */
  conflictingSources: DiscountLine['source'][];
}

/**
 * 金额为 0 的折扣行不算「用了优惠」。
 *
 * 真实情况：POS 选了券但购物车里没有符合条件的商品（FREE_ITEM 券匹配不到），
 * 券在 selectedCoupon 里但折扣是 0。那时候拦住手动折扣是错的 ——
 * 顾客实际一分没优惠到。
 */
const activeLines = (lines: DiscountLine[]) => lines.filter((l) => l.amount > 0);

/**
 * 有没有冲突。**纯函数**，POS 和 order-service 用同一套判据。
 *
 * 返回 null = 没冲突。
 */
export function checkDiscountStacking(lines: DiscountLine[]): StackingConflict | null {
  const active = activeLines(lines);
  if (active.length <= 1) return null;   // 只有一项优惠，无从叠加

  const exclusive = active.find((l) => l.exclusive);
  if (!exclusive) return null;

  return {
    exclusiveSource: exclusive.source,
    exclusiveRef: exclusive.ref,
    conflictingSources: active.filter((l) => l !== exclusive).map((l) => l.source),
  };
}

/** 折扣合计（分）。金额口径统一走这里，免得各处自己加漏一项 */
export const totalDiscountOf = (lines: DiscountLine[]) =>
  lines.reduce((sum, l) => sum + l.amount, 0);
