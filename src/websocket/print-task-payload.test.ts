/**
 * 推给 POS 的任务形状。
 *
 * 这里守的是「网店/第三方的单在 POS 上能不能找到打印机」。
 * 客户端按 (ticketType, stationId) 找绑定的机器，按备餐站配过打印机的商家
 * **没有**「不带站的绑定」可以回退 —— 所以 stationId 一漏，
 * 线上单的厨房单就以「No printer bound for KITCHEN_TICKET」失败，
 * 而同一个站的 POS 本机单照样打得出来。生产库里就是这么一对记录。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { taskToClientPayload } from './print-task-payload'

const kitchenTask = {
  id: 'task-1',
  orderId: 'order-1',
  ticketType: 'KITCHEN_TICKET',
  source: 'ONLINE',
  priority: 1,
  stationId: 'st-hot',
  payload: { orderData: {}, station: { id: 'st-hot', name: '热菜站' } },
  createdAt: new Date('2026-09-09T07:49:28.824Z'),
}

test('厨房单带上 stationId（漏了就找不到按站绑的打印机）', () => {
  assert.equal(taskToClientPayload(kitchenTask).stationId, 'st-hot')
})

test('非厨房票据的 stationId 是 null 而不是 undefined 字段缺失', () => {
  // JSON.stringify 会把 undefined 的字段整个丢掉，客户端拿到的是「没有这个键」；
  // 显式 null 才能在日志里区分「没有站」和「忘了传」
  const label = taskToClientPayload({ ...kitchenTask, ticketType: 'ITEM_LABEL', stationId: null })
  assert.equal(label.stationId, null)
  assert.ok('stationId' in JSON.parse(JSON.stringify(label)))
})

test('Date 和已经是字符串的 createdAt 都能吃', () => {
  // 分发走的是 prisma 返回的 Date，补拉（FETCH_PENDING）那条路曾经传过字符串
  assert.equal(taskToClientPayload(kitchenTask).createdAt, '2026-09-09T07:49:28.824Z')
  assert.equal(
    taskToClientPayload({ ...kitchenTask, createdAt: '2026-09-09T07:49:28.824Z' }).createdAt,
    '2026-09-09T07:49:28.824Z',
  )
})

test('分发和补拉用的是同一个序列化函数', () => {
  /*
    两处各写一份字段列表就是这个 bug 的来源：dispatchPrintTasks 里那份漏了
    stationId，FETCH_PENDING 那份也漏了，而两份都「看起来是全的」。
    钉住引用关系，别让谁再手抄一遍。
  */
  const fs = require('node:fs') as typeof import('node:fs')
  for (const f of ['print-task-dispatcher.ts', 'ws-server.ts']) {
    const src = fs.readFileSync(`${__dirname}/${f}`, 'utf8')
    assert.match(src, /from '\.\/print-task-payload'/, `${f} 应当复用共享的序列化函数`)
    assert.doesNotMatch(src, /ticketType: task\.ticketType/, `${f} 里又手抄了一份字段列表`)
  }
})

/*
  订单号。打失败时收银员看到的如果只有「厨房单 · 热菜 · 失败」，
  他不知道是哪一单 —— 没法告诉顾客，也没法手动补打。
  orderId 是 UUID，对人没用。
*/
test('带上订单号（面板要显示它）', () => {
  const t = { ...kitchenTask, payload: { orderData: { orderNumber: '260910-P02-1HPJ' } } }
  assert.equal(taskToClientPayload(t).orderNumber, '260910-P02-1HPJ')
})

test('payload 里没有就给 null，不让字段消失', () => {
  // 和 stationId 同一个理由：undefined 会被 JSON.stringify 丢掉，
  // 客户端分不出「这单没号」和「忘了传」
  const t = taskToClientPayload({ ...kitchenTask, payload: { orderData: {} } })
  assert.equal(t.orderNumber, null)
  assert.ok('orderNumber' in JSON.parse(JSON.stringify(t)))
})

test('payload 形状不对也不炸', () => {
  // 存量任务的 payload 是旧格式（receiptData/labelData），没有 orderData
  assert.equal(taskToClientPayload({ ...kitchenTask, payload: { receiptData: {} } }).orderNumber, null)
  assert.equal(taskToClientPayload({ ...kitchenTask, payload: null }).orderNumber, null)
})

