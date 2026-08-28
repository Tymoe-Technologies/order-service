/**
 * 结账计税（后端权威实现）
 *
 * 从 checkout-snapshot.service.ts 抽出来的纯函数，不依赖 prisma / 网络，
 * 便于单测覆盖。跟 POS 前端 utils/taxCalculation.ts 是同一套算法，
 * consumer-app 结账页的预览计算也必须与这里保持一致 ——
 * 三端算不一样，顾客看到的金额就会和实扣对不上。
 *
 * 金额单位一律是**分**，全程整数运算、逐项四舍五入。
 */

export interface TaxRate {
  name: string
  rate: number
  isCompound: boolean
}

export interface TaxablePortion {
  /** 分摊权重 = 这一段的原价（未扣折扣），单位分 */
  weight: number
  taxRates: TaxRate[]
}

/** buildItemTaxPortions 需要的最小修饰符形状 */
export interface TaxableModifier {
  unitPrice: number
  quantity: number
  /** 该选项自己的税率。空数组 = 没单独配，回退到所属商品的税率 */
  taxRates: TaxRate[]
}

/**
 * 从税率关联行里提取税率。商品的 item_tax_rates 和选项的 tax_rates 是同一种形状
 * （[{ tax_rate: {...} }]，门店级覆盖已由 item service 整组替换过），共用这一个解析。
 */
export function extractTaxRatesFromRelations(rows: any): TaxRate[] {
  if (!Array.isArray(rows)) return []

  const taxRatesMap = new Map<string, TaxRate>()
  for (const row of rows) {
    // item service 返回的关联字段名是 tax_rate（兼容旧字段名 tenant_tax_rates）
    const tr = row?.tax_rate || row?.tenant_tax_rates
    if (tr && tr.id) {
      // 使用 id 作为唯一键，避免重复
      taxRatesMap.set(tr.id, {
        name: tr.name || 'Tax',
        rate: Number(tr.rate) || 0,
        isCompound: tr.is_compound || false,
      })
    }
  }
  return Array.from(taxRatesMap.values())
}

/** 从商品数据中提取税率（按「税名 + 税率」去重，多个商品合并时不会重复计） */
export function extractTaxRatesFromItems(items: any[]): TaxRate[] {
  const taxRatesMap = new Map<string, TaxRate>()
  for (const item of items) {
    for (const tr of extractTaxRatesFromRelations(item?.item_tax_rates)) {
      taxRatesMap.set(`${tr.name}|${tr.rate}`, tr)
    }
  }
  return Array.from(taxRatesMap.values())
}

/**
 * 计算一段金额的税：非复合税各自以 base 为基数，复合税以 base + 非复合税合计 为基数。
 * 没配税率则不计税。
 */
export function calculateTax(base: number, taxRates: TaxRate[]): number {
  if (!taxRates || taxRates.length === 0) return 0

  const nonCompoundTaxes = taxRates.filter(t => !t.isCompound)
  const compoundTaxes = taxRates.filter(t => t.isCompound)

  let taxAmount = 0
  for (const tax of nonCompoundTaxes) {
    taxAmount += Math.round(base * tax.rate)
  }

  const baseForCompoundTax = base + taxAmount
  for (const tax of compoundTaxes) {
    taxAmount += Math.round(baseForCompoundTax * tax.rate)
  }

  return taxAmount
}

/**
 * 分段计税：把一行的应税金额(taxableBase，已经扣完折扣分摊)按各段原价的权重分下去，
 * 每段用自己的税率算税再加总。两种场景共用：
 *
 *   普通商品行 —— 商品基础价一段 + 每个收费选项各一段（选项可以有自己的税率）
 *   套餐行     —— 套餐本身没有税率，按子项商品的标价权重分给各子项
 */
export function calculateAllocatedTax(taxableBase: number, parts: TaxablePortion[]): number {
  // 权重为 0 的段（免费选项）不参与分摊：留着会让「末段吃余数」把舍入余数塞给它，
  // 用一个不该计税的段的税率去算余数的税
  const effective = parts.filter(p => p.weight > 0)
  const totalWeight = effective.reduce((s, p) => s + p.weight, 0)
  if (totalWeight <= 0 || effective.length === 0) return 0

  let tax = 0
  let allocated = 0
  effective.forEach((part, idx) => {
    // 末段吃分摊余数，避免四舍五入误差累积/丢失
    const partBase = idx === effective.length - 1
      ? taxableBase - allocated
      : Math.round(taxableBase * part.weight / totalWeight)
    allocated += partBase
    tax += calculateTax(partBase, part.taxRates)
  })
  return tax
}

/**
 * 拼出一个普通商品行的计税分段：商品基础价一段，每个选项各一段。
 *
 * 选项没单独配税率时回退到商品税率 —— 这个回退是刻意的：绝大多数选项不会单独配税
 * （加料、换大杯跟主商品同税），把「没配」当成「免税」会直接少收税。
 * 反过来，商品自己没配税率但选项配了（例如免税饮品加收税的配料），
 * 选项段照样按自己的税率计税。
 */
export function buildItemTaxPortions(
  basePrice: number,
  quantity: number,
  modifiers: TaxableModifier[],
  itemTaxRates: TaxRate[]
): TaxablePortion[] {
  const portions: TaxablePortion[] = [
    { weight: basePrice * quantity, taxRates: itemTaxRates },
  ]
  for (const mod of modifiers) {
    portions.push({
      weight: mod.unitPrice * (mod.quantity || 1) * quantity,
      taxRates: mod.taxRates.length > 0 ? mod.taxRates : itemTaxRates,
    })
  }
  return portions
}

/**
 * 整单逐行计税：折扣按各行小计占比分摊到行（末行吃余数，保证 Σ 行折扣 = 总折扣），
 * 每行扣完折扣后再按行内分段计税。
 *
 * 为什么不能拿「税率并集 × 整单小计」：购物车里混有免税商品时会对免税商品也征税。
 */
export function calculateOrderTax(
  lines: Array<{ lineSubtotal: number; portions: TaxablePortion[] }>,
  totalDiscount: number
): number {
  const subtotal = lines.reduce((s, l) => s + l.lineSubtotal, 0)
  if (subtotal <= 0 || lines.length === 0) return 0

  let taxAmount = 0
  let allocatedDiscount = 0
  lines.forEach((line, idx) => {
    const lineDiscount = idx === lines.length - 1
      ? totalDiscount - allocatedDiscount
      : Math.round(totalDiscount * line.lineSubtotal / subtotal)
    allocatedDiscount += lineDiscount
    const taxableBase = Math.max(0, line.lineSubtotal - lineDiscount)
    taxAmount += calculateAllocatedTax(taxableBase, line.portions)
  })
  return taxAmount
}
