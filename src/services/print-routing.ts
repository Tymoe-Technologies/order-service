/**
 * 厨房单的备餐站路由与拆单。
 *
 * 纯函数，不碰 prisma —— 调用方把配置查出来传进来。这样做的理由不是「好测试」
 * 这种空话，而是**同一套逻辑 POS 本机也要跑一遍**（后端挂了时用本地缓存的配置
 * 直接拆单出票，见架构文档 §6.2）。两边算出来的结果必须一致，那就只能有一份算法。
 *
 * 设计见 POS 仓库 docs/architecture/PRINT_ARCHITECTURE.md §3。
 */

export type RouteMatchType = 'ITEM' | 'CATEGORY';

/** 备餐站（PrintStation 的子集，只留路由用得到的字段） */
export interface RoutingStation {
  id: string;
  name: string;
  isDefault: boolean;
  isActive: boolean;
  sortOrder: number;
}

/** 路由规则（PrintRoute 的子集） */
export interface RoutingRule {
  stationId: string;
  matchType: RouteMatchType;
  /** matchType=ITEM 时是 catalog_items.id，=CATEGORY 时是分类 id */
  matchId: string;
}

/** 可路由的订单行。只要求这三个字段，其余字段原样带到分组结果里 */
export interface RoutableLine {
  /** OrderItem 行主键（不是商品 id）—— 同一个商品下两行要能分开 */
  id: string;
  itemId: string;
  categoryId?: string | null;
}

export interface StationGroup<T extends RoutableLine> {
  /** null = 没有任何站配置，退回「全单一张」的旧行为 */
  stationId: string | null;
  stationName: string;
  lines: T[];
  /** 单据上的「第 X / 共 Y 张」。厨房少收一张能立刻发现 —— 见文档 §5.1 */
  stationIndex: number;
  stationTotal: number;
  /**
   * 行 id -> 这一行**还**要在哪些站出。单据上印成「⤷ 同时在：打包台」。
   * 不标的话两个站都以为「我做完这道菜就完事了」
   */
  coStations: Record<string, string[]>;
  /** 走了兜底站的行 id。单据上印醒目标记，让配置缺失暴露出来 */
  unroutedLineIds: string[];
}

/**
 * 一条订单行该进哪些站。
 *
 * 三级匹配：商品级 > 分类级 > 兜底站。**商品级命中就不再叠加分类级** ——
 * 否则「把某个商品从它分类的站单独挪走」这个操作根本没法表达。
 *
 * 返回多个站是正常情况（一个商品进多个站，协作出单）。
 */
export function resolveStations(
  line: RoutableLine,
  stations: RoutingStation[],
  rules: RoutingRule[],
): { stationIds: string[]; unrouted: boolean } {
  // 停用的站等于不存在。指向它的规则要当作没匹配上，继续往下一级找 ——
  // 不然「临时关掉冷菜站」会让冷菜直接消失
  const live = new Set(stations.filter((s) => s.isActive).map((s) => s.id));

  const hit = (t: RouteMatchType, id: string | null | undefined) =>
    id ? rules.filter((r) => r.matchType === t && r.matchId === id && live.has(r.stationId)).map((r) => r.stationId) : [];

  const byItem = hit('ITEM', line.itemId);
  if (byItem.length > 0) return { stationIds: dedupe(byItem), unrouted: false };

  const byCategory = hit('CATEGORY', line.categoryId);
  if (byCategory.length > 0) return { stationIds: dedupe(byCategory), unrouted: false };

  const fallback = pickFallback(stations);
  return { stationIds: fallback ? [fallback.id] : [], unrouted: true };
}

/**
 * 兜底站：优先 isDefault，没有就取排序最前的活跃站。
 *
 * 「没有 isDefault 就不出单」是错的答案 —— 商家新加的菜没配路由，
 * 结果是**那道菜永远不会被做**，而这种配置缺失能藏好几个月（每次只影响一个新菜）。
 * 宁可印到一个可能不对的站（单据上有 ⚠ 标记，人会发现），也不能谁都收不到。
 *
 * 多个 isDefault（脏数据）时按同一套排序取第一个，保证结果稳定 ——
 * 拆单要是每次算出来不一样，「第 X / 共 Y 张」就没有意义了。
 */
function pickFallback(stations: RoutingStation[]): RoutingStation | undefined {
  const active = stations.filter((s) => s.isActive).sort(byOrder);
  return active.find((s) => s.isDefault) ?? active[0];
}

const byOrder = (a: RoutingStation, b: RoutingStation) =>
  a.sortOrder - b.sortOrder || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

const dedupe = (ids: string[]) => Array.from(new Set(ids));

/**
 * 按站拆单。一条行可能出现在多个组里（多站协作），那是设计如此。
 *
 * 组的顺序按站的 sortOrder 固定，`stationIndex` 才有意义。
 */
export function splitByStation<T extends RoutableLine>(
  lines: T[],
  stations: RoutingStation[],
  rules: RoutingRule[],
): Array<StationGroup<T>> {
  if (lines.length === 0) return [];

  const active = stations.filter((s) => s.isActive).sort(byOrder);

  // 一个站都没有 = 等价于升级前的行为：全单一张，不区分站。
  // 迁移脚本会给用厨房单的租户建兜底站，走到这里说明配置被删空了 ——
  // 那也得把单打出来，只是印不出站名
  if (active.length === 0) {
    return [{
      stationId: null,
      stationName: '',
      lines,
      stationIndex: 1,
      stationTotal: 1,
      coStations: {},
      unroutedLineIds: lines.map((l) => l.id),
    }];
  }

  const nameOf = new Map(active.map((s) => [s.id, s.name]));
  const groups = new Map<string, T[]>();
  /** 行 id -> 该行命中的所有站（用于算 coStations） */
  const lineStations = new Map<string, string[]>();
  const unrouted = new Set<string>();

  for (const line of lines) {
    const { stationIds, unrouted: isUnrouted } = resolveStations(line, stations, rules);
    if (stationIds.length === 0) continue;   // pickFallback 保证不会走到，防脏数据
    if (isUnrouted) unrouted.add(line.id);
    lineStations.set(line.id, stationIds);
    for (const sid of stationIds) {
      const bucket = groups.get(sid);
      if (bucket) bucket.push(line);
      else groups.set(sid, [line]);
    }
  }

  // 按站排序输出，不按 Map 插入顺序 —— 后者取决于哪个商品先被扫到
  const ordered = active.filter((s) => groups.has(s.id));
  const total = ordered.length;

  return ordered.map((station, i) => {
    const groupLines = groups.get(station.id)!;
    const coStations: Record<string, string[]> = {};
    for (const line of groupLines) {
      const others = (lineStations.get(line.id) || [])
        .filter((sid) => sid !== station.id)
        .map((sid) => nameOf.get(sid))
        .filter((n): n is string => !!n);
      if (others.length > 0) coStations[line.id] = others;
    }
    return {
      stationId: station.id,
      stationName: station.name,
      lines: groupLines,
      stationIndex: i + 1,
      stationTotal: total,
      coStations,
      unroutedLineIds: groupLines.filter((l) => unrouted.has(l.id)).map((l) => l.id),
    };
  });
}
