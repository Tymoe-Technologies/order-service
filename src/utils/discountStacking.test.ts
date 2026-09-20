/**
 * 优惠叠加判定。
 *
 * 跑法：npm test
 *
 * ## 这块原来完全不生效
 * Reward 上有一整套叠加规则字段（stackingMode / exclusionGroup /
 * maxPerOrder / incompatibleWith / priority），Portal 能配、数据库能存，
 * **没有任何地方读**。商家把券设成「不可与其他优惠同用」，店员照样能在
 * 用券的单上再打个折，没有任何报错 —— 只会在月底对账时发现折扣率不对。
 *
 * ## 为什么判据是「折扣行」不是「券的来源」
 * 会员券已经不止积分兑换一种，以后还会有满减、限时活动、优惠码。
 * 判定写成 `if 是生日券 then …` 的话，每加一种优惠都要改一次，
 * 而漏改不报错。基于 DiscountLine 之后，新增类型时这个文件不用动。
 */

import { test } from 'node:test';
import assert from 'assert/strict';
import { checkDiscountStacking, totalDiscountOf, type DiscountLine } from './discountStacking';

const coupon = (amount: number, exclusive: boolean): DiscountLine =>
  ({ source: 'LOYALTY', amount, exclusive, ref: 'GrantedReward:x' });
const manual = (amount: number): DiscountLine =>
  ({ source: 'MANUAL_ORDER', amount, exclusive: false });
const channel = (amount: number): DiscountLine =>
  ({ source: 'CHANNEL', amount, exclusive: false });

test('只有一项优惠 → 无从叠加', () => {
  assert.equal(checkDiscountStacking([coupon(500, true)]), null);
  assert.equal(checkDiscountStacking([]), null);
});

test('都可叠加 → 放行', () => {
  assert.equal(checkDiscountStacking([coupon(500, false), manual(200)]), null);
});

test('★ 不可叠加的券 + 手动折扣 → 冲突', () => {
  const c = checkDiscountStacking([coupon(500, true), manual(200)]);
  assert.deepEqual(c, {
    exclusiveSource: 'LOYALTY',
    exclusiveRef: 'GrantedReward:x',
    conflictingSources: ['MANUAL_ORDER'],
  });
});

test('★ 渠道折扣也在排斥之列', () => {
  /*
    「排斥所有」就是字面意思。配了渠道折扣的单（美团/饿了么这类）用不了
    不可叠加的券 —— 这是商家设「不可叠加」时该有的预期。
    真要放开是在 OrderSourceConfig 上加开关，不该塞进券的规则里。
  */
  const c = checkDiscountStacking([coupon(500, true), channel(100)]);
  assert.equal(c?.conflictingSources[0], 'CHANNEL');
});

test('冲突项全部列出来，不是只报第一个', () => {
  // 提示文案要能说清「和什么冲突」，只报一个的话店员撤掉它还是过不了
  const c = checkDiscountStacking([coupon(500, true), manual(200), channel(100)]);
  assert.deepEqual(c?.conflictingSources, ['MANUAL_ORDER', 'CHANNEL']);
});

test('★ 金额为 0 的折扣行不算「用了优惠」', () => {
  /*
    真实情况：POS 上选了 FREE_ITEM 券但购物车里没有符合条件的商品，
    券在 selectedCoupon 里挂着、折扣却是 0。那时候拦住手动折扣是错的 ——
    顾客实际一分没优惠到，凭什么不让打折。
  */
  assert.equal(checkDiscountStacking([coupon(0, true), manual(200)]), null);
  assert.equal(checkDiscountStacking([coupon(500, true), manual(0)]), null);
});

test('两项都排斥时报第一项 —— 不会漏判', () => {
  // 现在只有券能 exclusive，但以后促销活动也可能是。两个都独占同样是冲突
  const c = checkDiscountStacking([
    coupon(500, true),
    { source: 'PROMOTION', amount: 300, exclusive: true },
  ]);
  assert.equal(c?.exclusiveSource, 'LOYALTY');
  assert.deepEqual(c?.conflictingSources, ['PROMOTION']);
});

test('★ 新增优惠类型不用改判定', () => {
  /*
    这是这套设计存在的理由：满减、优惠码、限时活动 …… 只要能产出一行
    带 exclusive 标志的 DiscountLine，就自动纳入判定。
  */
  const c = checkDiscountStacking([
    { source: 'PROMOTION', amount: 300, exclusive: false },
    coupon(500, true),
  ]);
  assert.equal(c?.exclusiveSource, 'LOYALTY');
  assert.deepEqual(c?.conflictingSources, ['PROMOTION']);
});

test('合计包含 0 行，口径统一走一个函数', () => {
  assert.equal(totalDiscountOf([coupon(500, true), manual(0), channel(100)]), 600);
});

// ─────────────────────────────────────────────────────────────────────────────
// 下面几条是源码级的，守的是「明细有没有真的被用起来」——
// 纯函数写得再对，没接到建单链路上也是白搭（这套字段上一版就是这么废掉的：
// Portal 能配、数据库能存、没有任何地方读）。
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from 'fs';
import { join } from 'path';

const ORDER_SERVICE = readFileSync(join(__dirname, '..', 'services', 'order.service.ts'), 'utf8');
const SNAPSHOT = readFileSync(join(__dirname, '..', 'services', 'checkout-snapshot.service.ts'), 'utf8');

test('★ 两条建单路径都做了叠加校验', () => {
  // POS 走 order.service，顾客端走 checkout-snapshot。漏一条就是那条路能绕过
  for (const [name, src] of [['order.service', ORDER_SERVICE], ['checkout-snapshot', SNAPSHOT]] as const) {
    assert.match(src, /checkDiscountStacking\(/, `${name} 没做叠加校验`);
    assert.match(src, /DISCOUNT_NOT_STACKABLE/, `${name} 冲突时没拒绝`);
  }
});

test('★ 渠道折扣要并进判定 —— POS 算不出它', () => {
  /*
    渠道折扣是服务端自己算的（防篡改），POS 那边的实时提示天然漏这一项。
    建单时不补进去的话，「券 + 渠道折扣」这个组合永远拦不住。
  */
  const i = ORDER_SERVICE.indexOf('const discountLines = [');
  assert.ok(i > -1, '找不到明细汇总处');
  const block = ORDER_SERVICE.slice(i, i + 800);
  assert.match(block, /source: 'CHANNEL'/);
  assert.match(block, /source: 'MANUAL_ITEM'/, '单品折扣也要补 —— POS 只发整单级两项');
});

test('★ 账本科目按行分发，不是按 discountType 猜', () => {
  /*
    这是这次顺带修掉的现存 bug：discountType 在混合折扣时只标「优先级最高
    的那类」，于是券 $5 + 手动 $2 的单整笔 $7 都记进 6300 Loyalty，
    $2 记在错的科目上。
  */
  const i = ORDER_SERVICE.indexOf('折扣账本分录路由');
  assert.ok(i > -1);
  const block = ORDER_SERVICE.slice(i, i + 2000);
  assert.match(block, /for \(const line of discountLines\)/, '没有按行分发');
  assert.match(block, /line\.source === 'LOYALTY'/);
  // 存量订单没有明细，老路要留着
  assert.match(block, /\} else if \(discountAmount > 0\)/, '存量订单的兜底路径被删了');
});
