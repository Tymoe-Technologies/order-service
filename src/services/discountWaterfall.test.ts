/**
 * 折扣瀑布口径在**两条建单路径上必须一致**。
 *
 * 跑法：npm test
 *
 * ## 守的是什么
 * 同一张单，POS 下和顾客端下，算出的折扣必须一样。原来不一样：
 *
 *   · 渠道折扣：POS 按「券和手动折扣**之后**」算，顾客端按**原价**算
 *   · 结果是同一个 10% 渠道折扣，两条路减出不同的钱，谁先下单谁说了算
 *
 * 口径写在 POS 的 utils/discountWaterfall 里（那边有完整的单元测试），
 * 这里守的是顾客端这条路有没有跟上 —— 它的折扣是**服务端算的**，
 * 前端改不了，所以只能在这里钉。
 */

import { test } from 'node:test';
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';

const SNAPSHOT = readFileSync(join(__dirname, 'checkout-snapshot.service.ts'), 'utf8');

test('★ 顾客端的渠道折扣基于券后金额，不是原价', () => {
  /*
    瀑布的最后一层是渠道折扣。用原价当基数的话，一张 $100 的单用了 $20 券
    再走 10% 渠道折扣，会减 $10 而不是 $8 —— 而 POS 那条路减的是 $8。
  */
  const i = SNAPSHOT.indexOf('渠道折扣（复用步骤0已查到的 channelConfig');
  assert.ok(i > -1, '找不到渠道折扣计算处');
  const block = SNAPSHOT.slice(i, i + 1500);

  assert.match(block, /const afterReward = Math\.max\(0, subtotal - discountAmount\)/);
  // 两种折扣类型都要用券后基数，只改一个的话另一个还是错的
  assert.match(block, /PERCENTAGE'[\s\S]{0,120}?afterReward \*/);
  assert.match(block, /FIXED'[\s\S]{0,120}?Math\.min\(discount\.value, afterReward\)/);
  assert.doesNotMatch(block, /Math\.round\(subtotal \* \(discount\.value/, '还在拿原价当基数');
});

test('券折扣本身仍然钳在小计以内', () => {
  // 券超过小计时不能让后面的渠道折扣基数变成负数
  assert.match(SNAPSHOT, /discountAmount = Math\.min\(r\.discountCents, subtotal\)/);
});
