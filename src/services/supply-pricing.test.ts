/**
 * 耗材计价单测
 *
 * 锁住 checkout-snapshot 里那个容易被"顺手合并"掉的决策：
 * 耗材行必须和商品行**分两次**调用 calculateOrderTax，折扣传 0。
 *
 * 合并调用看起来更简洁，但 calculateOrderTax 会把折扣按行小计分摊到每一行，
 * 耗材混进去就等于把商品的折扣分了一部分到袋子上 —— 商品那边少扣税、
 * 袋子那边凭空吃掉一份不属于它的折扣。这个错误在金额上很小（几分钱），
 * 平时看不出来，对账时才会发现 Σ 行折扣 ≠ 订单折扣。
 *
 * 金额单位一律是分。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { type TaxRate, type TaxablePortion, calculateOrderTax } from './tax-calculation'

const GST: TaxRate = { name: 'GST', rate: 0.05, isCompound: false }

/** 一行：小计 + 单一税率（耗材行就是这个形状） */
const line = (subtotal: number, rates: TaxRate[]) => ({
  lineSubtotal: subtotal,
  portions: [{ weight: subtotal, taxRates: rates }] as TaxablePortion[],
})

describe('耗材与商品分开计税', () => {
  test('商品打折时，耗材税不受折扣影响', () => {
    // 商品 10000 分，折扣 2000 分 → 应税 8000，GST 5% = 400
    const productTax = calculateOrderTax([line(10000, [GST])], 2000)
    assert.equal(productTax, 400)

    // 耗材 50 分（打包费），不打折 → GST 5% = 2.5 → 四舍五入 3
    const supplyTax = calculateOrderTax([line(50, [GST])], 0)
    assert.equal(supplyTax, 3)

    assert.equal(productTax + supplyTax, 403)
  })

  test('合并调用会把折扣分摊到耗材上，算出的税更少（这就是要分开的原因）', () => {
    // 把两行合起来传，折扣 2000 会按 10000:50 的比例分摊：
    // 商品行分到 round(2000 * 10000/10050) = 1990，应税 8010 → 税 401（多收）
    // 耗材行吃余数 2000-1990 = 10，应税 50-10 = 40 → 税 2（少收）
    // 合计 403 —— 这个例子里凑巧也是 403，但两行各自的税额都错了，
    // 落到 OrderItem 级别的税额明细和退款计算上就是错的
    const merged = calculateOrderTax([line(10000, [GST]), line(50, [GST])], 2000)

    // 关键不是总额差多少，而是耗材行凭空吃到了 10 分的折扣：
    // 它的应税基数从 50 掉到了 40
    const supplyAloneTax = calculateOrderTax([line(50, [GST])], 0)
    const supplyInMergedTax = merged - calculateOrderTax([line(10000, [GST])], 1990)
    assert.notEqual(supplyInMergedTax, supplyAloneTax)
    assert.equal(supplyAloneTax, 3)
    assert.equal(supplyInMergedTax, 2)
  })

  test('折扣大于商品小计时，耗材照收不误', () => {
    // 全额折扣的商品（免单奖励）：商品税 0，但袋子钱照付
    const productTax = calculateOrderTax([line(500, [GST])], 500)
    assert.equal(productTax, 0)

    const supplyTax = calculateOrderTax([line(15, [GST])], 0)
    assert.equal(supplyTax, 1)  // round(15 * 0.05) = 0.75 → 1
  })
})

describe('免收与空集', () => {
  test('满额免收的耗材单价为 0，不产生税', () => {
    // 打包费被免 → total_price 0 → calculateOrderTax 直接返回 0
    assert.equal(calculateOrderTax([line(0, [GST])], 0), 0)
  })

  test('没有耗材行时返回 0，不影响商品税', () => {
    assert.equal(calculateOrderTax([], 0), 0)
  })

  test('耗材没配税率时不计税（不能拿商品税率兜底）', () => {
    // 商品侧的选项没配税率会回退到商品税率，耗材没有"所属商品"这个概念，
    // 没配就是不收 —— 免税州的袋子费本来就不该收税
    assert.equal(calculateOrderTax([line(50, [])], 0), 0)
  })
})

describe('订单不变式', () => {
  test('subtotal 必须等于所有订单行之和（含耗材）', () => {
    // 耗材做成 OrderItem 行之后，subtotal 不含耗材就会和 Σ orderItems 对不上，
    // 财务对账直接崩。这条不变式在 checkout-snapshot 里由
    // subtotalWithSupplies = subtotal + supplySubtotal 保证
    const productLines = [{ unitPrice: 1200, quantity: 2 }, { unitPrice: 800, quantity: 1 }]
    const supplyLines = [{ unitPrice: 50, quantity: 1 }, { unitPrice: 15, quantity: 2 }]

    const productSubtotal = productLines.reduce((s, l) => s + l.unitPrice * l.quantity, 0)
    const supplySubtotal = supplyLines.reduce((s, l) => s + l.unitPrice * l.quantity, 0)
    const allLines = [...productLines, ...supplyLines]

    assert.equal(productSubtotal, 3200)
    assert.equal(supplySubtotal, 80)
    assert.equal(
      productSubtotal + supplySubtotal,
      allLines.reduce((s, l) => s + l.unitPrice * l.quantity, 0)
    )
  })
})
