/**
 * 两个「超时自动完成」的定时任务都不能碰没收齐钱的单。
 *
 * 组合支付收到一半中断（PARTIALLY_PAID）的单照样会被推到 READY ——
 * 餐做好了是一回事，钱收没收齐是另一回事。自动 COMPLETED 等于把一张欠款单
 * 悄悄归档：订单管理里那颗「继续收款」只对非终态单出现，
 * 单一完成就再也收不回来了。
 *
 * 钉在源码上是因为这两处是**两份各自独立的 where**，很容易只改一边
 * （这次就是先只发现了 READY 那条）。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = readFileSync(join(__dirname, 'order.service.ts'), 'utf8')

/** 抠出某个方法里第一个 findMany 的 where */
function whereOf(method: string): string {
  const body = src.slice(src.indexOf(`async ${method}(`))
  const m = body.match(/findMany\(\{\s*where:\s*\{[\s\S]*?\n      \},/)
  assert.ok(m, `找不到 ${method} 的查询条件`)
  return m![0]
}

describe('超时自动完成', () => {
  for (const method of ['autoCompleteOverdueReady', 'autoCompleteOverdueScheduled']) {
    test(`${method} 只碰已付清的单`, () => {
      assert.match(whereOf(method), /paymentStatus: 'PAID'/,
        `${method} 会把欠款单自动完成，「继续收款」就再也点不到了`)
    })
  }

  /* 白名单那条也一起钉住：DELIVERY/CURBSIDE 顾客不在店里，
     自动完成会变成「系统显示已完成、餐还没送出去」 */
  test('READY 超时只对店内自取（DINE_IN / TAKEOUT）', () => {
    assert.match(whereOf('autoCompleteOverdueReady'), /orderType: \{ in: \[\.\.\.IN_STORE_PICKUP_TYPES\] \}/)
  })
})
