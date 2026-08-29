/**
 * 平台代收渠道（内置外卖）订单的建单状态回归测试
 *
 * 栽过的坑：内置外卖渠道（UBER_EATS / DOORDASH / ... ，platformType 非空）是给商家
 * 手工补录平台订单用的记账入口。这类单在 createOrder 里被直接标成 PAID
 * （isPlatformCollect），钱不经过我们的收单通道，finance 里没有对应 payment，
 * 于是**永远等不到支付回调**。
 *
 * 而 PENDING → CONFIRMED/COMPLETED 的自动推进全寄生在那个回调里
 * （updatePaymentStatus）—— 结果每一笔都永远卡在「待确认」，而且因为 POS 下单
 * orderType 写死 DINE_IN，它们还会常驻店内叫号屏。
 *
 * 建单路径和支付回调路径是两套独立的状态推进代码，很容易只改一边，
 * 所以这里把三个不变量钉死在源码上。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = readFileSync(join(__dirname, 'order.service.ts'), 'utf8')

/** 抠出建单 create 里那段 status 赋值（到 completedAt 那行为止） */
function statusAssignment(): string {
  const m = src.match(/status: data\.isScheduled[\s\S]{0,300}?completedAt:.*$/m)
  assert.ok(m, '找不到建单时的 status 赋值（正则可能失效了）')
  return m![0]
}

describe('平台代收单建单即完成', () => {
  test('status 判定认得 isPlatformCollect，落 COMPLETED 而不是 PENDING', () => {
    const s = statusAssignment()
    assert.match(
      s, /isPlatformCollect\s*\?\s*'COMPLETED'/,
      '平台代收单必须建单即 COMPLETED —— 它等不到支付回调，落 PENDING 就是永久卡死',
    )
  })

  test('落 COMPLETED 的同时写 completedAt', () => {
    const s = statusAssignment()
    assert.match(
      s, /completedAt:.*isPlatformCollect/,
      'status 写了 COMPLETED 却不写 completedAt，报表和对账会拿到空的完成时间',
    )
  })

  test('挂账（CREDIT_ACCOUNT）不跟着落 COMPLETED', () => {
    const s = statusAssignment()
    // 挂账同样建单即 PAID，但它有独立结算接口写 CONFIRMED，业务上还要备餐
    assert.doesNotMatch(
      s, /isAccountPayment/,
      '挂账单不该在建单时就完成 —— 它还要备餐，且有独立的结算接口负责推进状态',
    )
  })
})

describe('建单即完成的单要补发 ORDER_COMPLETED', () => {
  test('存在 status === COMPLETED 时的补发分支', () => {
    assert.match(
      src, /created\.status === 'COMPLETED'[\s\S]{0,400}?type: 'ORDER_COMPLETED'/,
      "member.handler 的会员积分挂在 ORDER_COMPLETED 上；只发 ORDER_CREATED 的话这类单积分永远不入账",
    )
  })

  test('补发走事务内的 enqueueEvent，不是裸 emit', () => {
    const m = src.match(/created\.status === 'COMPLETED'[\s\S]{0,400}?type: 'ORDER_COMPLETED'/)
    assert.ok(m)
    assert.match(
      m![0], /await enqueueEvent\(tx, \{/,
      '要和订单同事务（outbox），裸 eventBus.emit 在服务崩溃时会丢积分',
    )
  })
})

describe('isPlatformCollect 的判定依据没被改坏', () => {
  test('仍然由渠道配置的 platformType 决定', () => {
    const m = src.match(/const isPlatformCollect =[\s\S]{0,200}?;/)
    assert.ok(m, '找不到 isPlatformCollect 的定义')
    // 光看订单自身的 orderSource/paymentMethod 认不出这类单（orderSource 是 POS、
    // paymentMethod 可能是 CASH）—— 只有渠道配置知道它是平台代收
    assert.match(m![0], /channelConfig\?\.platformType/)
  })
})
