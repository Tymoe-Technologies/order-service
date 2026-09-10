/**
 * 路由配置的入参校验单测。
 *
 * 落库部分不测（要真库），这里只测纯校验函数。最要紧的是
 * 「启用的站里恰好一个兜底站」—— 配错了不会报错，只会在几个月后
 * 表现成「某道菜厨房从来收不到」，那时候没人会想到是这里。
 */

import { test } from 'node:test';
import assert from 'assert/strict';
import { validateRoutingPayload, type StationInput, type RouteInput } from './print-routing.service';

const U = (n: number) => `0000000${n}-0000-4000-8000-000000000000`.slice(-36);
const S1 = U(1), S2 = U(2), ITEM = U(9), CAT = U(8);

const station = (over: Partial<StationInput> = {}): StationInput =>
  ({ id: S1, name: '热菜站', isDefault: true, isActive: true, sortOrder: 0, ...over });

const expectCode = (fn: () => void, code: string) => {
  assert.throws(fn, (e: any) => {
    assert.equal(e.code, code, `期望 ${code}，实际 ${e.code}: ${e.message}`);
    return true;
  });
};

test('合法配置通过', () => {
  const stations = [station(), station({ id: S2, name: '冷菜站', isDefault: false, sortOrder: 1 })];
  const routes: RouteInput[] = [{ stationId: S2, matchType: 'CATEGORY', matchId: CAT }];
  validateRoutingPayload(stations, routes);   // 不抛即通过
});

/*
  零个活跃站是**合法状态**，不是配置错误 —— 拆单算法对它有明确定义
  （厨房单退回「全单一张、不带站名」，即加备餐站之前的行为）。
  原来这两条被拒掉，结果是不想用备餐站的商家被迁移脚本建的那个站永久绑住。
*/
test('一个站都没有 → 放行（不用备餐站是允许的）', () => {
  validateRoutingPayload([], []);
});

test('站全停用 → 放行（等价于不分站）', () => {
  validateRoutingPayload([station({ isActive: false })], []);
});

test('没有兜底站要拒', () => {
  expectCode(() => validateRoutingPayload([station({ isDefault: false })], []), 'DEFAULT_STATION_REQUIRED');
});

test('两个兜底站要拒', () => {
  const stations = [station(), station({ id: S2, name: '冷菜站', isDefault: true })];
  expectCode(() => validateRoutingPayload(stations, []), 'DEFAULT_STATION_REQUIRED');
});

test('兜底站被停用等于没有兜底站', () => {
  // 「站还在，只是关了」很容易让人以为兜底还生效。路由算法把停用站当不存在，
  // 校验必须用同一套口径，否则两边理解不一致
  const stations = [station({ isActive: false }), station({ id: S2, name: '冷菜站', isDefault: false })];
  expectCode(() => validateRoutingPayload(stations, []), 'DEFAULT_STATION_REQUIRED');
});

test('站名为空要拒', () => {
  expectCode(() => validateRoutingPayload([station({ name: '  ' })], []), 'STATION_NAME_REQUIRED');
});

test('站名重复要拒（单据上分不清哪张是自己的）', () => {
  const stations = [station(), station({ id: S2, isDefault: false })];   // 同名「热菜站」
  expectCode(() => validateRoutingPayload(stations, []), 'DUPLICATE_STATION_NAME');
});

test('站 id 不是 uuid 要拒', () => {
  expectCode(() => validateRoutingPayload([station({ id: 'hot' })], []), 'INVALID_STATION_ID');
});

test('同一次提交里站 id 重复要拒', () => {
  const stations = [station(), station({ name: '冷菜站', isDefault: false })];   // 同 id S1
  expectCode(() => validateRoutingPayload(stations, []), 'DUPLICATE_STATION_ID');
});

test('规则指向本次没提交的站要拒', () => {
  // 放过去的话那条规则立刻变孤儿，对应商品静默走兜底，商家以为配好了
  const routes: RouteInput[] = [{ stationId: S2, matchType: 'ITEM', matchId: ITEM }];
  expectCode(() => validateRoutingPayload([station()], routes), 'ROUTE_STATION_UNKNOWN');
});

test('matchType 非法要拒', () => {
  const routes = [{ stationId: S1, matchType: 'TAG', matchId: ITEM }] as unknown as RouteInput[];
  expectCode(() => validateRoutingPayload([station()], routes), 'INVALID_MATCH_TYPE');
});

test('matchId 不是 uuid 要拒', () => {
  const routes: RouteInput[] = [{ stationId: S1, matchType: 'ITEM', matchId: 'kungpao' }];
  expectCode(() => validateRoutingPayload([station()], routes), 'INVALID_MATCH_ID');
});

test('完全重复的规则要拒', () => {
  const routes: RouteInput[] = [
    { stationId: S1, matchType: 'ITEM', matchId: ITEM },
    { stationId: S1, matchType: 'ITEM', matchId: ITEM },
  ];
  expectCode(() => validateRoutingPayload([station()], routes), 'DUPLICATE_ROUTE');
});

test('同一商品配到两个站是合法的（协作出单）', () => {
  const stations = [station(), station({ id: S2, name: '打包台', isDefault: false })];
  const routes: RouteInput[] = [
    { stationId: S1, matchType: 'ITEM', matchId: ITEM },
    { stationId: S2, matchType: 'ITEM', matchId: ITEM },
  ];
  validateRoutingPayload(stations, routes);
});
