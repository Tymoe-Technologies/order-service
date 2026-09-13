/**
 * 整单完成时的分项收尾。
 *
 * 分项备餐（item_completion_enabled）是双向的：逐项点完 → 最后一项自动完成订单；
 * 反过来店员直接点「完成订单」时，还挂着 PENDING 的分项得跟着收尾，
 * 否则订单是 COMPLETED 而 item 停在 PENDING，备餐屏上那几行永远不消。
 *
 * 这段原本写在 order.service 那个**没有调用方**的 updateOrderStatus 里
 * ——也就是一直没生效。删死代码时挪进了 order-status.service。
 * 钉在这儿是因为它很容易再丢一次：两个文件里曾经各有一份状态机，
 * 改错地方不会报错，只是不生效。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const statusService = readFileSync(join(__dirname, 'order-status.service.ts'), 'utf8')
const orderService = readFileSync(join(__dirname, 'order.service.ts'), 'utf8')

describe('订单完成的收尾', () => {
  test('onOrderCompleted 里会把分项一并标 READY', () => {
    const m = statusService.match(/private async onOrderCompleted[\s\S]*?\n  \}/)
    assert.ok(m, '找不到 onOrderCompleted')
    assert.match(m![0], /itemCompletionEnabled/, '没读商家的分项备餐开关')
    /* 要断言的是**调用**。只写 /markAllItemsReady/ 会匹配到 import 解构那行，
       把调用注释掉照样是绿的（第一版就这么假绿过） */
    assert.match(m![0], /await markAllItemsReady\(/, '没把分项标 READY')
  })

  test('完成事件仍然发（积分等副作用挂在它上面）', () => {
    const m = statusService.match(/private async onOrderCompleted[\s\S]*?\n  \}/)
    assert.match(m![0], /type: 'ORDER_COMPLETED'/)
  })

  /*
    order.service 里那套 VALID_TRANSITIONS + updateOrderStatus 没有任何调用方，
    而且和生效的那份不一致（READY / PICKED_UP 两行差着分支）。
    留着的真实风险是有人照它改状态机，改完不生效还以为改对了。
  */
  test('order.service 不再有第二套状态机', () => {
    assert.doesNotMatch(orderService, /VALID_TRANSITIONS/, '死状态机又回来了')
    assert.doesNotMatch(orderService, /async updateOrderStatus\(/, '死的 updateOrderStatus 又回来了')
  })
})
