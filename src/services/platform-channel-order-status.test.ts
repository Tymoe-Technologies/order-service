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

/**
 * 抠出建单状态的判定链（`let initialStatus` 到那个 if-else 结束）。
 *
 * 实现形式换过一次：原来是 create 里的一个三元表达式
 * `status: data.isScheduled ? ... : (isPlatformCollect ? 'COMPLETED' : 'PENDING')`，
 * 加上挂账那一档之后三元套不下，抽成了独立的 if-else 链。
 */
function statusDecision(): string {
  // 收尾锚在 else 分支的 'PENDING' 上：非贪婪匹配到第一个 `}` 的话，
  // 只会抠到 if 的第一个分支（第一版就是这么失败的）
  const m = src.match(/let initialStatus:[\s\S]*?initialStatus = 'PENDING';\s*\n\s*\}/)
  assert.ok(m, '找不到建单状态的判定链（正则可能失效了）')
  return m![0]
}

describe('建单即 PAID 的单不能落 PENDING', () => {
  test('平台代收单落 COMPLETED', () => {
    assert.match(
      statusDecision(), /isPlatformCollect\)\s*\{\s*initialStatus = 'COMPLETED'/,
      '平台代收单必须建单即 COMPLETED —— 它等不到支付回调，落 PENDING 就是永久卡死',
    )
  })

  test('落 COMPLETED 的同时写 completedAt', () => {
    assert.match(
      src, /completedAt: initialStatus === 'COMPLETED' \? new Date\(\) : null/,
      'status 写了 COMPLETED 却不写 completedAt，报表和对账会拿到空的完成时间',
    )
  })

  /*
    这条原来断言的是**反面**：「挂账不跟着落 COMPLETED」，依据是源码注释里
    那句「它有独立的结算接口会写 CONFIRMED」。

    那个机制**不存在**。markOrdersCreditSettled 只写 creditSettledAt，
    全仓搜过 CONFIRMED，没有任何地方把记账单推出 PENDING —— 于是记账单
    和平台单犯的是同一个病（建单即 PAID → 等不到支付回调 → 永久「待确认」），
    上次修 platformCollect 时漏了它，而这条测试还在替那个错误前提站岗。
  */
  test('挂账单也不能落 PENDING —— 它同样等不到支付回调', () => {
    const d = statusDecision()
    assert.match(d, /isAccountPayment/, '判定链里必须认得挂账单')
    assert.doesNotMatch(
      d.match(/isAccountPayment\)\s*\{[\s\S]*?\} else \{/)?.[0] ?? '',
      /'PENDING'/,
      '挂账单落 PENDING 就是永久卡死 —— 没有任何代码会推进它',
    )
  })

  test('挂账单按叫号屏配置分流（和现金单支付成功后同一套语义）', () => {
    assert.match(
      statusDecision(),
      /queueDisplayEnabled \? 'CONFIRMED' : 'COMPLETED'/,
      '挂账单业务上还要备餐：叫号屏开着就进队列等叫号，关着才支付即完成',
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
