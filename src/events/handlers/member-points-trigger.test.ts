/**
 * 会员积分在**什么时候**入账。
 *
 * ## 这条为什么值得钉
 * 原来 POS 单要等 ORDER_COMPLETED 才加积分，而那依赖一个隐含假设：
 * POS 单支付成功会自动完成。autoComplete 的条件是**叫号屏关着** ——
 * 商家 2026-08-29 打开叫号屏后，POS 单全部停在 CONFIRMED，
 * 会员消费再也不计积分（生产库实证：最后一次入账 08-23，
 * 而 09-12 两笔带会员的 POS 单都是 CONFIRMED）。
 *
 * 积分记的是顾客花了多少钱，和这单做没做完无关 —— 所以判据是支付成功。
 * 这里钉的就是「判据里不能再出现来源/状态的耦合」。
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = readFileSync(join(__dirname, 'member.handler.ts'), 'utf8')
const paidBranch = src.slice(src.indexOf("bus.on('ORDER_PAID'"), src.indexOf("bus.on('ORDER_COMPLETED'"))

describe('积分入账时机', () => {
  /*
    最关键的一条：ORDER_PAID 里不能再按 clientOrigin 把 POS 挡掉。
    一旦挡掉，POS 单就只能靠 ORDER_COMPLETED，而那条路取决于门店
    怎么配叫号屏 —— 配置项不该决定积分发不发。
  */
  test('ORDER_PAID 不按来源过滤', () => {
    assert.doesNotMatch(paidBranch, /clientOrigin\s*!==\s*'WEB'/)
    assert.doesNotMatch(paidBranch, /clientOrigin\s*===\s*'WEB'\s*\)\s*return/)
  })

  test('记账单仍然不计积分', () => {
    // 挂账是「还没给钱」，给积分等于先发货再收款
    assert.match(paidBranch, /paymentMethod === 'ACCOUNT'\) return/)
  })

  test('没有会员或没有金额时不调接口', () => {
    assert.match(paidBranch, /!e\.memberId\) return/)
    assert.match(paidBranch, /!e\.subtotal\) return/)
  })

  /*
    积分基数 = 税前小计 − 普通折扣 − 渠道折扣。
    按总额（含税含小费）算会让顾客替税和小费也挣到分。
  */
  test('按折后税前金额算，不含税不含小费', () => {
    assert.match(paidBranch, /e\.subtotal - \(e\.discountAmount \?\? 0\) - \(e\.channelDiscountAmount \?\? 0\)/)
  })

  test('来源按下单端分（member-service 用它区分线上单和店员代下单）', () => {
    assert.match(paidBranch, /e\.clientOrigin === 'WEB' \? 'ONLINE_ORDER' : 'STAFF_APP'/)
  })

  /*
    ORDER_COMPLETED 那支留着当兜底，靠 member-service 按 orderId 幂等
    （points.service.ts 注释里写明了）。删掉它本身不算错，
    但删之前要知道存量单和「先完成后补付款」那种异常顺序就没人管了。
  */
  test('ORDER_COMPLETED 兜底还在', () => {
    assert.match(src, /bus\.on\('ORDER_COMPLETED'/)
  })
})
