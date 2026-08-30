/**
 * 「谁负责配送」的回归测试。
 *
 * ## 修的是什么
 * `orderType` 回答的是「怎么交到顾客手上」（顾客视角的标准履约类型），
 * 而配送相关的代码想问的其实是「**本店要不要安排骑手**」—— 两者不是一回事。
 * 拿前者当后者用，出过实事：
 *
 *   Uber Eats 平台单也是 `DELIVERY`，且建单即 `PAID`、`deliveryConfirmedAt`
 *   永远为 null（那是 Uber Direct 专用字段）—— 于是
 *   delivery-confirmation-watchdog 的三个条件全中，把平台单当成
 *   「超时未确认的配送订单」持续报警。
 *
 * 更险的一处是 delivery.handler：它在 ORDER_PAID 时去 uber-service 下配送单。
 * 平台单没被误触发，只是因为后面那道 `!deliveryAddress` 恰好挡住了 ——
 * 靠次要条件兜住主要判断，是运气不是设计。
 *
 * ## 修法
 * 不给 Uber Direct 单换一个更专有的 orderType（那会把「谁来送」编码进
 * 「怎么交付」，是同一种维度混淆），而是加一个正交的 `deliveryProvider`：
 *   MERCHANT = 本店负责（经 Uber Direct 履约）
 *   PLATFORM = 外卖平台负责，本店只出餐
 * Square Orders API / Olo 也都是 type=DELIVERY + 单独的 courier/provider 字段。
 *
 * ## 为什么钉在源码上
 * 这些判断散在 job、事件处理器、状态机三处独立的代码路径里，很容易只改一边。
 * 下面每条断言对应一个「改回去就会复发」的不变量。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8')
const orderService = read('services/order.service.ts')
const watchdog = read('jobs/delivery-confirmation-watchdog.ts')
const autoConfirm = read('jobs/auto-delivery-confirmation.ts')
const deliveryHandler = read('events/handlers/delivery.handler.ts')
const confirmService = read('services/delivery-confirmation.service.ts')
const statusService = read('services/order-status.service.ts')
const internalRoutes = read('routes/internal.ts')
const schema = readFileSync(
  join(__dirname, '..', '..', 'shared', 'database', 'schema-order.prisma'), 'utf8')

describe('schema：deliveryProvider 是独立维度', () => {
  test('枚举存在且只有 MERCHANT / PLATFORM 两个值', () => {
    const m = schema.match(/enum DeliveryProvider \{([\s\S]*?)\}/)
    assert.ok(m, '找不到 DeliveryProvider 枚举')
    const values = m![1].split('\n')
      .map(l => l.replace(/\/\/.*|\/\/\/.*/, '').trim())
      .filter(l => l && !l.startsWith('/'))
    assert.deepEqual(values.sort(), ['MERCHANT', 'PLATFORM'])
  })

  test('Order 上有 deliveryProvider 字段', () => {
    assert.match(schema, /deliveryProvider\s+DeliveryProvider\?\s+@map\("delivery_provider"\)/)
  })

  test('OrderType 没有为 Uber Direct 单加专有值', () => {
    const m = schema.match(/enum OrderType \{([\s\S]*?)\}/)!
    const values = m[1].split('\n')
      .map(l => l.replace(/\/\/.*/, '').trim()).filter(Boolean)
    // 「谁来送」属于 deliveryProvider，不该在这里冒出 SELF_DELIVERY 之类
    for (const v of values) {
      assert.ok(
        !/SELF_|MERCHANT_|PLATFORM_|UBER/.test(v),
        `OrderType 里出现了描述「谁来送」的值 ${v} —— 那是 deliveryProvider 的职责`,
      )
    }
  })

  test('job 扫描的索引带上了 deliveryProvider', () => {
    assert.match(
      schema,
      /@@index\(\[deliveryProvider, orderType, deliveryConfirmedAt, deliveryConfirmDeadlineAt\]\)/,
      '两个 job 现在按 deliveryProvider 过滤，索引不跟上就会全表扫',
    )
  })
})

describe('建单时必须落 deliveryProvider', () => {
  test('通用建单：DELIVERY 才有值，缺省 MERCHANT', () => {
    assert.match(
      orderService,
      /deliveryProvider:\s*data\.orderType === 'DELIVERY'[\s\S]{0,80}data\.deliveryProvider \?\? 'MERCHANT'/,
      '本店渠道下的配送单默认自己安排骑手；非配送单必须落 null',
    )
  })

  test('Web checkout 快照建单：本店自配送', () => {
    assert.match(
      orderService,
      /deliveryProvider:\s*snapshot\.orderType === 'DELIVERY' \? 'MERCHANT' : null/,
    )
  })

  test('Uber Eats API 单：PLATFORM（这条是那个 bug 的正面修复）', () => {
    const seg = internalRoutes.match(/orderSource: 'UBER_EATS',[\s\S]{0,200}/)
    assert.ok(seg, '找不到 Uber Eats 建单段')
    assert.match(
      internalRoutes,
      /deliveryProvider: 'PLATFORM',\s*\n\s*orderSource: 'UBER_EATS',/,
      'Uber Eats 单不标 PLATFORM 的话，watchdog 会一直把它当超时未确认的配送单报警',
    )
  })
})

describe('配送流程只对本店自配送单触发', () => {
  const cases: Array<[string, string, string]> = [
    ['watchdog（超时报警）', watchdog, "deliveryProvider: 'MERCHANT'"],
    ['自动接单', autoConfirm, "deliveryProvider: 'MERCHANT'"],
    ['补偿扫描（internal）', internalRoutes, "deliveryProvider: 'MERCHANT'"],
  ]
  for (const [name, src, needle] of cases) {
    test(`${name} 按 deliveryProvider 过滤`, () => {
      assert.ok(src.includes(needle), `${name} 漏了 deliveryProvider 条件，平台单会被捞进来`)
    })
  }

  test('ORDER_PAID 事件带上 deliveryProvider', () => {
    assert.match(orderService, /deliveryProvider: \(result as any\)\._meta\.deliveryProvider/)
    assert.match(orderService, /deliveryProvider: order\.deliveryProvider,/,
      '_meta 里要带上，否则事件拿不到')
  })

  test('下 Uber 配送单的入口判的是 deliveryProvider，不是 orderType', () => {
    assert.match(deliveryHandler, /e\.deliveryProvider !== 'MERCHANT'/)
    assert.ok(
      !/e\.orderType !== 'DELIVERY'/.test(deliveryHandler),
      '还留着按 orderType 判的分支 —— 平台单支付后会去叫一个多余的 Uber Direct 骑手',
    )
  })

  test('确认接单的入口同理', () => {
    assert.match(confirmService, /order\.deliveryProvider !== 'MERCHANT'/)
  })

  test('「不许绕过接单直接改状态」的拦截同理', () => {
    for (const [name, src] of [['order-status.service', statusService],
                               ['order.service', orderService]] as const) {
      assert.match(src, /order\.deliveryProvider === 'MERCHANT' &&\s*\n\s*!order\.deliveryConfirmedAt/,
        `${name} 的拦截还在按 orderType+orderSource 判`)
    }
  })

  test('预约单释放：只有自配送单停在 PENDING 等接单', () => {
    assert.match(orderService, /deliveryDue = due\.filter\(o => o\.deliveryProvider === 'MERCHANT'\)/)
    assert.match(orderService, /otherDue = due\.filter\(o => o\.deliveryProvider !== 'MERCHANT'\)/)
  })
})

describe('不再从 orderSource 推断「是不是自配送」', () => {
  test('order.service 里没有 orderSource==WEB && orderType==DELIVERY 这种组合判据', () => {
    const code = orderService.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    assert.ok(
      !/orderSource === 'WEB' && order\.orderType === 'DELIVERY'/.test(code),
      '这个判据碰巧成立（本店渠道下单才走 Uber Direct），但表达的是「从哪下的单」'
      + '而不是「谁送」—— POS 上手工录的平台单也是 DELIVERY',
    )
  })
})
