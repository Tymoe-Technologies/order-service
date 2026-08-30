/**
 * 耗材行必须写 lineKind=SUPPLY —— 两条建单路径都要写。
 *
 * ## 出过什么事
 * 耗材（餐具 / 购物袋 / 打包费）原来只有 Web 那条路
 * （createTemporaryOrderFromSnapshot）会落 lineKind=SUPPLY，POS 那条
 * （createOrderInner 里「可信入口」那个 map）压根没有这两个字段。
 *
 * 后果不是「少显示一行」：商家配的 AUTO 规则（实测库里就有一条 —— Bag $0.25，
 * 命中全部订单类型、不限渠道）在 Web 单上收得到，POS 单上一分收不到。
 * 每单少收，而且两个渠道的账目口径不一致。
 *
 * ## 为什么 lineKind 本身要钉住
 * 它是「报表按商品统计」的过滤依据（`WHERE line_kind = 'PRODUCT'`）。
 * 漏写的话打包袋会混进热销榜 —— 而且它每单都卖，会直接冲到第一名。
 *
 * itemId 存的是 catalog_supplies.id 而不是 catalog_items.id，两张表的 id
 * 互不相干，全靠 lineKind 区分。这也是为什么它不能靠「查不到商品」来推断。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = readFileSync(join(__dirname, 'order.service.ts'), 'utf8')
/* 「不该出现 X」的断言用剥了注释的版本 —— 注释里解释这个坑时会写出字段名本身 */
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

/** 抠出「可信入口」（POS/KIOSK）那条构造 orderItems 的 map */
function posItemMap(): string {
  const m = code.match(/orderItems = data\.items\.map\(\(item\) => \{[\s\S]*?\n        \}\);/)
  assert.ok(m, '找不到 POS 建单的 orderItems 构造（正则可能失效了）')
  return m![0]
}

/** 抠出 Web 快照那条 */
function snapshotItemMap(): string {
  const m = code.match(/isSupply && \{[\s\S]{0,200}?\}\),/g)
  assert.ok(m && m.length >= 2,
    `只找到 ${m?.length ?? 0} 处 isSupply 分支，两条建单路径应该各有一处`)
  return m!.join('\n')
}

describe('耗材行落库', () => {
  test('POS 建单会写 lineKind=SUPPLY', () => {
    const body = posItemMap()
    assert.match(body, /isSupply && \{/,
      'POS 那条路径没有耗材分支 —— 商家配的 AUTO 规则在 POS 上收不到钱')
    assert.match(body, /lineKind: 'SUPPLY'/)
  })

  test('POS 建单会写 supplyOrigin（区分规则加的和员工加的）', () => {
    assert.match(posItemMap(), /supplyOrigin: item\.supplyOrigin/)
  })

  test('两条建单路径都有耗材分支（Web 快照 + POS）', () => {
    snapshotItemMap()   // 找不到两处就在这里断言失败
  })

  /*
    lineKind 不写就是 PRODUCT（schema 的 @default）。所以「漏写」不会报错，
    只会让耗材悄悄变成商品 —— 这条钉住默认值还在，它是上面几条的前提。
  */
  test('lineKind 的默认值仍是 PRODUCT（漏写时的兜底语义）', () => {
    const schema = readFileSync(
      join(__dirname, '..', '..', 'shared', 'database', 'schema-order.prisma'), 'utf8')
    assert.match(schema, /lineKind\s+OrderLineKind @default\(PRODUCT\)/)
    assert.match(schema, /enum OrderLineKind \{[\s\S]*?PRODUCT[\s\S]*?SUPPLY[\s\S]*?\}/)
  })

  /*
    报表的「按商品」靠 lineKind 过滤。这条和上面是一根链子上的两头：
    落库写对了、查询不过滤，或者反过来，结果都是打包袋进热销榜。
  */
  test('报表按商品统计仍然过滤掉耗材行', () => {
    const internal = readFileSync(join(__dirname, '..', 'routes', 'internal.ts'), 'utf8')
    assert.match(internal, /line_kind = 'PRODUCT'/,
      'top-items 不再过滤 line_kind —— 每单都卖的打包袋会冲到热销榜第一名')
  })
})
