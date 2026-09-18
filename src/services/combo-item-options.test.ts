/**
 * 套餐子项自己选的选项（甜度 / 冰量 / 加料）的核对与计价。
 *
 * 跑法：npm test
 *
 * 这是**钱和信任边界**：顾客端（reall-consumer-app）算出来的价一律不信，
 * 所有加价都要按子项商品的选项组重新取一遍。守四件事：
 *   1. 价从后端数据取，顾客传什么价都无所谓
 *   2. 不属于这个子项商品的 optionId 一分钱都不加（伪造 id 白嫖加料）
 *   3. 只给**进这一单的**子项算钱（顾客改过选择，旧那份还在请求里）
 *   4. 键是 comboItemId 而不是 itemId —— 同一个商品能在一个套餐里出现两次
 */

import { test } from 'node:test'
import assert from 'assert/strict'
import { verifyComboItemOptions } from './checkout-snapshot.service'

/** 一个选项。price 用 item_modifier_prices（商品级价）或 default_price（组默认价） */
const option = (id: string, name: string, opts: { itemPrice?: number; defaultPrice?: number } = {}) => ({
  id,
  name,
  display_name: name,
  code: name[0],
  default_price: opts.defaultPrice ?? 0,
  ...(opts.itemPrice !== undefined
    ? { item_modifier_prices: [{ item_id: 'any', modifier_option_id: id, price: opts.itemPrice }] }
    : {}),
})

/** 商品上挂的一个选项组，形状同公开接口 /items 的 item_modifier_groups */
const group = (id: string, name: string, options: any[]) => ({
  is_required: true,
  min_selections: 1,
  max_selections: 1,
  modifier_groups: { id, name, display_name: name, modifier_options: options },
})

/** itemPrices 里的一个商品 */
const item = (id: string, groups: any[]) => ({ id, base_price: 500, item_modifier_groups: groups })

/** combo_items 里的一行。id 是 comboItemId，item.id 才是商品 id */
const comboItem = (comboItemId: string, itemId: string) => ({
  id: comboItemId,
  item: { id: itemId, name: itemId },
  quantity: 1,
  additional_price: 0,
})

const SUGAR = group('g-sugar', 'Sugar', [
  option('o-70', '70%', { defaultPrice: 0 }),
  option('o-100', '100%', { defaultPrice: 50 }),
])
const ICE = group('g-ice', 'Ice', [option('o-reg', 'Regular Ice', { itemPrice: 80, defaultPrice: 0 })])

test('没有 comboItemOptions 时什么都不加（老版本前端 / 没有选项的套餐）', () => {
  const r = verifyComboItemOptions([comboItem('ci-1', 'milk-tea')], undefined, [item('milk-tea', [SUGAR])])
  assert.equal(r.total, 0)
  assert.equal(r.perChild.size, 0)
})

test('选中的选项按**后端**数据取价，顾客传的价无关', () => {
  const r = verifyComboItemOptions(
    [comboItem('ci-1', 'milk-tea')],
    { 'ci-1': { 'g-sugar': ['o-100'] } },
    [item('milk-tea', [SUGAR])],
  )
  assert.equal(r.total, 50)
  assert.equal(r.perChild.get('ci-1')?.length, 1)
  assert.equal(r.perChild.get('ci-1')?.[0].optionName, '100%')
})

test('item_modifier_prices（商品级价）优先于组默认价', () => {
  const r = verifyComboItemOptions(
    [comboItem('ci-1', 'milk-tea')],
    { 'ci-1': { 'g-ice': ['o-reg'] } },
    [item('milk-tea', [ICE])],
  )
  assert.equal(r.total, 80)
})

test('同一个子项选了多个组的选项，加价累加', () => {
  const r = verifyComboItemOptions(
    [comboItem('ci-1', 'milk-tea')],
    { 'ci-1': { 'g-sugar': ['o-100'], 'g-ice': ['o-reg'] } },
    [item('milk-tea', [SUGAR, ICE])],
  )
  assert.equal(r.total, 130)   // 50 + 80
  assert.equal(r.perChild.get('ci-1')?.length, 2)
})

test('★ 不属于这个商品的 optionId 一分钱都不加（伪造 id 白嫖加料）', () => {
  const r = verifyComboItemOptions(
    [comboItem('ci-1', 'milk-tea')],
    // o-reg 属于 Ice 组，而这个商品只挂了 Sugar 组
    { 'ci-1': { 'g-ice': ['o-reg'], 'g-sugar': ['o-100'] } },
    [item('milk-tea', [SUGAR])],
  )
  assert.equal(r.total, 50)                       // 只有真的能核上的那个
  assert.equal(r.perChild.get('ci-1')?.length, 1)
})

test('★ 伪造的 groupId 和 optionId 都被丢掉，不报错也不收钱', () => {
  const r = verifyComboItemOptions(
    [comboItem('ci-1', 'milk-tea')],
    { 'ci-1': { 'g-fake': ['o-fake'], 'g-sugar': ['o-does-not-exist'] } },
    [item('milk-tea', [SUGAR])],
  )
  assert.equal(r.total, 0)
  assert.equal(r.perChild.size, 0)
})

test('★ 只给进这一单的子项算钱 —— 顾客改过选择，旧那份还在请求里', () => {
  const r = verifyComboItemOptions(
    // 最后选中的是 ci-2
    [comboItem('ci-2', 'green-tea')],
    {
      'ci-1': { 'g-sugar': ['o-100'] },   // 已经被取消选中的那杯
      'ci-2': { 'g-sugar': ['o-100'] },
    },
    [item('milk-tea', [SUGAR]), item('green-tea', [SUGAR])],
  )
  assert.equal(r.total, 50)              // 只收 ci-2 那一份，不是 100
  assert.deepEqual([...r.perChild.keys()], ['ci-2'])
})

test('★ 键是 comboItemId 而不是 itemId —— 同一个商品在一个套餐里出现两次', () => {
  const r = verifyComboItemOptions(
    [comboItem('ci-a', 'milk-tea'), comboItem('ci-b', 'milk-tea')],
    {
      'ci-a': { 'g-sugar': ['o-100'] },   // 这一杯全糖（+50）
      'ci-b': { 'g-sugar': ['o-70'] },    // 那一杯七分糖（+0）
    },
    [item('milk-tea', [SUGAR])],
  )
  assert.equal(r.total, 50)
  assert.equal(r.perChild.get('ci-a')?.[0].optionName, '100%')
  assert.equal(r.perChild.get('ci-b')?.[0].optionName, '70%')
})

test('子项商品不在 itemPrices 里（已下架）时跳过，不炸也不收钱', () => {
  const r = verifyComboItemOptions(
    [comboItem('ci-1', 'gone')],
    { 'ci-1': { 'g-sugar': ['o-100'] } },
    [item('milk-tea', [SUGAR])],
  )
  assert.equal(r.total, 0)
  assert.equal(r.perChild.size, 0)
})

test('空输入不炸', () => {
  assert.equal(verifyComboItemOptions([], {}, []).total, 0)
  assert.equal(verifyComboItemOptions([], undefined, []).total, 0)
})

test('落库快照要带的字段都在（名字/打印代码/价/数量）', () => {
  const r = verifyComboItemOptions(
    [comboItem('ci-1', 'milk-tea')],
    { 'ci-1': { 'g-sugar': ['o-100'] } },
    [item('milk-tea', [SUGAR])],
  )
  const m = r.perChild.get('ci-1')![0]
  assert.equal(m.groupId, 'g-sugar')
  assert.equal(m.optionId, 'o-100')
  assert.equal(m.groupName, 'Sugar')
  assert.equal(m.optionName, '100%')
  assert.equal(m.optionCode, '1')      // 没配 print_code 时回退到 option.code
  assert.equal(m.unitPrice, 50)
  assert.equal(m.quantity, 1)
})
