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
      // null 就是「整单没有站配置」这个信号本身，单据抬头要印出来。
      // unroutedLineIds 留空不是漏了：那个字段是给「站配了、但这个商品没归到任何站」
      // 用的，逐行标 ⚠ 的前提是别的行没问题。整单都没配的时候每行都标，
      // 等于一整张单全是警告 —— 没人会去看
      stationId: null,
      stationName: '',
      lines,
      stationIndex: 1,
      stationTotal: 1,
      coStations: {},
      unroutedLineIds: [],
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

/** 厨房单拆分方式。ORDER = 整单一张（按站拆后每站一张）；ITEM = 每个商品一张 */
export type KitchenSplitMode = 'ORDER' | 'ITEM';

/**
 * 把按站拆好的分组**再按商品拆开**。`splitByStation` 之后调用。
 *
 * 按**订单行**拆，不按份数：一行「宫保鸡丁 ×3」出一张票、票上印 ×3，
 * 而不是三张。份数级的拆分是商品标签的活（贴在餐盒上），
 * 厨房单要的是「这道菜要做」。
 *
 * `stationIndex / stationTotal` 在拆完之后**跨站重编**，因为它的用途是
 * 「厨房少收一张能立刻发现」（架构文档 §5.1）—— 编号必须覆盖这一单的
 * 全部票，按站各编各的就数不出总数了。ORDER 模式下的语义不变
 * （每站一张时，站序号恰好等于票序号）。
 *
 * `coStations` 和 `unroutedLineIds` 要收窄到这一行：不收窄的话每张单
 * 都印着别的行的「同时在 X 站」，厨师会以为自己这张漏了东西。
 */
export function splitByItem<T extends RoutableLine>(
  groups: Array<StationGroup<T>>,
  mode: KitchenSplitMode,
): Array<StationGroup<T>> {
  if (mode !== 'ITEM') return groups;

  const perItem = groups.flatMap((g) =>
    g.lines.map((line) => ({
      ...g,
      lines: [line],
      coStations: g.coStations[line.id] ? { [line.id]: g.coStations[line.id] } : {},
      unroutedLineIds: g.unroutedLineIds.includes(line.id) ? [line.id] : [],
    })),
  );
  return perItem.map((g, i) => ({ ...g, stationIndex: i + 1, stationTotal: perItem.length }));
}

/**
 * 打印职责的作用域键（PrinterAssignment.scope）。
 *
 * 分发端要按它查归属、设置端要按它写归属 —— 两边各写一遍字符串拼接的话，
 * 一方改了另一方不知道，表现是**所有任务都查不到归属、静默退回广播**，
 * 也就是重复出单又回来了，而日志上一切正常。所以只留一处。
 */
export const assignmentScope = (
  target: { stationId?: string | null; ticketType: string },
): string => (target.stationId ? `station:${target.stationId}` : `ticket:${target.ticketType}`);

/**
 * 业务角色归属：**谁接网店 / 第三方订单**。
 *
 * 复用 printer_assignments 表而不是新建一张，是因为要的东西一模一样 ——
 * 「全店恰好一台设备负责某件事」，而 `@@unique([tenantId, scope])` 已经
 * 在数据库层保证了这一点。靠界面自觉保证唯一是做不到的：两台设备同时开，
 * 谁也拦不住。
 *
 * 和 `ticket:` / `station:` 的区别：那两个回答「这张单打到哪」，
 * 这个回答「这一类**订单**归谁处理」—— 包括需要人工接单/拒单的第三方来单，
 * 不只是打印。
 */
export const ROLE_ONLINE_ORDER_RECEIVER = 'role:ONLINE_ORDER_RECEIVER';

/**
 * 任务 → 候选归属 scope，按优先级。分发器取**第一个查得到归属**的。
 *
 * **厨房单**按备餐站定向（`station:<id>`），这条不变。
 *
 * **收据和标签**交给接单设备。能走到分发器的收据/标签一定不是 POS 单的 ——
 * `tasksForOtherDevices` 只放行 KITCHEN_TICKET，POS 单的收据标签一律本机打、
 * 根本不进分发。剩下的就是 Web / 第三方 / Kiosk 来单，那些单
 * 「顾客面前那台」不存在，本来就该去接单机。
 *
 * `ticket:<类型>` 作为第二候选留着，是为了**升级期间**：新版 POS 的设置界面
 * 已经不再上报这类归属，但老版本还在报、库里也有存量记录。现在就砍掉它，
 * 老版本 POS 的网店单会直接退回广播 = 重复打印。等全部升级完，
 * 清理是一条 DELETE 的事。
 */
export const candidateScopes = (
  task: { ticketType: string; stationId?: string | null },
): string[] => (
  task.ticketType === 'KITCHEN_TICKET'
    ? [assignmentScope(task)]
    : [ROLE_ONLINE_ORDER_RECEIVER, assignmentScope(task)]
);

/** 反解，供设置界面和校验用 */
export const parseAssignmentScope = (
  scope: string,
):
  | { kind: 'station'; stationId: string }
  | { kind: 'ticket'; ticketType: string }
  | { kind: 'role'; role: string }
  | null => {
  const m = /^(station|ticket|role):(.+)$/.exec(scope || '');
  if (!m) return null;
  if (m[1] === 'station') return { kind: 'station', stationId: m[2] };
  if (m[1] === 'role') return { kind: 'role', role: m[2] };
  return { kind: 'ticket', ticketType: m[2] };
};
