/**
 * 标签行的挑选与下标。
 *
 * 跑法：npm test
 *
 * 守三件事：
 *   1. 耗材（餐具/购物袋/打包费）不出标签，也不进「第 X / 共 Y 杯」的分母
 *   2. `itemIndex` 是**原数组**的下标 —— payload 里只带这个数字，
 *      客户端拿 `orderData.orderItems[itemIndex]` 反查那一行。
 *      用过滤后的下标会印出**别的菜名**，而且不会有任何报错。
 *   3. 套餐**按子项**出杯贴，`comboChildIndex` 的口径和 POS 一致。
 *
 * ## 第 3 条和 POS 是一对镜像测试
 * 对应 POS 的 `src/utils/comboLine.test.ts`（`expandOrderLine` 那一组）。
 * 服务端只发一个 `comboChildIndex`，客户端按**自己**摊开后的下标取子项 ——
 * 两边的过滤规则（itemId 非空）或顺序错开，标签就印成另一个子项。
 * **改一边必须同步另一边。**
 */

import { test } from 'node:test';
import assert from 'assert/strict';
import { labelLinesWithIndex } from './print-task-generator';

const product = (name: string, quantity = 1) => ({ itemName: name, quantity, lineKind: 'PRODUCT' });
const supply = (name: string, quantity = 1) => ({ itemName: name, quantity, lineKind: 'SUPPLY' });
const combo = (name: string, children: any[], quantity = 1) =>
  ({ itemName: name, quantity, lineKind: 'PRODUCT', comboId: 'combo-1', comboSelections: children });
const child = (itemId: string, itemName: string, quantity = 1) => ({ itemId, itemName, quantity, additionalPrice: 0 });

test('耗材不出标签', () => {
  const lines = [product('宫保鸡丁'), supply('购物袋', 2), product('柠檬茶')];
  assert.deepEqual(
    labelLinesWithIndex(lines).map((x) => x.item.itemName),
    ['宫保鸡丁', '柠檬茶'],
  );
});

test('itemIndex 是原数组的下标，不是过滤后的', () => {
  // 柠檬茶在原数组里是第 2 个（下标 2）。若返回 1，客户端会取到购物袋
  const lines = [product('宫保鸡丁'), supply('购物袋', 2), product('柠檬茶')];
  const picked = labelLinesWithIndex(lines);
  assert.deepEqual(picked.map((x) => x.index), [0, 2]);
  // 拿下标反查必须回到同一行 —— 这就是客户端的做法
  for (const { item, index } of picked) {
    assert.equal(lines[index].itemName, item.itemName);
  }
});

test('分母只数真商品', () => {
  const lines = [product('宫保鸡丁', 3), supply('购物袋', 5), product('柠檬茶', 2)];
  const total = labelLinesWithIndex(lines).reduce((s, u) => s + u.quantity, 0);
  assert.equal(total, 5);   // 3 + 2，不含购物袋那 5 个
});

test('普通行不带 comboChildIndex（老客户端也认得的形状）', () => {
  const units = labelLinesWithIndex([product('柠檬茶', 2)]);
  assert.equal(units.length, 1);
  assert.equal(units[0].comboChildIndex, undefined);
  assert.equal(units[0].quantity, 2);
});

test('套餐按子项出杯贴：一份三杯的套餐出三张，不是一张', () => {
  const lines = [combo('双人下午茶', [child('i1', '芒果茶'), child('i2', '奶茶'), child('i3', '乌龙茶')])];
  const units = labelLinesWithIndex(lines);
  assert.equal(units.length, 3);
  assert.deepEqual(units.map((u) => u.comboChildIndex), [0, 1, 2]);
  // 三张都反查到套餐那一行（子项不在 order_items 里）
  assert.deepEqual(units.map((u) => u.index), [0, 0, 0]);
});

test('子项张数 = 子项数量 × 套餐份数', () => {
  // 2 份套餐，里面 1 杯芒果茶 + 2 杯奶茶 → 2 张 + 4 张
  const lines = [combo('双人下午茶', [child('i1', '芒果茶'), child('i2', '奶茶', 2)], 2)];
  const units = labelLinesWithIndex(lines);
  assert.deepEqual(units.map((u) => u.quantity), [2, 4]);
  assert.equal(units.reduce((s, u) => s + u.quantity, 0), 6);
});

test('itemIndex 在套餐混排时仍是原数组下标', () => {
  const lines = [
    product('前菜'),
    supply('购物袋'),
    combo('双人下午茶', [child('i1', 'a'), child('i2', 'b')]),
    product('后菜'),
  ];
  const units = labelLinesWithIndex(lines);
  assert.deepEqual(units.map((u) => u.index), [0, 2, 2, 3]);
  for (const u of units) {
    assert.equal((lines[u.index] as any).itemName, (u.item as any).itemName);
  }
});

test('没有 itemId 的子项丢掉，且下标按剩下的重排 —— 口径必须和 POS 一致', () => {
  const lines = [combo('套餐', [child('i1', 'a'), { itemName: '坏数据', quantity: 1 } as any, child('i3', 'c')])];
  const units = labelLinesWithIndex(lines);
  assert.equal(units.length, 2);
  assert.deepEqual(units.map((u) => u.comboChildIndex), [0, 1]);
});

test('一个子项都没有的套餐退回「整行一张」，不是零张', () => {
  // 空套餐不该静默地一张标签都不出 —— 那杯东西照样卖出去了
  assert.deepEqual(
    labelLinesWithIndex([combo('空套餐', [])]).map((u) => ({ i: u.index, q: u.quantity, c: u.comboChildIndex })),
    [{ i: 0, q: 1, c: undefined }],
  );
});

test('整单只有耗材时一张标签都不出', () => {
  assert.deepEqual(labelLinesWithIndex([supply('打包费'), supply('购物袋', 2)]), []);
});

test('没有 lineKind 的老数据按商品算', () => {
  // 存量订单行的 lineKind 默认是 PRODUCT，但事件里万一没带这个字段，
  // 也不能把真商品当成耗材漏掉（漏掉 = 那道菜的标签不出，比多印一张糟得多）
  const lines = [{ itemName: '旧数据', quantity: 1 }] as any;
  assert.deepEqual(labelLinesWithIndex(lines).map((x: any) => x.item.itemName), ['旧数据']);
});
