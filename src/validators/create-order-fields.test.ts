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
 *
 * ## items[] 里的字段是同一个坑的盲区
 * 上面两次都发生在**顶层**字段，所以最早只比对了顶层。但 `items[]` 里的
 * 嵌套 Joi.object() 一样不允许未知键 —— 耗材行的 isSupply / supplyOrigin
 * 就长在那里。所以下面把行内字段也比一遍，另外直接拿 schema 跑一次真校验：
 * 源码比对只能证明「名字都在」，跑一次才证明「这个请求真的能过」。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createOrderSchema } from './order.validator'

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

/** 抠出 CreateOrderItem（items[] 每一行）的字段名 */
function createOrderItemFields(): string[] {
  const m = orderService.match(/interface CreateOrderItem \{([\s\S]*?)\n\}/)
  assert.ok(m, '找不到 CreateOrderItem（正则可能失效了）')
  const body = m![1]
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
  const fields: string[] = []
  let depth = 0
  for (const line of body.split('\n')) {
    if (depth === 0) {
      const f = line.match(/^\s*(\w+)\??\s*:/)
      if (f) fields.push(f[1])
    }
    depth += (line.match(/[{[]/g) || []).length - (line.match(/[}\]]/g) || []).length
  }
  return fields
}

/** 抠出 validator 里 items[] 那个 Joi.object 声明的键 */
function validatorItemFields(): string[] {
  const m = validator.match(/items: Joi\.array\(\)\s*\n\s*\.items\(\s*\n\s*Joi\.object\(\{([\s\S]*?)\n\s{6}\}\)/)
  assert.ok(m, '找不到 items[] 的 Joi.object（正则可能失效了）')
  const body = m![1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const fields: string[] = []
  let depth = 0
  for (const line of body.split('\n')) {
    if (depth === 0) {
      const f = line.match(/^\s{8}(\w+)\s*:/)
      if (f) fields.push(f[1])
    }
    depth += (line.match(/[{[(]/g) || []).length - (line.match(/[}\])]/g) || []).length
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

  test('CreateOrderItem 的每个字段都在 items[] 里放行', () => {
    const data = createOrderItemFields()
    const allowed = new Set(validatorItemFields())
    assert.ok(data.length > 5, `CreateOrderItem 只抠到 ${data.length} 个字段，正则大概失效了`)

    const missing = data.filter(f => !allowed.has(f))
    assert.deepEqual(
      missing, [],
      `items[] 里这些字段服务层收得下、但 validator 会拒：${missing.join(', ')}`,
    )
  })

  /*
    源码比对只证明「名字都在」。真跑一次才证明这个请求能过 ——
    比如 supplyOrigin 的 valid() 值写错了，名字比对照样是绿的。
  */
  test('带耗材行的建单请求真的能通过校验', () => {
    const { error } = createOrderSchema.validate({
      orderType: 'TAKEOUT',
      items: [
        { itemId: '11111111-1111-4111-8111-111111111111', itemName: '招牌炒饭',
          quantity: 1, unitPrice: 1280 },
        // 耗材行：itemId 是 catalog_supplies.id
        { itemId: '22222222-2222-4222-8222-222222222222', itemName: 'Bag',
          quantity: 1, unitPrice: 25, isSupply: true, supplyOrigin: 'auto' },
      ],
    }, { abortEarly: false })
    assert.equal(error, undefined,
      `带耗材行的请求被拒了：${error?.details.map(d => d.message).join('; ')}`)
  })

  /*
    套餐行同理，而且后果更重：这是**收了钱之后**的建单请求，被 400 掉
    就是一笔已收款的单落不了库（POS 会当成网络失败进离线队列，然后一直补传一直被拒）。
    2026-09-17 之前这两个字段根本没人发，所以这条测试是新逻辑的唯一守门人。
  */
  test('带套餐行（含逐子项选项）的建单请求真的能通过校验', () => {
    const { error } = createOrderSchema.validate({
      orderType: 'TAKEOUT',
      items: [
        // 套餐行：itemId 是 catalog_combos.id，不在 catalog_items 里
        {
          itemId: '33333333-3333-4333-8333-333333333333',
          itemName: '双人下午茶',
          quantity: 1,
          unitPrice: 2050,
          comboId: '33333333-3333-4333-8333-333333333333',
          comboSelections: [
            {
              itemId: '44444444-4444-4444-8444-444444444444',
              itemName: 'Mango Tea',
              quantity: 1,
              additionalPrice: 0,
            },
            {
              itemId: '55555555-5555-4555-8555-555555555555',
              itemName: 'Black Milk Tea',
              quantity: 2,
              additionalPrice: 550,
              // POS 支持逐子项定制 —— 少了这一段厨房单上的饮品会做错
              modifiers: [{
                groupId: '66666666-6666-4666-8666-666666666666',
                optionId: '77777777-7777-4777-8777-777777777777',
                groupName: '糖度',
                optionName: '少糖',
                optionCode: 'LS',
                unitPrice: 0,
                quantity: 1,
              }],
            },
          ],
        },
      ],
    }, { abortEarly: false })
    assert.equal(error, undefined,
      `带套餐行的请求被拒了：${error?.details.map(d => d.message).join('; ')}`)
  })

  test('顾客端那种「只选子项、不带 modifiers」的套餐行也放行', () => {
    const { error } = createOrderSchema.validate({
      orderType: 'TAKEOUT',
      items: [{
        itemId: '33333333-3333-4333-8333-333333333333',
        itemName: '双人下午茶', quantity: 1, unitPrice: 2000,
        comboId: '33333333-3333-4333-8333-333333333333',
        comboSelections: [{
          itemId: '44444444-4444-4444-8444-444444444444',
          itemName: 'Mango Tea', quantity: 1, additionalPrice: 0,
        }],
      }],
    }, { abortEarly: false })
    assert.equal(error, undefined,
      `不带 modifiers 的套餐行被拒了：${error?.details.map(d => d.message).join('; ')}`)
  })

  test('supplyOrigin 两个取值都放行（auto = 规则加的，selected = 员工加的）', () => {
    for (const origin of ['auto', 'selected']) {
      const { error } = createOrderSchema.validate({
        orderType: 'TAKEOUT',
        items: [{ itemId: '22222222-2222-4222-8222-222222222222', itemName: 'Bag',
                  quantity: 1, unitPrice: 25, isSupply: true, supplyOrigin: origin }],
      }, { abortEarly: false })
      assert.equal(error, undefined, `supplyOrigin='${origin}' 被拒了`)
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
