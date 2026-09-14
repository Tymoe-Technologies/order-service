/**
 * 支付回调自动推进状态时，时间戳和状态历史要一起写。
 *
 * 这条路**绕过** order-status.service（那边有 getStatusTimestampField 和
 * orderStatusHistory.create），支付回调自己改 status —— 两条路各写各的，
 * 很容易只补一边。
 *
 * 实测生产订单 260913-P01-1MMU：status=CONFIRMED 而 confirmedAt=null、
 * order_status_history 一条都没有，整单的时间线从建单直接跳到完成。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = readFileSync(join(__dirname, 'order.service.ts'), 'utf8')

/** 抠出「订单状态自动转换」那段 if(order.status === 'PENDING') 块 */
function autoTransitionBlock(): string {
  const start = src.indexOf("// 订单状态自动转换")
  assert.ok(start > 0, '找不到状态自动转换那段')
  const end = src.indexOf('// 生成取餐号', start)
  assert.ok(end > start, '找不到那段的结尾')
  return src.slice(start, end)
}

describe('支付回调推进状态', () => {
  const block = autoTransitionBlock()

  test('推到 COMPLETED 时写 completedAt', () => {
    assert.match(block, /updateData\.status = 'COMPLETED';[\s\S]{0,80}updateData\.completedAt/)
  })

  test('推到 CONFIRMED 时写 confirmedAt', () => {
    assert.match(block, /updateData\.status = 'CONFIRMED';[\s\S]{0,600}updateData\.confirmedAt/)
  })

  /* 没有历史记录的话，这一跳在 order_status_history 里查不到 */
  test('两种推进都记状态历史', () => {
    assert.match(block, /orderStatusHistory\.create/)
    assert.match(block, /fromStatus: order\.status/)
    assert.match(block, /toStatus: updateData\.status/)
  })

  /* Uber Direct 单支付后必须停在 PENDING 等接单，不能被这段推走 */
  test('Uber Direct 单仍然不动状态', () => {
    assert.match(block, /isUberDelivery: 不改 status/)
  })
})
