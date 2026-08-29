/**
 * 结账快照 controller 的「字段透传」回归测试
 *
 * 这个 controller 是显式解构 req.body、再显式逐字段传给 service 的，
 * 所以每加一个入参都可能漏。已经栽过两次：
 *   1. orderType 白名单没加 CURBSIDE → 路边取餐单直接 400
 *   2. vehicleInfo 没列进解构 → 前端传了、service 会存、建单会搬，
 *      唯独 controller 把它丢了，一路走到底都是 null，
 *      店员在小票和订单页上什么都看不到
 *
 * 两次都是「两端改了、中间没改」，而且单测和端到端都不容易撞上。
 * 所以这里直接比对 service 的入参类型和 controller 的透传列表。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(__dirname, '..')
const controller = readFileSync(join(SRC, 'controllers/checkout-snapshot.controller.ts'), 'utf8')
const service = readFileSync(join(SRC, 'services/checkout-snapshot.service.ts'), 'utf8')

/** 从 CreateSnapshotDto 里抠出所有字段名 */
function dtoFields(): string[] {
  const m = service.match(/interface CreateSnapshotDto \{([\s\S]*?)\n\}/)
  assert.ok(m, '找不到 CreateSnapshotDto')
  return [...m![1].matchAll(/^\s{2}(\w+)\??:/gm)].map(x => x[1])
}

/** controller 解构 req.body 时列了哪些字段 */
function destructuredFields(): string[] {
  const m = controller.match(/const \{([\s\S]*?)\} = req\.body/)
  assert.ok(m, '找不到 req.body 的解构')
  return m![1].split(',').map(s => s.trim()).filter(Boolean)
}

/** controller 传给 service 的对象里列了哪些字段 */
function forwardedFields(): string[] {
  const m = controller.match(/createCheckoutSnapshot\(merchantId, \{([\s\S]*?)\n    \}\)/)
  assert.ok(m, '找不到 createCheckoutSnapshot 的调用')
  return [...m![1].matchAll(/^\s+(\w+),/gm)].map(x => x[1])
}

describe('service 需要的字段，controller 都得接住并传下去', () => {
  // customer / items 等必填项在 DTO 里，也应当在透传列表里
  const fields = dtoFields()

  test('DTO 字段被解析出来了（正则没失效）', () => {
    assert.ok(fields.length > 10, `只解析出 ${fields.length} 个字段，正则可能失效了`)
    assert.ok(fields.includes('orderType'))
    assert.ok(fields.includes('vehicleInfo'), 'CreateSnapshotDto 应该有 vehicleInfo')
  })

  test('每个 DTO 字段都在 controller 的解构列表里', () => {
    const got = destructuredFields()
    const missing = fields.filter(f => !got.includes(f))
    assert.deepEqual(
      missing, [],
      `这些字段 service 要用，但 controller 解构 req.body 时没列 —— 会被静默丢弃：\n  ${missing.join(', ')}`,
    )
  })

  test('每个 DTO 字段都真的传给了 service', () => {
    const got = forwardedFields()
    const missing = fields.filter(f => !got.includes(f))
    assert.deepEqual(
      missing, [],
      `这些字段接住了却没传下去：\n  ${missing.join(', ')}`,
    )
  })
})

describe('路边取餐的车辆信息', () => {
  test('CURBSIDE 单必须带能认车的信息', () => {
    assert.ok(
      /orderType === 'CURBSIDE'/.test(controller),
      'controller 应该校验路边取餐单带了车辆信息',
    )
    assert.ok(
      /VEHICLE_INFO_REQUIRED/.test(controller),
      '缺车辆信息时应返回 VEHICLE_INFO_REQUIRED',
    )
  })

  test('不强制具体哪个字段（有的商家只要车牌，有的看车型颜色）', () => {
    const m = controller.match(/\[v\.make, v\.model, v\.color, v\.plate, v\.spot\]\.some/)
    assert.ok(m, '应该是「任一字段有值即可」，而不是强制某个字段必填')
  })
})
