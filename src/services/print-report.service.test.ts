/**
 * 打印结果补报的入参校验单测。
 *
 * 跑法：npm test
 *
 * 这些入参全部来自 POS —— 信任边界。放过一条脏数据的后果分两种：
 *   · 别家的 orderId → 往自己店里塞记录（订单归属在 upsertOne 里查库，这里查不到）
 *   · 不合法的 clientTaskId / ticketType → 幂等键失效或 enum 写入报错，
 *     后者会让整批补报卡住，而队列会一直重发
 */

import { test } from 'node:test';
import assert from 'assert/strict';
import { validate, parseTime, type PrintResultReport } from './print-report.service';

const OK: PrintResultReport = {
  clientTaskId: 'a1b2c3d4-1111-4111-8111-111111111111:KITCHEN_TICKET:22222222-2222-4222-8222-222222222222',
  orderId: 'a1b2c3d4-1111-4111-8111-111111111111',
  ticketType: 'KITCHEN_TICKET',
  stationId: '22222222-2222-4222-8222-222222222222',
  status: 'COMPLETED',
};

const expectCode = (r: any, code: string) => {
  assert.throws(() => validate(r), (e: any) => {
    assert.equal(e.code, code, `期望 ${code}，实际 ${e.code}: ${e.message}`);
    return true;
  });
};

test('合法上报通过', () => {
  validate(OK);
  validate({ ...OK, ticketType: 'CUSTOMER_RECEIPT', stationId: null });
  validate({ ...OK, status: 'FAILED', error: 'ECONNREFUSED' });
});

test('clientTaskId 缺失或超长要拒（幂等键，没它重复补报会堆重复记录）', () => {
  expectCode({ ...OK, clientTaskId: '' }, 'INVALID_CLIENT_TASK_ID');
  expectCode({ ...OK, clientTaskId: 'x'.repeat(129) }, 'INVALID_CLIENT_TASK_ID');
});

test('clientTaskId 刚好 128 字符是合法的（库里就是 VARCHAR(128)）', () => {
  validate({ ...OK, clientTaskId: 'x'.repeat(128) });
});

test('厨房单那种真实 id（两个 uuid + 票据类型 = 88 字符）装得下', () => {
  // 这一条是这次改动的起因：原来列宽 64，厨房单的 id 压根存不进去，
  // 而那正是最需要补报的一类（一单多张、最容易少一张）
  assert.equal(OK.clientTaskId.length, 88);
  validate(OK);
});

test('orderId 不是 uuid 要拒', () => {
  expectCode({ ...OK, orderId: 'ord-1' }, 'INVALID_ORDER_ID');
});

test('ticketType 不在枚举里要拒（不拒会让整批补报卡在一条脏数据上）', () => {
  expectCode({ ...OK, ticketType: 'KITCHEN' }, 'INVALID_TICKET_TYPE');
});

test('status 只认 COMPLETED / FAILED', () => {
  expectCode({ ...OK, status: 'PENDING' }, 'INVALID_STATUS');
  expectCode({ ...OK, status: 'ok' }, 'INVALID_STATUS');
});

test('stationId 给了就必须是 uuid，不给可以', () => {
  expectCode({ ...OK, stationId: 'st-hot' }, 'INVALID_STATION_ID');
  validate({ ...OK, stationId: undefined });
  validate({ ...OK, stationId: null });
});

test('客户端时间脏了不抛，退回服务端时刻', () => {
  // 补报可能晚好几小时，所以正常情况要用客户端时间；
  // 但收银机的时钟可能是错的、字段可能压根没传 —— 那时不能让整条补报失败
  const before = Date.now();
  assert.equal(parseTime('2026-09-08T14:32:05.000Z').toISOString(), '2026-09-08T14:32:05.000Z');
  for (const bad of [undefined, '', 'not-a-date', '2026-13-45']) {
    const t = parseTime(bad as any).getTime();
    assert.ok(t >= before - 1000 && t <= Date.now() + 1000, `${bad} 应退回服务端时刻，得到 ${t}`);
  }
});
