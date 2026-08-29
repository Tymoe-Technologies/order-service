/**
 * 「顾客是否在店内等餐」的判定
 *
 * 起因：叫号屏和 READY 超时自动完成都写成「排除 DELIVERY」的黑名单，
 * 于是 CURBSIDE 加进枚举后自动混进了叫号屏 —— 而那些顾客坐在车里，
 * 根本看不到那块屏幕，白占位置还干扰店内顾客。
 *
 * 改成白名单后，新加的履约方式默认**不**获得这些行为，必须显式加进
 * IN_STORE_PICKUP_TYPES。这个测试就是盯着这条不变式。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  IN_STORE_PICKUP_TYPES,
  isInStorePickup,
  FULFILLMENT_TYPES,
} from './fulfillment-option.service'

describe('哪些履约方式算「店内等餐」', () => {
  test('堂食和柜台自取算', () => {
    assert.equal(isInStorePickup('DINE_IN'), true)
    assert.equal(isInStorePickup('TAKEOUT'), true)
  })

  test('路边取餐不算 —— 顾客在车里，看不到叫号屏', () => {
    assert.equal(isInStorePickup('CURBSIDE'), false)
  })

  test('配送不算 —— 顾客压根不在店里', () => {
    assert.equal(isInStorePickup('DELIVERY'), false)
  })

  test('空值不炸', () => {
    assert.equal(isInStorePickup(null), false)
    assert.equal(isInStorePickup(undefined), false)
    assert.equal(isInStorePickup(''), false)
  })

  test('未知类型不算（白名单的意义）', () => {
    assert.equal(isInStorePickup('TELEPORT'), false)
  })
})

describe('白名单不变式', () => {
  test('店内取餐类型是履约方式的真子集', () => {
    for (const t of IN_STORE_PICKUP_TYPES) {
      assert.ok(
        (FULFILLMENT_TYPES as readonly string[]).includes(t),
        `${t} 不是有效的履约方式`,
      )
    }
    assert.ok(
      IN_STORE_PICKUP_TYPES.length < FULFILLMENT_TYPES.length,
      '不该所有履约方式都算店内等餐，否则这个区分没有意义',
    )
  })

  test('当前只有堂食和柜台自取', () => {
    assert.deepEqual([...IN_STORE_PICKUP_TYPES].sort(), ['DINE_IN', 'TAKEOUT'])
  })
})

describe('调用点确实用了白名单，没有残留黑名单', () => {
  const SRC = join(__dirname, '..')

  test('叫号屏查询用 in 白名单', () => {
    const src = readFileSync(join(SRC, 'websocket/queue-display-server.ts'), 'utf8')
    assert.ok(
      /orderType: \{ in: \[\.\.\.IN_STORE_PICKUP_TYPES\] \}/.test(src),
      '叫号屏查询应该用 IN_STORE_PICKUP_TYPES 白名单',
    )
    assert.ok(
      !/orderType: \{ not: 'DELIVERY' \}/.test(src),
      '叫号屏不该再用「排除 DELIVERY」的黑名单——新类型会默认混进来',
    )
  })

  test('叫号屏广播用同一套口径', () => {
    const src = readFileSync(join(SRC, 'websocket/queue-display-server.ts'), 'utf8')
    assert.ok(
      /!isInStorePickup\(order\.orderType\)/.test(src),
      '广播处应该用 isInStorePickup 判断',
    )
    assert.ok(
      !/order\.orderType === 'DELIVERY'/.test(src),
      '广播处不该再单独判断 DELIVERY',
    )
  })

  test('READY 超时自动完成也用白名单', () => {
    const src = readFileSync(join(SRC, 'services/order.service.ts'), 'utf8')
    const fn = src.slice(src.indexOf('async autoCompleteOverdueReady'))
    const body = fn.slice(0, fn.indexOf('\n  }'))
    assert.ok(
      /orderType: \{ in: \[\.\.\.IN_STORE_PICKUP_TYPES\] \}/.test(body),
      'autoCompleteOverdueReady 应该用白名单 —— 路边取餐的顾客可能还在路上，' +
      '自动完成会变成「系统显示已完成、餐还没送出去」',
    )
  })
})
