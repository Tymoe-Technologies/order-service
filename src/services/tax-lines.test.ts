/**
 * 税种明细。
 *
 * 这里守的是一条纪律：**加不平就丢掉，不存半份**。
 * 日结单上一组自己加不平的税额比没有更糟 —— 店主会拿它去申报，
 * 而退回「只印一个合计」至少是对的。
 */

import { test, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeTaxLines, aggregateTaxLines, sanitizeItemTaxLines } from './tax-lines'

const GST = { name: 'GST', rate: 0.05, amount: 500 }
const PST = { name: 'PST', rate: 0.07, amount: 700 }

describe('sanitizeTaxLines', () => {
  test('加得平就收下', () => {
    assert.deepEqual(sanitizeTaxLines([GST, PST], 1200), [GST, PST])
  })

  test('差 1 分放行 —— 各税种是逐行四舍五入后再相加的', () => {
    assert.ok(sanitizeTaxLines([GST, PST], 1201))
    assert.ok(sanitizeTaxLines([GST, PST], 1199))
  })

  test('差得多就整份丢掉', () => {
    assert.equal(sanitizeTaxLines([GST, PST], 1500), null)
  })

  test('缺名字 / 金额不是数 → 整份丢，不跳过那一行', () => {
    // 跳过会让剩下的加不平、然后照样被丢掉，结果一样但更难查
    assert.equal(sanitizeTaxLines([{ ...GST, name: '' }, PST], 1200), null)
    assert.equal(sanitizeTaxLines([{ ...GST, amount: 'x' }, PST], 1200), null)
    assert.equal(sanitizeTaxLines([{ ...GST, amount: -1 }, PST], 1199), null)
  })

  test('空数组 / 不是数组 → null（免税单没有明细，正常）', () => {
    assert.equal(sanitizeTaxLines([], 0), null)
    assert.equal(sanitizeTaxLines(undefined, 0), null)
    assert.equal(sanitizeTaxLines('GST', 0), null)
  })

  test('名字截断到 40 字，不让脏数据把列撑爆', () => {
    const long = sanitizeTaxLines([{ name: 'x'.repeat(80), rate: 0.05, amount: 500 }], 500)
    assert.equal(long![0].name.length, 40)
  })
})

describe('aggregateTaxLines', () => {
  test('按税种名归并并按金额降序', () => {
    const { lines, complete } = aggregateTaxLines([
      { taxAmount: 1200, taxLines: [GST, PST] },
      { taxAmount: 1200, taxLines: [GST, PST] },
    ])
    assert.deepEqual(lines, [
      { name: 'PST', rate: 0.07, amount: 1400 },
      { name: 'GST', rate: 0.05, amount: 1000 },
    ])
    assert.equal(complete, true)
  })

  /*
    只要区间里有**一张**订单没有明细，拆出来的和就小于总税额。
    那时日结单必须退回只印合计 —— 印一组不完整的拆分，
    店主按它申报就会少报。存量订单全是这种情况。
  */
  test('有一张订单没明细 → complete=false', () => {
    const { lines, complete } = aggregateTaxLines([
      { taxAmount: 1200, taxLines: [GST, PST] },
      { taxAmount: 500, taxLines: null },
    ])
    assert.equal(complete, false)
    assert.equal(lines.length, 2)   // 拆出来的仍然返回，由调用方决定印不印
  })

  test('免税单（税额 0、无明细）不影响完整性', () => {
    const { complete } = aggregateTaxLines([
      { taxAmount: 1200, taxLines: [GST, PST] },
      { taxAmount: 0, taxLines: null },   // 礼品卡单就是这样
    ])
    assert.equal(complete, true)
  })

  test('区间内税率被调过 → 归并成一行，税率取金额最大那一档', () => {
    // 分成两行会让店主以为多了一种税；申报填的是金额，税率只作展示
    const { lines } = aggregateTaxLines([
      { taxAmount: 500, taxLines: [{ name: 'PST', rate: 0.07, amount: 500 }] },
      { taxAmount: 100, taxLines: [{ name: 'PST', rate: 0.06, amount: 100 }] },
    ])
    assert.deepEqual(lines, [{ name: 'PST', rate: 0.07, amount: 600 }])
  })

  test('一张明细都没有 → complete=false', () => {
    assert.equal(aggregateTaxLines([{ taxAmount: 500, taxLines: null }]).complete, false)
  })
})

describe('sanitizeItemTaxLines', () => {
  const GST = { name: 'GST', rate: 0.05, amount: 47 }
  const PST = { name: 'PST', rate: 0.08, amount: 4 }

  it('各行加起来等于整单税额 → 全部保留', () => {
    // 奶茶只收 GST 47，两个耗材各收 PST 2 —— 合计 51 = 订单头税额
    const r = sanitizeItemTaxLines(
      [[GST], [{ ...PST, amount: 2 }], [{ ...PST, amount: 2 }]],
      51,
    )
    assert.deepEqual(r[0], [GST])
    assert.equal(r[1]![0].amount, 2)
    assert.equal(r[2]![0].amount, 2)
  })

  it('无税的行传 null，不影响求和', () => {
    const r = sanitizeItemTaxLines([[GST], null, undefined], 47)
    assert.deepEqual(r[0], [GST])
    assert.equal(r[1], null)
    assert.equal(r[2], null)
  })

  it('差 1 分容掉（逐行取整所致）', () => {
    const r = sanitizeItemTaxLines([[GST]], 48)
    assert.deepEqual(r[0], [GST])
  })

  it('加不平就**整单**丢掉，不是只丢有问题那一行', () => {
    // 行级合计 51，订单头却是 80 —— 少了 29，这份明细不可信
    const r = sanitizeItemTaxLines([[GST], [PST]], 80)
    assert.deepEqual(r, [null, null])
  })

  it('一行都没有明细时原样返回（本来就没有，不是出错）', () => {
    const r = sanitizeItemTaxLines([null, null], 51)
    assert.deepEqual(r, [null, null])
  })

  it('形状不合法的行让整单作废（名字为空）', () => {
    const r = sanitizeItemTaxLines([[{ name: '', rate: 0.05, amount: 47 }], [PST]], 51)
    assert.deepEqual(r, [null, null])
  })
})
