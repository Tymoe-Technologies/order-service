/**
 * 建单 validator 的字段覆盖检查。
 *
 * ## 这个坑踩过两次
 * 校验中间件跑的是 `schema.validate(req.body, { abortEarly: false })` ——
 * **没有 allowUnknown**，所以 Joi 默认把未知键当错误。后果不是「那个字段被忽略」，
 * 而是**整个请求 400**，进而整类单全废：
 *
 *   1. CURBSIDE / DRIVE_THRU 加进 OrderType 后漏改这里 —— 顾客选路边取餐直接 400
 *   2. deliveryProvider 加进 CreateOrderData 后漏改这里 —— POS 上所有外卖平台单
 *      建单失败，被当成网络故障落进离线队列（用户看到的现象是「全变离线订单」）
 *
 * 两次都不是逻辑写错，是**两份字段清单没对齐**。所以这里直接比对它们。
 *
 * ## 为什么 400 这么难发现
 * POS 建单失败会走离线队列兜底，那条路是为「网络不通」设计的 —— 它把 400
 * 也当成可重试的失败吞掉了，界面上看不出任何报错。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const validator = readFileSync(join(__dirname, 'order.validator.ts'), 'utf8')
const orderService = readFileSync(join(__dirname, '..', 'services', 'order.service.ts'), 'utf8')

/** 抠出 CreateOrderData 里的顶层字段名 */
function createOrderDataFields(): string[] {
  const m = orderService.match(/interface CreateOrderData \{([\s\S]*?)\n\}/)
  assert.ok(m, '找不到 CreateOrderData（正则可能失效了）')
  const body = m![1]
    .replace(/\/\*[\s\S]*?\*\//g, '')      // 块注释
    .replace(/^\s*\/\/.*$/gm, '')          // 行注释
  const fields: string[] = []
  let depth = 0
  for (const line of body.split('\n')) {
    // 只取顶层：嵌套对象/数组字面量里的键不算
    const opens = (line.match(/[{[]/g) || []).length
    const closes = (line.match(/[}\]]/g) || []).length
    if (depth === 0) {
      const f = line.match(/^\s*(\w+)\??\s*:/)
      if (f) fields.push(f[1])
    }
    depth += opens - closes
  }
  return fields
}

/** 抠出 createOrderSchema 顶层声明的键 */
function validatorFields(): string[] {
  const m = validator.match(/export const createOrderSchema = Joi\.object\(\{([\s\S]*)\n\}\);/)
  assert.ok(m, '找不到 createOrderSchema')
  const body = m![1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const fields: string[] = []
  let depth = 0
  for (const line of body.split('\n')) {
    if (depth === 0) {
      const f = line.match(/^\s{2}(\w+)\s*:/)
      if (f) fields.push(f[1])
    }
    depth += (line.match(/[{[(]/g) || []).length - (line.match(/[}\])]/g) || []).length
  }
  return fields
}

describe('建单 validator 的字段清单', () => {
  test('CreateOrderData 的每个字段都在 validator 里放行', () => {
    const data = createOrderDataFields()
    const allowed = new Set(validatorFields())
    assert.ok(data.length > 5, `CreateOrderData 只抠到 ${data.length} 个字段，正则大概失效了`)

    const missing = data.filter(f => !allowed.has(f))
    assert.deepEqual(
      missing, [],
      `这些字段服务层收得下、但 validator 会拒：${missing.join(', ')}\n`
      + '   Joi 默认不允许未知键（中间件没开 allowUnknown），\n'
      + '   后果不是字段被忽略，而是**整个请求 400**、那类单全废。',
    )
  })

  test('deliveryProvider 在放行名单里（这次就是漏了它）', () => {
    assert.ok(validatorFields().includes('deliveryProvider'))
    assert.match(validator, /deliveryProvider:.*valid\('MERCHANT', 'PLATFORM'\)/)
  })

  test('五种履约方式都放行（上一次踩的坑）', () => {
    for (const t of ['DINE_IN', 'TAKEOUT', 'DELIVERY', 'CURBSIDE', 'DRIVE_THRU']) {
      assert.match(validator, new RegExp(`orderType[\\s\\S]{0,200}'${t}'`),
        `orderType 少放行了 ${t}`)
    }
  })

  test('校验中间件确实不允许未知键（本测试成立的前提）', () => {
    const mw = readFileSync(join(__dirname, '..', 'middleware', 'validation.ts'), 'utf8')
    assert.ok(
      !/allowUnknown:\s*true/.test(mw),
      '中间件开了 allowUnknown —— 那上面几条断言就不必要了，可以删掉这个文件',
    )
  })
})
