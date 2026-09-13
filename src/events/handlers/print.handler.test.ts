/**
 * 服务端什么时候该出票。
 *
 * 这里错一次的代价是实打实的纸：
 *   · 打早了 —— POS 建的是 PENDING 单（进结算页拿 orderId 就建了），
 *     挂在 ORDER_CREATED 上等于「还没收钱就出票」，顾客改主意票已经出去了
 *   · 打重了 —— 老版本 POS 不发 deviceId，服务端生成的任务会和那台机的
 *     本地打印撞车，同一张票出两遍
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { shouldPrintOnCreate, shouldPrintOnPaid } from './print.handler'

describe('shouldPrintOnCreate', () => {
  test('POS 单建单时不打 —— 那时候还是没付钱的 PENDING', () => {
    assert.equal(shouldPrintOnCreate('POS'), false)
  })

  test('Web / Uber 建单即打：到 order-service 时钱已经收过了', () => {
    assert.equal(shouldPrintOnCreate('WEB'), true)
    assert.equal(shouldPrintOnCreate('UBER_EATS'), true)
  })
})

describe('shouldPrintOnPaid', () => {
  const paid = (o: Partial<Parameters<typeof shouldPrintOnPaid>[0]> = {}) =>
    shouldPrintOnPaid({ clientOrigin: 'POS', previousStatus: 'PENDING', deviceId: 'devA', ...o })

  test('POS 单付款成功才出票', () => {
    assert.equal(paid(), true)
  })

  /*
    updatePaymentStatus 被重复调用时（补记一笔、对账修正）第二次的
    previousStatus 已经不是 PENDING —— 靠它防重复出票。
  */
  test('已经是 CONFIRMED 了再来一次不重复出票', () => {
    assert.equal(paid({ previousStatus: 'CONFIRMED' }), false)
  })

  test('预约单到点才打，不在这里', () => {
    assert.equal(paid({ previousStatus: 'SCHEDULED' }), false)
  })

  /*
    老版本 POS 不发 deviceId。服务端分不出是谁开的单，生成任务会和
    那台机的本地打印重复 —— 一张票出两遍。两端因此可以分开部署。
  */
  test('POS 没带 deviceId → 交给它本地打，服务端不插手', () => {
    assert.equal(paid({ deviceId: null }), false)
    assert.equal(paid({ deviceId: undefined }), false)
  })

  test('Web 单不看 deviceId（本来就没有下单设备）', () => {
    assert.equal(paid({ clientOrigin: 'WEB', deviceId: null }), true)
  })
})
