/**
 * 订单的税种明细快照。
 *
 * 加拿大申报要按税种分别填（GST 5% / PST 7%，或 HST 一档），
 * 而订单原来只落一个 `taxAmount` 合计 —— 日结单没法拆，
 * 店主只能自己按比例倒推，倒推出来的数和逐行四舍五入的真实值对不上。
 *
 * POS 一直算得出这份明细（utils/taxCalculation 的 taxBreakdown），
 * 这里只负责**把它验干净再落库**。
 */

export interface TaxLine {
  /** 税种名，如 GST / PST / HST。商家自己配的，会重名也会改，只作展示 */
  name: string;
  /** 税率，小数（0.05 = 5%）。存下来是因为税率会调，历史单要保持当时的样子 */
  rate: number;
  /** 该税种的税额（分） */
  amount: number;
}

/**
 * 验并规整税种明细。**加不平就返回 null。**
 *
 * 为什么宁可丢掉也不存半份：日结单上一组自己加不平的税额比没有更糟 ——
 * 店主会拿它去申报。退回「只印一个合计」至少是对的。
 *
 * 允许 1 分的误差：各税种是逐行四舍五入后再相加的（见 POS 的
 * taxCalculation），和订单总税额之间本来就可能差一分钱。
 */
export function sanitizeTaxLines(input: unknown, taxAmount: number): TaxLine[] | null {
  if (!Array.isArray(input) || input.length === 0) return null;

  const lines: TaxLine[] = [];
  for (const raw of input) {
    const name = typeof raw?.name === 'string' ? raw.name.trim().slice(0, 40) : '';
    const rate = Number(raw?.rate);
    const amount = Math.round(Number(raw?.amount));
    // 名字为空 / 金额不是数 = 这份数据不可信，整份丢掉而不是跳过这一行：
    // 跳过会让剩下的加不平，然后被下面的校验丢掉，结果一样但更难查
    if (!name || !Number.isFinite(rate) || !Number.isFinite(amount)) return null;
    if (amount < 0) return null;
    lines.push({ name, rate, amount });
  }

  const sum = lines.reduce((a, l) => a + l.amount, 0);
  if (Math.abs(sum - taxAmount) > 1) return null;

  return lines;
}

/**
 * 把多张订单的税种明细汇总成报表用的形状。
 *
 * 按**税种名**归并（不按税率）：同一个税种在区间内税率可能被调过，
 * 分成两行会让店主以为多了一种税。税率取金额最大那一档 —— 展示用，
 * 申报填的是金额。
 *
 * `complete` = 这个区间里**每一张**有税的订单都带明细。
 * 只要有一张没有（存量订单、或校验没过），拆出来的和就小于总税额 ——
 * 那时日结单必须退回只印合计，不能印一组不完整的拆分。
 */
export function aggregateTaxLines(
  orders: Array<{ taxAmount: number; taxLines: unknown }>,
): { lines: TaxLine[]; complete: boolean } {
  const byName = new Map<string, { rate: number; amount: number; weight: number }>();
  let covered = 0;
  let totalTax = 0;

  for (const o of orders) {
    totalTax += o.taxAmount;
    const ls = Array.isArray(o.taxLines) ? (o.taxLines as TaxLine[]) : null;
    if (!ls) continue;
    covered += o.taxAmount;
    for (const l of ls) {
      const cur = byName.get(l.name);
      if (!cur) byName.set(l.name, { rate: l.rate, amount: l.amount, weight: l.amount });
      else {
        cur.amount += l.amount;
        // 税率取金额最大那一档（区间内税率被调过时）
        if (l.amount > cur.weight) { cur.rate = l.rate; cur.weight = l.amount; }
      }
    }
  }

  const lines = [...byName.entries()]
    .map(([name, v]) => ({ name, rate: v.rate, amount: v.amount }))
    .filter((l) => l.amount > 0)
    // 金额大的在前：读的人先看到占比最大的税种
    .sort((a, b) => b.amount - a.amount);

  return { lines, complete: lines.length > 0 && Math.abs(covered - totalTax) <= 1 };
}

/**
 * 验并规整**行级**税种明细（order_items.tax_lines）。
 *
 * 判据只有一条：所有行的明细加起来必须等于订单头的税额（容 1 分）。
 * 对不上就**整单**退回 null —— 不是只丢有问题的那一行。
 * 留半份的后果是：拿行级明细做部分退款时，剩下那些行看着是齐的，
 * 退出来的税却少一块，而且没有任何迹象。
 *
 * 无税的行（免税耗材）本来就没有明细，传 null / 空数组即可 ——
 * 它们不参与求和，所以不会把校验带偏。
 *
 * ⚠️ 只在 order-service 用，finance 那份副本不需要这个函数。
 */
export function sanitizeItemTaxLines(
  itemLines: Array<unknown>,
  orderTaxAmount: number,
): Array<TaxLine[] | null> {
  const cleaned = itemLines.map((raw) => {
    if (!Array.isArray(raw) || raw.length === 0) return null;
    // 用这一行自身之和当基准 = 只做形状校验（名字、数值、非负）
    const selfSum = raw.reduce((a: number, l: any) => a + Math.round(Number(l?.amount) || 0), 0);
    return sanitizeTaxLines(raw, selfSum);
  });

  const total = cleaned.reduce(
    (a, ls) => a + (ls ?? []).reduce((b, l) => b + l.amount, 0),
    0,
  );
  if (cleaned.every((l) => l === null)) return cleaned;      // 一行都没有：本来就没明细
  if (Math.abs(total - orderTaxAmount) > 1) return itemLines.map(() => null);

  return cleaned;
}
