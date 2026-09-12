/**
 * 补拉的归属判断。
 *
 * 这里守的是「**不要打印别人的票**」—— 原来的查询完全不看是谁在问，
 * 每次断线重连都可能把另一台机的厨房单打一遍。
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  selectTasksForDevice,
  SENT_TIMEOUT_MS,
  MAX_REPRINT_AGE_MS,
  type SelectableTask,
  type ScopeOwner,
} from './pending-task-selection'

const NOW = new Date('2026-09-12T12:00:00Z').getTime()
const ago = (ms: number) => new Date(NOW - ms)

const task = (o: Partial<SelectableTask> & { id: string }): SelectableTask => ({
  status: 'PENDING',
  scope: 'station:kitchen',
  createdAt: ago(60_000),
  ...o,
})

const owners = (m: Record<string, ScopeOwner>) => new Map(Object.entries(m))

const ids = (ts: SelectableTask[]) => ts.map((t) => t.id)

describe('selectTasksForDevice', () => {
  test('别人负责的不给 —— 这条是整个改动的理由', () => {
    const ts = [task({ id: 'a' })]
    const map = owners({ 'station:kitchen': { deviceId: 'devA' } })
    assert.deepEqual(ids(selectTasksForDevice(ts, map, 'devB', NOW)), [])
    assert.deepEqual(ids(selectTasksForDevice(ts, map, 'devA', NOW)), ['a'])
  })

  test('fallback 设备也算自己人', () => {
    const map = owners({ 'station:kitchen': { deviceId: 'devA', fallbackDeviceId: 'devB' } })
    assert.deepEqual(ids(selectTasksForDevice([task({ id: 'a' })], map, 'devB', NOW)), ['a'])
  })

  /*
    没登记归属的仍然谁问都给：归属记录要等 POS 设置界面上报才有，
    切断的话升级期内那些店一张都补不回来。
  */
  test('没登记归属的谁问都给', () => {
    const ts = [task({ id: 'a', scope: 'ticket:CUSTOMER_RECEIPT' })]
    assert.deepEqual(ids(selectTasksForDevice(ts, new Map(), 'devB', NOW)), ['a'])
  })

  test('SENT 没超时不给 —— 那台机正拿着打', () => {
    const ts = [task({ id: 'a', status: 'SENT', deviceId: 'devA', sentAt: ago(SENT_TIMEOUT_MS - 1000) })]
    const map = owners({ 'station:kitchen': { deviceId: 'devA' } })
    assert.deepEqual(ids(selectTasksForDevice(ts, map, 'devA', NOW)), [])
  })

  test('SENT 超时了回收 —— 否则崩溃/断电的那台机的任务永远卡住', () => {
    const ts = [task({ id: 'a', status: 'SENT', deviceId: 'devA', sentAt: ago(SENT_TIMEOUT_MS + 1000) })]
    const map = owners({ 'station:kitchen': { deviceId: 'devA' } })
    assert.deepEqual(ids(selectTasksForDevice(ts, map, 'devA', NOW)), ['a'])
  })

  test('SENT 超时了也只回给负责设备，不是谁问给谁', () => {
    const ts = [task({ id: 'a', status: 'SENT', deviceId: 'devA', sentAt: ago(SENT_TIMEOUT_MS + 1000) })]
    const map = owners({ 'station:kitchen': { deviceId: 'devA' } })
    assert.deepEqual(ids(selectTasksForDevice(ts, map, 'devB', NOW)), [])
  })

  test('sentAt 为空按超时处理 —— 宁可多打一张，也不要永远卡住', () => {
    const ts = [task({ id: 'a', status: 'SENT', sentAt: null })]
    assert.deepEqual(ids(selectTasksForDevice(ts, new Map(), 'devA', NOW)), ['a'])
  })

  /*
    原来那个查询一条时间过滤都没有：设备离线一天再上线，
    会把一整天的票一次吐出来 —— 厨师会以为来了一堆新单。
  */
  test('太老的不补印', () => {
    const ts = [
      task({ id: 'fresh', createdAt: ago(MAX_REPRINT_AGE_MS - 1000) }),
      task({ id: 'stale', createdAt: ago(MAX_REPRINT_AGE_MS + 1000) }),
    ]
    assert.deepEqual(ids(selectTasksForDevice(ts, new Map(), 'devA', NOW)), ['fresh'])
  })

  test('COMPLETED / FAILED 不参与补拉', () => {
    const ts = [task({ id: 'a', status: 'COMPLETED' }), task({ id: 'b', status: 'FAILED' })]
    assert.deepEqual(ids(selectTasksForDevice(ts, new Map(), 'devA', NOW)), [])
  })
})

/*
  上面测的是纯函数。**还要钉住 ws-server 真的用了它** ——
  函数写对了但没接上去，是最容易发生也最难看出来的一种漏：
  单测全绿、行为照旧。（本仓库在税种明细那次栽过一次同样的。）
*/
describe('接线', () => {
  const src = readFileSync(join(__dirname, 'ws-server.ts'), 'utf8')

  test('handleFetchPending 走的是 selectTasksForDevice', () => {
    const body = src.slice(src.indexOf('async function handleFetchPending'))
      .slice(0, 2500)
    assert.match(body, /selectTasksForDevice\(/)
  })

  test('查询带了时间闸', () => {
    assert.match(src, /createdAt: \{ gte: new Date\(Date\.now\(\) - MAX_REPRINT_AGE_MS\) \}/)
  })

  test('回收的任务也重新标 SENT（否则每次重连都重打）', () => {
    // 旧写法是只挑 status==='PENDING' 的更新，回收回来的 sentAt 不变 → 下次立刻又超时
    assert.doesNotMatch(src, /filter\(t => t\.status === 'PENDING'\)\.map/)
  })
})
