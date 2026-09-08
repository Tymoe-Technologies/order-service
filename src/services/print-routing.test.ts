/**
 * 备餐站路由与拆单单测。
 *
 * 跑法：npm test（node --import tsx --test src/**\/*.test.ts）
 *
 * 每个用例的期望值都是手推的、写死在断言里。这里最要紧的两组是
 * 「商品级不叠加分类级」和「多站扇出后 stationIndex/stationTotal 还对」——
 * 前者错了商家改不动配置，后者错了厨房少收一张也发现不了。
 */

import { test } from 'node:test';
import assert from 'assert/strict';
import {
  resolveStations, splitByStation, assignmentScope, parseAssignmentScope,
  type RoutingStation, type RoutingRule,
} from './print-routing';

// 三个站：热菜(0) 冷菜(1) 打包台(2)，热菜是兜底
const HOT: RoutingStation = { id: 's-hot', name: '热菜站', isDefault: true, isActive: true, sortOrder: 0 };
const COLD: RoutingStation = { id: 's-cold', name: '冷菜站', isDefault: false, isActive: true, sortOrder: 1 };
const PACK: RoutingStation = { id: 's-pack', name: '打包台', isDefault: false, isActive: true, sortOrder: 2 };
const STATIONS = [HOT, COLD, PACK];

const line = (id: string, itemId: string, categoryId?: string | null) => ({ id, itemId, categoryId });

// ── 三级匹配 ────────────────────────────────────────────────

test('商品级命中时不叠加分类级', () => {
  // 「凉菜」分类整体进冷菜站，但拍黄瓜这一个商品被单独挪去打包台。
  // 要是两级叠加，这个「挪走」的操作就永远表达不出来
  const rules: RoutingRule[] = [
    { stationId: COLD.id, matchType: 'CATEGORY', matchId: 'c-cold' },
    { stationId: PACK.id, matchType: 'ITEM', matchId: 'i-cucumber' },
  ];
  const r = resolveStations(line('l1', 'i-cucumber', 'c-cold'), STATIONS, rules);
  assert.deepEqual(r, { stationIds: ['s-pack'], unrouted: false });
});

test('没有商品级规则时用分类级', () => {
  const rules: RoutingRule[] = [{ stationId: COLD.id, matchType: 'CATEGORY', matchId: 'c-cold' }];
  const r = resolveStations(line('l1', 'i-salad', 'c-cold'), STATIONS, rules);
  assert.deepEqual(r, { stationIds: ['s-cold'], unrouted: false });
});

test('两级都没命中走兜底站并标记 unrouted', () => {
  const r = resolveStations(line('l1', 'i-new', 'c-new'), STATIONS, []);
  assert.deepEqual(r, { stationIds: ['s-hot'], unrouted: true });
});

test('categoryId 为 null 不会误命中 matchId 为 null 的规则', () => {
  // 存量订单行没有 categoryId。要是拿 undefined 去比，
  // 任何一条脏规则都可能把所有老单吸走
  const rules: RoutingRule[] = [{ stationId: COLD.id, matchType: 'CATEGORY', matchId: 'c-cold' }];
  const r = resolveStations(line('l1', 'i-old', null), STATIONS, rules);
  assert.deepEqual(r, { stationIds: ['s-hot'], unrouted: true });
});

test('规则指向停用的站时继续往下一级找', () => {
  // 冷菜站临时关掉，凉菜不能就此消失，要落到兜底站
  const rules: RoutingRule[] = [{ stationId: COLD.id, matchType: 'CATEGORY', matchId: 'c-cold' }];
  const r = resolveStations(line('l1', 'i-salad', 'c-cold'), [HOT, { ...COLD, isActive: false }, PACK], rules);
  assert.deepEqual(r, { stationIds: ['s-hot'], unrouted: true });
});

test('商品级规则指向停用站时降级到分类级', () => {
  const rules: RoutingRule[] = [
    { stationId: PACK.id, matchType: 'ITEM', matchId: 'i-cucumber' },
    { stationId: COLD.id, matchType: 'CATEGORY', matchId: 'c-cold' },
  ];
  const r = resolveStations(line('l1', 'i-cucumber', 'c-cold'), [HOT, COLD, { ...PACK, isActive: false }], rules);
  assert.deepEqual(r, { stationIds: ['s-cold'], unrouted: false });
});

test('没有 isDefault 站时兜底到排序最前的活跃站', () => {
  // 「找不到 isDefault 就不出单」是错的答案：那道菜谁都收不到，永远不会被做
  const r = resolveStations(line('l1', 'i-new'), [{ ...HOT, isDefault: false }, COLD], []);
  assert.deepEqual(r, { stationIds: ['s-hot'], unrouted: true });
});

test('一个商品配了两个站就返回两个站（协作出单）', () => {
  const rules: RoutingRule[] = [
    { stationId: HOT.id, matchType: 'ITEM', matchId: 'i-tea' },
    { stationId: PACK.id, matchType: 'ITEM', matchId: 'i-tea' },
  ];
  const r = resolveStations(line('l1', 'i-tea'), STATIONS, rules);
  assert.deepEqual(r, { stationIds: ['s-hot', 's-pack'], unrouted: false });
});

// ── 拆单 ────────────────────────────────────────────────────

test('拆单：三站各一行，stationIndex 按站排序递增', () => {
  const rules: RoutingRule[] = [
    { stationId: HOT.id, matchType: 'ITEM', matchId: 'i-kungpao' },
    { stationId: COLD.id, matchType: 'ITEM', matchId: 'i-salad' },
    { stationId: PACK.id, matchType: 'ITEM', matchId: 'i-bag' },
  ];
  // 故意按倒序传入，验证输出不受商品顺序影响
  const groups = splitByStation(
    [line('l3', 'i-bag'), line('l2', 'i-salad'), line('l1', 'i-kungpao')],
    STATIONS,
    rules,
  );
  assert.deepEqual(
    groups.map((g) => [g.stationName, g.stationIndex, g.stationTotal, g.lines.map((l) => l.id)]),
    [
      ['热菜站', 1, 3, ['l1']],
      ['冷菜站', 2, 3, ['l2']],
      ['打包台', 3, 3, ['l3']],
    ],
  );
});

test('拆单：多站商品在两张单上都出现，且互相标注 coStations', () => {
  const rules: RoutingRule[] = [
    { stationId: HOT.id, matchType: 'ITEM', matchId: 'i-tea' },
    { stationId: PACK.id, matchType: 'ITEM', matchId: 'i-tea' },
  ];
  const groups = splitByStation([line('l1', 'i-tea')], STATIONS, rules);

  // 只有两个站参与，stationTotal=2（打包台是第 2 张，不是第 3 张 ——
  // 没商品的站不出单，也不占分母）
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((g) => [g.stationName, g.stationIndex, g.stationTotal]), [
    ['热菜站', 1, 2],
    ['打包台', 2, 2],
  ]);
  assert.deepEqual(groups[0].coStations, { l1: ['打包台'] });
  assert.deepEqual(groups[1].coStations, { l1: ['热菜站'] });
});

test('拆单：单站商品不带 coStations', () => {
  const rules: RoutingRule[] = [{ stationId: HOT.id, matchType: 'ITEM', matchId: 'i-kungpao' }];
  const groups = splitByStation([line('l1', 'i-kungpao')], STATIONS, rules);
  assert.deepEqual(groups[0].coStations, {});
});

test('拆单：unroutedLineIds 只含走兜底的那些行', () => {
  const rules: RoutingRule[] = [{ stationId: COLD.id, matchType: 'ITEM', matchId: 'i-salad' }];
  // l1 有规则进冷菜站；l2 没配，兜底进热菜站
  const groups = splitByStation([line('l1', 'i-salad'), line('l2', 'i-new')], STATIONS, rules);
  const byName = Object.fromEntries(groups.map((g) => [g.stationName, g]));
  assert.deepEqual(byName['热菜站'].unroutedLineIds, ['l2']);
  assert.deepEqual(byName['冷菜站'].unroutedLineIds, []);
});

test('拆单：同一商品的两行分别计入，不被合并', () => {
  // 同一个商品下两行（比如加料不同），行 id 不同就得各印一条
  const rules: RoutingRule[] = [{ stationId: HOT.id, matchType: 'ITEM', matchId: 'i-kungpao' }];
  const groups = splitByStation([line('l1', 'i-kungpao'), line('l2', 'i-kungpao')], STATIONS, rules);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].lines.map((l) => l.id), ['l1', 'l2']);
});

test('拆单：一个站都没配时退回全单一张（等于升级前的行为）', () => {
  const groups = splitByStation([line('l1', 'i-a'), line('l2', 'i-b')], [], []);
  assert.equal(groups.length, 1);
  assert.deepEqual(
    [groups[0].stationId, groups[0].stationIndex, groups[0].stationTotal, groups[0].lines.map((l) => l.id)],
    [null, 1, 1, ['l1', 'l2']],
  );
  // 全部标 unrouted：单据上会有 ⚠，商家才会去配站
  assert.deepEqual(groups[0].unroutedLineIds, ['l1', 'l2']);
});

test('拆单：所有站都停用时也退回全单一张，不能一张都不出', () => {
  const dead = STATIONS.map((s) => ({ ...s, isActive: false }));
  const groups = splitByStation([line('l1', 'i-a')], dead, []);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].stationId, null);
});

test('拆单：空订单不出单', () => {
  assert.deepEqual(splitByStation([], STATIONS, []), []);
});

test('拆单：重复规则（同商品同站配了两条）不会让这行在同一张单上出现两次', () => {
  const rules: RoutingRule[] = [
    { stationId: HOT.id, matchType: 'ITEM', matchId: 'i-tea' },
    { stationId: HOT.id, matchType: 'ITEM', matchId: 'i-tea' },
  ];
  const groups = splitByStation([line('l1', 'i-tea')], STATIONS, rules);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].lines.map((l) => l.id), ['l1']);
  assert.deepEqual(groups[0].coStations, {});
});

// ── 打印职责的 scope 键 ─────────────────────────────────────
// 分发端按它查归属、设置端按它写归属。两边不一致的表现是「所有任务都查不到
// 归属、静默退回广播」= 重复出单又回来了，而日志上一切正常

test('厨房单按站取 scope，其他票据按类型', () => {
  assert.equal(assignmentScope({ stationId: 's-hot', ticketType: 'KITCHEN_TICKET' }), 'station:s-hot');
  assert.equal(assignmentScope({ stationId: null, ticketType: 'CUSTOMER_RECEIPT' }), 'ticket:CUSTOMER_RECEIPT');
  assert.equal(assignmentScope({ ticketType: 'ITEM_LABEL' }), 'ticket:ITEM_LABEL');
});

test('scope 能原样反解回去（分发端写的，设置端读得懂）', () => {
  for (const t of [
    { stationId: 'abc', ticketType: 'KITCHEN_TICKET' },
    { stationId: null, ticketType: 'CUSTOMER_RECEIPT' },
  ]) {
    const parsed = parseAssignmentScope(assignmentScope(t));
    assert.deepEqual(parsed, t.stationId
      ? { kind: 'station', stationId: t.stationId }
      : { kind: 'ticket', ticketType: t.ticketType });
  }
});

test('反解认不出的 scope 返回 null，不当成合法值', () => {
  for (const bad of ['', 'station', 'hot', 'printer:1', 'station:']) {
    assert.equal(parseAssignmentScope(bad), null, `${JSON.stringify(bad)} 不该被认成合法 scope`);
  }
});
