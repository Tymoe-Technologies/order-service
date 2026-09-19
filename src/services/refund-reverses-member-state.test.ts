/**
 * **每一条「订单作废」的路径都要退券、冲正积分。**
 *
 * 跑法：npm test
 *
 * ## 这个测试守的那个 bug
 * 退券和冲正原来**只写在 `cancelOrder()` 里**，而那个函数开头就是
 * `if (status === 'COMPLETED') throw '已完成的订单无法取消'`。
 *
 * POS 现金单**下单即 COMPLETED**，所以它退款走的是另一条路：
 * finance 退款 → notifyOrderPaymentStatus('REFUNDED') → updatePaymentStatus。
 * 那条路只把订单改成 CANCELLED，两个事件一个都没发 ——
 * 钱退了，券没退回去，积分也没收回。同一张券能反复用，
 * 积分能靠「下单 → 退款」无限刷。
 *
 * 而且**没有任何报错**：订单状态看起来是对的（CANCELLED），
 * 只有去查 granted_reward 才会发现券还是 USED。
 *
 * ## 为什么是源码级断言
 * 跑真实流程要连库 + 起 member-service + 等 outbox relay。
 * 要守的失败模式是「某条路径漏发事件」，比对源码就够。
 * 做法同 create-order-fields.test.ts。
 */

import { test } from 'node:test';
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(join(__dirname, 'order.service.ts'), 'utf8');

/**
 * 抠出一个类方法的方法体。
 *
 * 这两个都是 `orderService` 对象上的方法（`  async cancelOrder(...) {`），
 * 缩进两格，所以结束标记是 `\n  }` 而不是顶格的 `\n}`。
 * 第一版就是按顶格找的，抠出来的东西不对、七条测试全红。
 */
function bodyOf(marker: string): string {
  const i = SRC.indexOf(marker);
  assert.ok(i > -1, `找不到 ${marker}，改名了就把这个测试一起改`);
  const end = SRC.indexOf('\n  }\n', i);
  assert.ok(end > i, `${marker} 的方法体边界找不到`);
  const body = SRC.slice(i, end);
  // 抠歪了要炸在这里，不要静默放过（方法体至少几百字符）
  assert.ok(body.length > 500, `${marker} 抠出来只有 ${body.length} 字符，正则失效了`);
  return body;
}

/**
 * 两条会让订单作废的路径。加第三条的话也要登记在这里。
 *
 * · cancelOrder          —— 还没完成的单，店家主动取消
 * · updatePaymentStatus  —— 全额退款回调（POS 现金单走这条，因为它一建单就 COMPLETED）
 */
const VOID_PATHS: Array<[marker: string, why: string]> = [
  ['  async cancelOrder(', '店家主动取消未完成的单'],
  ['  async updatePaymentStatus(', '全额退款回调 —— POS 现金单唯一的作废路径'],
];

for (const [marker, why] of VOID_PATHS) {
  const name = marker.trim().replace('async ', '').replace('(', '');

  test(`★ ${name} 要退券 —— ${why}`, () => {
    const body = bodyOf(marker);
    assert.match(body, /COUPON_RESTORE_REQUESTED/, '这条路作废订单后券还是 USED，能反复使用');
    // 券 id 是从 discountReason 里解析的，不解析就永远拿不到
    assert.match(body, /parseGrantedRewardId\(/);
  });

  test(`★ ${name} 要冲正积分 —— ${why}`, () => {
    const body = bodyOf(marker);
    assert.match(body, /POINTS_REVERSE_REQUESTED/, '钱退了分不收回，能靠「下单→退款」无限刷');
  });

  test(`${name} 冲正的条件一致：有会员、且不是挂账单`, () => {
    /*
      挂账单压根不计积分，发了也是空跑（member-service 返回 lot_not_found）。
      两条路的条件写得不一样的话，就会出现「这么退能刷分、那么退不能」。
    */
    const body = bodyOf(marker);
    const i = body.indexOf('POINTS_REVERSE_REQUESTED');
    const guard = body.slice(Math.max(0, i - 400), i);
    assert.match(guard, /order\.memberId/, '没判会员，无会员单也会空发事件');
    assert.match(guard, /paymentMethod !== 'ACCOUNT'/, '挂账单不该发');
  });
}

test('两条路都走发件箱，不是 fire-and-forget 的 fetch', () => {
  /*
    直接 fetch 的话 member-service 那一刻不可达就永久丢了 ——
    而券没退回去意味着同一张券能被反复使用，每次都真金白银少收一笔。
    写进同一个事务：订单作废 ⟺ 退券任务一定在板上，失败由 relay 重试。
  */
  for (const [marker] of VOID_PATHS) {
    const body = bodyOf(marker);
    const i = body.indexOf('COUPON_RESTORE_REQUESTED');
    assert.match(
      body.slice(Math.max(0, i - 200), i),
      /enqueueEvent\(tx,/,
      `${marker} 的退券没走发件箱`,
    );
  }
});
