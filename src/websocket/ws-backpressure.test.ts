/**
 * 发送前的背压检查。
 *
 * `readyState === OPEN` **判不出半死的连接** —— 收银机休眠、网线被拔、
 * 中间设备静默丢包时 TCP 的 FIN 不会到，socket 在服务端看来一直是 OPEN，
 * `ws.send()` 也不报错，数据全堆在进程内存里。
 * 而打印任务的 payload 是整份订单快照（实测平均 14 KB、最大 71 KB），
 * order-service 又是单进程 —— 堆起来影响的是整个服务，不只是打印。
 *
 * 用假 ws 直接测：只需要 readyState / bufferedAmount / send 三个属性。
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { sendMessage } from './ws-server'

const OPEN = 1
const CLOSED = 3

/** 够用的假连接。sent 记下真正发出去的帧 */
const fakeWs = (bufferedAmount: number, readyState = OPEN) => {
  const sent: string[] = []
  return {
    ws: { readyState, bufferedAmount, send: (d: string) => sent.push(d) } as any,
    sent,
  }
}

const msg = { type: 'PING', timestamp: '2026-09-12T00:00:00Z' } as any

describe('sendMessage 背压', () => {
  test('正常连接照常发', () => {
    const { ws, sent } = fakeWs(0)
    assert.equal(sendMessage(ws, msg), true)
    assert.equal(sent.length, 1)
  })

  test('积压刚好在阈值内还发', () => {
    const { ws, sent } = fakeWs(1024 * 1024)
    assert.equal(sendMessage(ws, msg), true)
    assert.equal(sent.length, 1)
  })

  /*
    超阈值返回 false 而不是抛错：调用方（dispatcher）拿到 false 的处理
    已经是对的 —— 任务留 PENDING，等那台设备重连后自己补拉。
  */
  test('积压超阈值就不发，并且返回 false', () => {
    const { ws, sent } = fakeWs(1024 * 1024 + 1)
    assert.equal(sendMessage(ws, msg), false)
    assert.equal(sent.length, 0, '一个字节都不该再往里灌')
  })

  test('连接已关闭也是 false（原有行为，别回退）', () => {
    const { ws, sent } = fakeWs(0, CLOSED)
    assert.equal(sendMessage(ws, msg), false)
    assert.equal(sent.length, 0)
  })
})
