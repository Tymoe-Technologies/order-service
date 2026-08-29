/**
 * 履约方式的「覆盖度」回归测试
 *
 * 起因：CURBSIDE / DRIVE_THRU 加进 OrderType 枚举后，checkout-snapshot.controller
 * 的校验白名单仍是 ['TAKEOUT','DINE_IN','DELIVERY'] 写死的字面量，导致顾客选了
 * 路边取餐提交直接 400 —— 商家在 Portal 能配、顾客端能选，就是下不了单。
 *
 * 这类 bug 的特点是：单测和端到端都不容易撞上（前者不跑 controller，
 * 后者要 mock 一堆外部服务），但对用户是完全阻断的。所以这里直接扫源码，
 * 确保没有任何地方把履约方式硬编码成一个不完整的子集。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { FULFILLMENT_TYPES } from './fulfillment-option.service'

const SRC = join(__dirname, '..')

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return walk(p)
    return p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : []
  })
}

describe('履约方式没有被硬编码成不完整的子集', () => {
  test('源码里不存在只列三种老方式的字面量数组', () => {
    // 这些形式都曾经出现过，且都导致新方式被拒
    const badPatterns = [
      /\[\s*'DINE_IN',\s*'TAKEOUT',\s*'DELIVERY'\s*\]/,
      /\[\s*'TAKEOUT',\s*'DINE_IN',\s*'DELIVERY'\s*\]/,
      /valid\(\s*'DINE_IN',\s*'TAKEOUT',\s*'DELIVERY'\s*\)/,
    ]

    const offenders: string[] = []
    for (const file of walk(SRC)) {
      const src = readFileSync(file, 'utf8')
      if (badPatterns.some(re => re.test(src))) {
        offenders.push(file.replace(SRC, 'src'))
      }
    }

    assert.deepEqual(
      offenders, [],
      `这些文件把履约方式写死成三种，新增的 CURBSIDE/DRIVE_THRU 会被拒：\n  ${offenders.join('\n  ')}\n` +
      `请改用 FULFILLMENT_TYPES 常量。`
    )
  })

  test('下单校验用的是共享常量，不是就地字面量', () => {
    const controller = readFileSync(join(SRC, 'controllers/checkout-snapshot.controller.ts'), 'utf8')
    assert.ok(
      /FULFILLMENT_TYPES\.includes\(orderType\)/.test(controller),
      'checkout-snapshot.controller 应该用 FULFILLMENT_TYPES 校验 orderType',
    )
  })

  test('POS 下单校验放行全部五种', () => {
    const validator = readFileSync(join(SRC, 'validators/order.validator.ts'), 'utf8')
    for (const type of FULFILLMENT_TYPES) {
      assert.ok(
        validator.includes(`'${type}'`),
        `order.validator 的 orderType 白名单缺少 ${type}`,
      )
    }
  })
})

describe('FULFILLMENT_TYPES 与数据库枚举一致', () => {
  test('五种履约方式齐全，且不含 GIFT_CARD', () => {
    assert.deepEqual(
      [...FULFILLMENT_TYPES].sort(),
      ['CURBSIDE', 'DELIVERY', 'DINE_IN', 'DRIVE_THRU', 'TAKEOUT'],
    )
    assert.ok(!(FULFILLMENT_TYPES as readonly string[]).includes('GIFT_CARD'),
      'GIFT_CARD 是订单性质不是履约方式，不该出现在门店配置里')
  })

  test('schema 里的 OrderType 枚举包含全部履约方式', () => {
    const schema = readFileSync(
      join(SRC, '../shared/database/schema-order.prisma'), 'utf8',
    )
    const m = schema.match(/enum OrderType \{([\s\S]*?)\}/)
    assert.ok(m, '找不到 OrderType 枚举')
    const inSchema = m![1].split('\n').map(l => l.split('//')[0].trim()).filter(Boolean)
    for (const type of FULFILLMENT_TYPES) {
      assert.ok(inSchema.includes(type), `schema 的 OrderType 缺少 ${type}`)
    }
  })
})
