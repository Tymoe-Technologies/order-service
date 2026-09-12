/**
 * POS 单的转交判断。
 *
 * 这条规则和 POS 那边（localPrintTasks 的「这个 scope 归不归我」）
 * **必须是严格互补的**：两边错开一点就是重复出单或漏单。
 * 所以这里把每种情况都钉死，POS 那边的探针钉同一组情况的另一半。
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { tasksForOtherDevices } from './print-task-ownership'

const ME = 'devA'
const OTHER = 'devB'

const kitchen = (stationId: string | null) => ({ ticketType: 'KITCHEN_TICKET', stationId })
const receipt = { ticketType: 'CUSTOMER_RECEIPT', stationId: null }
const label = { ticketType: 'ITEM_LABEL', stationId: null }

const owners = (m: Record<string, string>) => new Map(Object.entries(m))

describe('tasksForOtherDevices', () => {
  test('归属在别的设备 → 转交', () => {
    const out = tasksForOtherDevices([kitchen('s1')], owners({ 'station:s1': OTHER }), ME)
    assert.equal(out.length, 1)
  })

  test('归属就是自己 → 不转交（本地打，后端挂了也能出票）', () => {
    const out = tasksForOtherDevices([kitchen('s1')], owners({ 'station:s1': ME }), ME)
    assert.deepEqual(out, [])
  })

  /*
    没登记归属 = 没人声明负责。交给服务端的话它查不到目标，
    只能退回广播 —— 那就是重复出单。留给下单设备本地兜底。
  */
  test('没登记归属 → 不转交', () => {
    assert.deepEqual(tasksForOtherDevices([kitchen('s1')], new Map(), ME), [])
  })

  test('没有备餐站的厨房单（ticket:KITCHEN_TICKET）同样适用', () => {
    const t = { ticketType: 'KITCHEN_TICKET', stationId: null }
    assert.equal(tasksForOtherDevices([t], owners({ 'ticket:KITCHEN_TICKET': OTHER }), ME).length, 1)
    assert.equal(tasksForOtherDevices([t], owners({ 'ticket:KITCHEN_TICKET': ME }), ME).length, 0)
  })

  /*
    收据要从顾客面前那台出，标签贴在下单那台旁边 ——
    哪怕它们也登记了归属（设置界面对每种票据都会上报），也绝不转交。
  */
  test('收据和标签永不转交，即使登记在别的设备上', () => {
    const map = owners({ 'ticket:CUSTOMER_RECEIPT': OTHER, 'ticket:ITEM_LABEL': OTHER })
    assert.deepEqual(tasksForOtherDevices([receipt, label], map, ME), [])
  })

  /*
    老版本 POS 不发 deviceId。那时候服务端分不出是谁开的单，
    一张都不能转交 —— 否则会和那台机的本地打印重复。
    （print.handler 那边还有一道更早的拦截，这里是第二道。）
  */
  test('不知道下单设备 → 一张都不转交', () => {
    const map = owners({ 'station:s1': OTHER })
    assert.deepEqual(tasksForOtherDevices([kitchen('s1')], map, null), [])
    assert.deepEqual(tasksForOtherDevices([kitchen('s1')], map, undefined), [])
  })

  test('多站混合：只挑别人负责的那几张', () => {
    const tasks = [kitchen('s1'), kitchen('s2'), kitchen('s3'), receipt]
    const map = owners({ 'station:s1': OTHER, 'station:s2': ME })
    const out = tasksForOtherDevices(tasks, map, ME)
    assert.deepEqual(out.map((t) => t.stationId), ['s1'])
  })
})
