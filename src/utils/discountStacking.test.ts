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
