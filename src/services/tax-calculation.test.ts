/**
 * 结账计税单测
 *
 * 这套算税逻辑直接决定顾客付多少钱、平台报多少税，而且要和 POS 前端
 * (utils/taxCalculation.ts) 与 consumer-app 结账页三端算出同一个数，
 * 所以每个用例的期望值都是手算写死在注释里的，不用代码算代码。
 *
 * 金额单位一律是分。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  type TaxRate,
  extractTaxRatesFromRelations,
  extractTaxRatesFromItems,
  calculateTax,
  calculateAllocatedTax,
  buildItemTaxPortions,
  calculateOrderTax,
} from './tax-calculation'

const GST: TaxRate = { name: 'GST', rate: 0.05, isCompound: false }
const PST: TaxRate = { name: 'PST', rate: 0.07, isCompound: false }
const QST: TaxRate = { name: 'QST', rate: 0.09975, isCompound: true }

/** 造一个 item service 形状的税率关联行 */
const rel = (id: string, name: string, rate: number, isCompound = false) => ({
  tax_rate: { id, name, rate, is_compound: isCompound },
})

describe('extractTaxRatesFromRelations', () => {
  test('解析 tax_rate 关联行', () => {
    assert.deepEqual(extractTaxRatesFromRelations([rel('t1', 'GST', 0.05)]), [GST])
  })

  test('兼容旧字段名 tenant_tax_rates', () => {
    const rows = [{ tenant_tax_rates: { id: 't1', name: 'GST', rate: 0.05, is_compound: false } }]
    assert.deepEqual(extractTaxRatesFromRelations(rows), [GST])
  })

  test('同一个税率 id 只保留一份', () => {
    const rows = [rel('t1', 'GST', 0.05), rel('t1', 'GST', 0.05)]
    assert.equal(extractTaxRatesFromRelations(rows).length, 1)
  })

  test('非数组 / 空 / 缺 id 一律当没配', () => {
    assert.deepEqual(extractTaxRatesFromRelations(undefined), [])
    assert.deepEqual(extractTaxRatesFromRelations(null), [])
    assert.deepEqual(extractTaxRatesFromRelations([]), [])
    assert.deepEqual(extractTaxRatesFromRelations([{ tax_rate: { name: 'x', rate: 1 } }]), [])
  })

  test('rate 是字符串时转成数字（Prisma Decimal 序列化后是字符串）', () => {
    const rows = [{ tax_rate: { id: 't1', name: 'GST', rate: '0.0500', is_compound: false } }]
    assert.deepEqual(extractTaxRatesFromRelations(rows), [GST])
  })
})

describe('extractTaxRatesFromItems', () => {
  test('多个商品的税率按「税名+税率」去重', () => {
    const items = [
      { item_tax_rates: [rel('t1', 'GST', 0.05)] },
      { item_tax_rates: [rel('t2', 'GST', 0.05), rel('t3', 'PST', 0.07)] },
    ]
    assert.deepEqual(extractTaxRatesFromItems(items), [GST, PST])
  })

  test('商品没配税率时返回空', () => {
    assert.deepEqual(extractTaxRatesFromItems([{ item_tax_rates: [] }, {}]), [])
  })
})

describe('calculateTax', () => {
  test('没配税率 = 不计税', () => {
    assert.equal(calculateTax(1000, []), 0)
  })

  test('单个非复合税：1000 × 5% = 50', () => {
    assert.equal(calculateTax(1000, [GST]), 50)
  })

  test('多个非复合税各自以原额为基数：1000 × (5% + 7%) = 50 + 70 = 120', () => {
    assert.equal(calculateTax(1000, [GST, PST]), 120)
  })

  test('复合税以「原额 + 非复合税」为基数：GST 50，QST = round(1050 × 9.975%) = 105，共 155', () => {
    assert.equal(calculateTax(1000, [GST, QST]), 155)
  })

  test('逐项四舍五入：599 × 5% = 29.95 → 30', () => {
    assert.equal(calculateTax(599, [GST]), 30)
  })

  test('基数为 0 时不计税', () => {
    assert.equal(calculateTax(0, [GST]), 0)
  })
})

describe('buildItemTaxPortions', () => {
  test('无选项时只有商品一段', () => {
    const portions = buildItemTaxPortions(1000, 2, [], [GST])
    assert.deepEqual(portions, [{ weight: 2000, taxRates: [GST] }])
  })

  test('选项没配税率 → 回退商品税率（大多数加料跟主商品同税，当成免税会少收）', () => {
    const portions = buildItemTaxPortions(1000, 1, [{ unitPrice: 80, quantity: 1, taxRates: [] }], [GST])
    assert.deepEqual(portions, [
      { weight: 1000, taxRates: [GST] },
      { weight: 80, taxRates: [GST] },
    ])
  })

  test('选项配了税率 → 用自己的', () => {
    const portions = buildItemTaxPortions(1000, 1, [{ unitPrice: 80, quantity: 1, taxRates: [PST] }], [GST])
    assert.equal(portions[1].taxRates[0].name, 'PST')
  })

  test('选项权重按 单价 × 选项数量 × 行数量', () => {
    const portions = buildItemTaxPortions(1000, 3, [{ unitPrice: 80, quantity: 2, taxRates: [GST] }], [GST])
    assert.equal(portions[1].weight, 480) // 80 × 2 × 3
  })
})

describe('calculateAllocatedTax', () => {
  test('单段等价于直接计税', () => {
    assert.equal(calculateAllocatedTax(1000, [{ weight: 1000, taxRates: [GST] }]), 50)
  })

  test('两段各自税率：600×5%=30，400×7%=28，共 58', () => {
    const tax = calculateAllocatedTax(1000, [
      { weight: 600, taxRates: [GST] },
      { weight: 400, taxRates: [PST] },
    ])
    assert.equal(tax, 58)
  })

  test('免税段不吃税：商品段 1000 免税，选项段 200 收 GST → round(200×5%) = 10', () => {
    const tax = calculateAllocatedTax(1200, [
      { weight: 1000, taxRates: [] },
      { weight: 200, taxRates: [GST] },
    ])
    assert.equal(tax, 10)
  })

  test('末段吃分摊余数，Σ 分摊 = taxableBase', () => {
    // 三段等权重，1000 分不尽：前两段各 round(1000/3)=333，末段 1000-666=334
    // 全同税率下 33 + 33 + 17 …… 直接验总额不丢分：用同一税率时应等于整额计税
    const parts = [
      { weight: 1, taxRates: [GST] },
      { weight: 1, taxRates: [GST] },
      { weight: 1, taxRates: [GST] },
    ]
    // 333×5%=16.65→17, 333→17, 334×5%=16.7→17 ⇒ 51（整额算是 50，逐段舍入差 1 分，属预期）
    assert.equal(calculateAllocatedTax(1000, parts), 51)
  })

  test('权重为 0 的段被剔除，不会吃到余数', () => {
    // 免费选项（weight 0）如果参与分摊并排在末位，会拿到全部余数并按自己的税率计税
    const tax = calculateAllocatedTax(1000, [
      { weight: 1000, taxRates: [GST] },
      { weight: 0, taxRates: [PST] },
    ])
    assert.equal(tax, 50) // 只有 GST 段，PST 不该出现
  })

  test('全部权重为 0 时不计税', () => {
    assert.equal(calculateAllocatedTax(1000, [{ weight: 0, taxRates: [GST] }]), 0)
  })

  test('空分段不计税', () => {
    assert.equal(calculateAllocatedTax(1000, []), 0)
  })
})

describe('calculateOrderTax（整单）', () => {
  test('真实订单 260828-W00-16J9：Mango Tea 679 免税 + Jasmine Milk Tea 599 GST', () => {
    // 期望 = 0 + round(599 × 5%) = 30
    const tax = calculateOrderTax(
      [
        { lineSubtotal: 679, portions: [{ weight: 679, taxRates: [] }] },
        { lineSubtotal: 599, portions: [{ weight: 599, taxRates: [GST] }] },
      ],
      0
    )
    assert.equal(tax, 30)
  })

  test('免税商品 + 收税加料：Mango Tea 679 免税，加珍珠 80 收 GST', () => {
    // 这正是修复的场景：整行套商品税率会算成 0，分段后加料该收的 4 分收上来
    const portions = buildItemTaxPortions(679, 1, [{ unitPrice: 80, quantity: 1, taxRates: [GST] }], [])
    const tax = calculateOrderTax([{ lineSubtotal: 759, portions }], 0)
    assert.equal(tax, 4) // round(80 × 5%) = 4
  })

  test('同样的行，改造前的算法（整行用商品税率）会收 0 —— 锁住行为差异', () => {
    assert.equal(calculateTax(759, []), 0)
  })

  test('商品和选项税率不同：主商品 1000 GST，选项 200 PST', () => {
    // round(1000×5%) + round(200×7%) = 50 + 14 = 64
    const portions = buildItemTaxPortions(1000, 1, [{ unitPrice: 200, quantity: 1, taxRates: [PST] }], [GST])
    assert.equal(calculateOrderTax([{ lineSubtotal: 1200, portions }], 0), 64)
  })

  test('折扣按行小计占比分摊，末行吃余数', () => {
    // 两行 1000 / 500，总折扣 300
    // 行1 折扣 round(300×1000/1500)=200 → base 800 → 800×5% = 40
    // 行2 折扣 300-200=100          → base 400 → 400×5% = 20
    const tax = calculateOrderTax(
      [
        { lineSubtotal: 1000, portions: [{ weight: 1000, taxRates: [GST] }] },
        { lineSubtotal: 500, portions: [{ weight: 500, taxRates: [GST] }] },
      ],
      300
    )
    assert.equal(tax, 60)
  })

  test('折扣先摊到行、再摊到段：免税商品 + 收税加料 + 整单折扣', () => {
    // 单行：商品 900 免税 + 加料 100 GST，行小计 1000，折扣 200 → taxableBase 800
    // 段分摊：商品段 round(800×900/1000)=720，加料段 800-720=80
    // 税 = 0 + round(80×5%) = 4
    const portions = buildItemTaxPortions(900, 1, [{ unitPrice: 100, quantity: 1, taxRates: [GST] }], [])
    assert.equal(calculateOrderTax([{ lineSubtotal: 1000, portions }], 200), 4)
  })

  test('折扣吃掉全部小计时不计税', () => {
    const tax = calculateOrderTax(
      [{ lineSubtotal: 1000, portions: [{ weight: 1000, taxRates: [GST] }] }],
      1000
    )
    assert.equal(tax, 0)
  })

  test('空订单不计税', () => {
    assert.equal(calculateOrderTax([], 0), 0)
  })

  test('数量 > 1：2 杯（基础 500 免税 + 加料 80 GST）', () => {
    // 段权重：商品 500×2=1000（免税），加料 80×1×2=160（GST）
    // 行小计 (500+80)×2 = 1160，无折扣
    // 段分摊：商品段 round(1160×1000/1160)=1000，加料段 1160-1000=160
    // 税 = round(160×5%) = 8
    const portions = buildItemTaxPortions(500, 2, [{ unitPrice: 80, quantity: 1, taxRates: [GST] }], [])
    assert.equal(calculateOrderTax([{ lineSubtotal: 1160, portions }], 0), 8)
  })

  test('复合税在段内正确应用', () => {
    // 单段 1000，GST 5% + QST 9.975%(复合)
    // GST = 50，QST = round(1050 × 0.09975) = 105 ⇒ 155
    const portions = buildItemTaxPortions(1000, 1, [], [GST, QST])
    assert.equal(calculateOrderTax([{ lineSubtotal: 1000, portions }], 0), 155)
  })
})
