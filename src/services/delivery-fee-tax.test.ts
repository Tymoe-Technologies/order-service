/**
 * 配送费计税单测
 *
 * 口径（经商家与会计确认）：
 *   1. Uber Direct 是白标派送，商家是 Merchant of Record，这笔税由商家收缴
 *   2. 税率跟随所配送的商品，混合税率订单按商品行金额加权分摊
 *   3. 计税基数是顾客实际承担的金额（已扣商家补贴），不是 Uber 的报价
 *
 * 第 3 条尤其容易写错：Uber 收 $8、商家补贴 $5、顾客付 $3 时，
 * 只能对 $3 收税。拿 uberDeliveryFee 计税会多收顾客的钱。
 *
 * 金额单位一律是分。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { type TaxRate, type TaxablePortion, calculateAllocatedTax } from './tax-calculation'

const GST: TaxRate = { name: 'GST', rate: 0.05, isCompound: false }
const PST7: TaxRate = { name: 'PST', rate: 0.07, isCompound: false }

/** 复刻 checkout-snapshot 里配送费税的算法 */
function deliveryTax(
  deliveryFee: number,
  items: Array<{ unitPrice: number; quantity: number; taxRates: TaxRate[] }>,
): number {
  if (deliveryFee <= 0) return 0
  const portions: TaxablePortion[] = items.map(i => ({
    weight: i.unitPrice * i.quantity,
    taxRates: i.taxRates,
  }))
  return calculateAllocatedTax(deliveryFee, portions)
}

describe('税率跟随商品', () => {
  test('全单同一税率：配送费按该税率计', () => {
    // 咖啡 $10 GST 5%，配送费 $3 → 300 × 5% = 15
    const tax = deliveryTax(300, [{ unitPrice: 1000, quantity: 1, taxRates: [GST] }])
    assert.equal(tax, 15)
  })

  test('混合税率：配送费按商品金额比例拆开分别计税', () => {
    // 餐食 $10（GST 5%）+ 汽水 $10（GST 5% + PST 7% = 12%），配送费 $3
    // 各占一半 → 150 × 5% = 7.5 → 8（末段吃余数前的中间段四舍五入）
    //          → 150 × 12% = 18
    const tax = deliveryTax(300, [
      { unitPrice: 1000, quantity: 1, taxRates: [GST] },
      { unitPrice: 1000, quantity: 1, taxRates: [GST, PST7] },
    ])
    // 手算：第一段 round(300×1000/2000)=150 → round(150×0.05)=8
    //       末段吃余数 300-150=150 → round(150×0.05)+round(150×0.07)=8+11=19
    assert.equal(tax, 8 + 19)
  })

  test('免税商品占一半时，配送费只有一半计税', () => {
    // 免税商品（无税率）$10 + 应税餐食 $10，配送费 $2
    const tax = deliveryTax(200, [
      { unitPrice: 1000, quantity: 1, taxRates: [] },
      { unitPrice: 1000, quantity: 1, taxRates: [GST] },
    ])
    // 免税那段计 0，应税那段 100 × 5% = 5
    assert.equal(tax, 5)
  })

  test('整单免税：配送费不计税', () => {
    const tax = deliveryTax(300, [{ unitPrice: 1000, quantity: 1, taxRates: [] }])
    assert.equal(tax, 0)
  })

  test('权重按行小计算，不是按单价', () => {
    // 便宜商品买很多 vs 贵商品买一个，权重应反映实际金额
    const tax = deliveryTax(300, [
      { unitPrice: 100, quantity: 10, taxRates: [GST] },      // 1000
      { unitPrice: 1000, quantity: 1, taxRates: [GST, PST7] }, // 1000
    ])
    assert.equal(tax, 8 + 19)  // 与上面等额混合税率的用例一致
  })
})

describe('计税基数：只对顾客实付部分收税', () => {
  test('商家补贴后只对顾客承担的部分计税', () => {
    // Uber 收 $8、商家补贴 $5、顾客付 $3 —— 只对 300 计税
    const customerFee = Math.max(0, 800 - 500)
    assert.equal(customerFee, 300)
    assert.equal(deliveryTax(customerFee, [{ unitPrice: 2000, quantity: 1, taxRates: [GST] }]), 15)
  })

  test('拿 Uber 报价计税会多收顾客的钱（这是要避免的写法）', () => {
    const wrong = deliveryTax(800, [{ unitPrice: 2000, quantity: 1, taxRates: [GST] }])
    const right = deliveryTax(300, [{ unitPrice: 2000, quantity: 1, taxRates: [GST] }])
    assert.equal(wrong, 40)
    assert.equal(right, 15)
    assert.notEqual(wrong, right)
  })

  test('满额免运：配送费 0，税也是 0', () => {
    assert.equal(deliveryTax(0, [{ unitPrice: 5000, quantity: 1, taxRates: [GST] }]), 0)
  })

  test('FREE 规则：同上', () => {
    assert.equal(deliveryTax(0, [{ unitPrice: 1000, quantity: 1, taxRates: [GST, PST7] }]), 0)
  })
})

describe('边界', () => {
  test('自取单没有配送费，不产生配送费税', () => {
    assert.equal(deliveryTax(0, [{ unitPrice: 1000, quantity: 1, taxRates: [GST] }]), 0)
  })

  test('购物车为空时不炸（理论上不会发生，但别让计税抛异常）', () => {
    assert.equal(deliveryTax(300, []), 0)
  })

  test('配送费为负数（不应发生）按 0 处理', () => {
    assert.equal(deliveryTax(-100, [{ unitPrice: 1000, quantity: 1, taxRates: [GST] }]), 0)
  })
})
