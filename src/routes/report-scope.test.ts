/**
 * 报表口径：算「已付款且没取消」，不是「已完成」。
 *
 * ## 出过什么事
 * 三处报表查询（daily-summary / top-items / sales-by-hour）都写死
 * `status = 'COMPLETED'`，于是**正在备餐的单不算销售额** —— 钱已经收了、
 * 税已经收了，只因为餐还没做好就不进报表。
 *
 * 实测库里两单：CONFIRMED/PAID 一单 $18.09（税 $0.86）、COMPLETED 一单 $6.99。
 * 报表显示 $6.99、税 $0.00 —— 那 $0.86 的税就是这么丢的；
 * 「按商品」也只剩 1 种（实际卖了 3 种），「按小时」同理整段缺失。
 *
 * 现象上表现为：午市高峰时报表明显偏低，收工后又突然涨上来。
 *
 * ## 口径
 * 销售额和「餐做没做好」无关，和「钱收没收」有关。这也让它和 finance 那边
 * 对上了：payments 是 `status = 'SUCCEEDED'` 就算，同样不看履约状态。
 *
 * `cancelledAt IS NULL` 而不是 `status != 'CANCELLED'`：退款流程里订单状态
 * 会先变，而取消时刻是专用字段，不会被别的流转覆盖。
 *
 * ## 为什么钉在源码上
 * 这三处是各自独立的 SQL / Prisma 查询，改一处漏两处是这次事故的原样复现。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = readFileSync(join(__dirname, 'internal.ts'), 'utf8')
/* 「不该出现 X」的断言用剥了注释的版本 —— 注释里解释来龙去脉时
   必然写出 `status = 'COMPLETED'` 这个字符串本身 */
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  .replace(/^\s*--.*$/gm, '')   // SQL 行注释

/** 抠出一个路由处理函数的函数体 */
function route(path: string): string {
  const m = code.match(new RegExp(`router\\.get\\('${path}'[\\s\\S]*?\\n\\}\\);`))
  assert.ok(m, `找不到 ${path} 的处理函数（正则可能失效了）`)
  return m![0]
}

describe('三处报表查询用同一套口径', () => {
  const cases: Array<[string, string]> = [
    ['/daily-summary', 'daily-summary（销售汇总 + 渠道分组）'],
    ['/top-items', 'top-items（按商品）'],
    ['/sales-by-hour', 'sales-by-hour（按小时）'],
  ]

  for (const [path, label] of cases) {
    test(`${label} 按「已付款」筛，不按「已完成」`, () => {
      const body = route(path)
      assert.ok(
        /payment_status = 'PAID'|paymentStatus: 'PAID'/.test(body),
        `${label} 没按 PAID 筛 —— 正在备餐的单会整个丢掉`,
      )
      assert.ok(
        !/status = 'COMPLETED'|status: 'COMPLETED'/.test(body),
        `${label} 还在按 COMPLETED 筛：钱收了、税收了，只因为餐没做好就不算销售额`,
      )
    })

    test(`${label} 排除已取消的单`, () => {
      const body = route(path)
      assert.ok(
        /cancelled_at IS NULL|cancelledAt: null/.test(body),
        `${label} 没排除取消单`,
      )
    })
  }

  /*
    退款单单独统计，不能混进销售额里。
    它按 paymentStatus='REFUNDED' 查，而销售额那边只认 'PAID' —— 天然不重叠。
  */
  test('退款仍然单独统计（不和销售额混在一起）', () => {
    const body = route('/daily-summary')
    assert.match(body, /paymentStatus: 'REFUNDED'/,
      '退款汇总不该被这次口径调整带走')
  })

  /*
    部分已付（PARTIALLY_PAID）不算：那是「收了一半还没收齐」，销售没完成。
    这条和 finance 的 payments 口径**有意不同** —— 那边按笔算，收多少算多少。
    差异可以接受，但不该无意中变成「算进来了」。
  */
  test('部分已付不计入销售额', () => {
    const body = route('/daily-summary')
    assert.ok(
      !/PARTIALLY_PAID/.test(body),
      '部分已付的单被算进销售额了 —— 那是还没收齐的钱',
    )
  })
})
