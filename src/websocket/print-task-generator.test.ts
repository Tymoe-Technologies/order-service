/**
 * 标签行的挑选与下标。
 *
 * 跑法：npm test
 *
 * 守两件事：
 *   1. 耗材（餐具/购物袋/打包费）不出标签，也不进「第 X / 共 Y 杯」的分母
 *   2. `itemIndex` 是**原数组**的下标 —— payload 里只带这个数字，
 *      客户端拿 `orderData.orderItems[itemIndex]` 反查那一行。
 *      用过滤后的下标会印出**别的菜名**，而且不会有任何报错。
 */

import { test } from 'node:test';
import assert from 'assert/strict';
import { labelLinesWithIndex } from './print-task-generator';

const product = (name: string, quantity = 1) => ({ itemName: name, quantity, lineKind: 'PRODUCT' });
const supply = (name: string, quantity = 1) => ({ itemName: name, quantity, lineKind: 'SUPPLY' });

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
  const total = labelLinesWithIndex(lines).reduce((s, { item }) => s + item.quantity, 0);
  assert.equal(total, 5);   // 3 + 2，不含购物袋那 5 个
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
