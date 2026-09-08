/**
 * 备餐站 / 路由规则 / 打印机归属的读写。
 *
 * 算法在 print-routing.ts（纯函数，POS 本机也跑同一份）；这里只管持久化和校验。
 */

import prisma from '../utils/prisma';
import { AppError } from '../middleware/errorHandler';
import logger from '../utils/logger';
import { parseAssignmentScope, assignmentScope } from './print-routing';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TICKET_TYPES = ['CUSTOMER_RECEIPT', 'KITCHEN_TICKET', 'ITEM_LABEL', 'CUSTOM_LABEL', 'DAILY_REPORT', 'SHIFT_REPORT'];

export interface StationInput {
  /**
   * **一律由客户端发号**（UUID），跟订单主键同一个模式。
   *
   * 服务端发号的话，新建站和「指向这个新站的路由规则」就得分两次提交，
   * 中间态期间来的单会路由错。客户端先发号，站和规则一次提交完。
   */
  id: string;
  name: string;
  isDefault?: boolean;
  isActive?: boolean;
  sortOrder?: number;
  config?: unknown;
}

export interface RouteInput {
  stationId: string;
  matchType: 'ITEM' | 'CATEGORY';
  matchId: string;
}

export interface AssignmentInput {
  /** `station:<uuid>` 或 `ticket:<TicketType>` */
  scope: string;
  deviceId: string;
  fallbackDeviceId?: string | null;
}

export async function getRoutingConfig(tenantId: string) {
  const [stations, routes, assignments] = await Promise.all([
    prisma.printStation.findMany({ where: { tenantId }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
    prisma.printRoute.findMany({ where: { tenantId } }),
    prisma.printerAssignment.findMany({ where: { tenantId } }),
  ]);
  return { stations, routes, assignments };
}

/**
 * 整体替换备餐站与路由规则。
 *
 * 整体替换而不是逐条 CRUD：这份配置很小（几个站、几十条规则），而站和规则是
 * 一起改的 —— 逐条改会出现「规则已经指向新站、站还没建好」这种中间态，
 * 而中间态期间来的单会路由错。
 *
 * 传入里没有的站会被删掉（规则跟着 CASCADE）。历史 PrintTask.stationId
 * 会变成孤儿 id，这是有意的：那些单早就打完了，不该因为改配置而改写历史。
 */
export async function replaceRoutingConfig(
  tenantId: string,
  stationsIn: StationInput[],
  routesIn: RouteInput[],
) {
  validateRoutingPayload(stationsIn, routesIn);

  const idsIn = new Set(stationsIn.map((s) => s.id));

  // 客户端发号意味着 id 可能是新的，也可能撞上别家的站 ——
  // 不带 tenantId 查一遍，撞到别家就拒；查不到的就是新建
  const existing = await prisma.printStation.findMany({
    where: { id: { in: [...idsIn] } },
    select: { id: true, tenantId: true },
  });
  const foreign = existing.filter((e) => e.tenantId !== tenantId);
  if (foreign.length > 0) {
    throw new AppError(409, 'STATION_ID_CONFLICT',
      `站 id 已被占用，请换新 id: ${foreign.map((f) => f.id).join(', ')}`);
  }
  const knownIds = new Set(existing.map((e) => e.id));

  // ── 落库 ────────────────────────────────────────────────
  return prisma.$transaction(async (tx) => {
    // 规则全删重建：几十条的量，比逐条 diff 简单且不会漏
    await tx.printRoute.deleteMany({ where: { tenantId } });
    const dropped = await tx.printStation.findMany({
      where: { tenantId, id: { notIn: [...idsIn] } },
      select: { id: true },
    });
    await tx.printStation.deleteMany({ where: { tenantId, id: { notIn: [...idsIn] } } });
    if (dropped.length > 0) {
      // 站没了，指向它的打印机归属也得清 —— 留着的话分发端查不到对应站，
      // 那条记录永远不会被命中，却会在设置界面里显示成一条有效绑定
      await tx.printerAssignment.deleteMany({
        where: { tenantId, scope: { in: dropped.map((d: { id: string }) => assignmentScope({ stationId: d.id, ticketType: 'KITCHEN_TICKET' })) } },
      });
    }

    for (const s of stationsIn) {
      const data = {
        name: s.name.trim(),
        isDefault: !!s.isDefault,
        isActive: s.isActive !== false,
        sortOrder: s.sortOrder ?? 0,
        config: (s.config ?? null) as any,
      };
      if (knownIds.has(s.id)) await tx.printStation.update({ where: { id: s.id }, data });
      else await tx.printStation.create({ data: { id: s.id, tenantId, ...data } });
    }

    if (routesIn.length > 0) {
      await tx.printRoute.createMany({
        data: routesIn.map((r) => ({
          tenantId,
          stationId: r.stationId,
          matchType: r.matchType,
          matchId: r.matchId,
        })),
      });
    }

    logger.info('[PrintRouting] 配置已替换', {
      tenantId, stations: stationsIn.length, routes: routesIn.length,
    });
    return getRoutingConfigTx(tx, tenantId);
  });
}

async function getRoutingConfigTx(tx: any, tenantId: string) {
  const [stations, routes, assignments] = await Promise.all([
    tx.printStation.findMany({ where: { tenantId }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
    tx.printRoute.findMany({ where: { tenantId } }),
    tx.printerAssignment.findMany({ where: { tenantId } }),
  ]);
  return { stations, routes, assignments };
}

/**
 * 登记打印机归属（只动传进来的 scope）。
 *
 * 不做整体替换：一台 POS 只知道自己接了哪些打印机，它提交时不该把别的
 * POS 登记的归属清掉 —— 那会让另一台机器负责的单退回广播、重复出单。
 */
export async function upsertAssignments(tenantId: string, input: AssignmentInput[]) {
  if (!Array.isArray(input) || input.length === 0) {
    throw new AppError(400, 'INVALID_PAYLOAD', 'assignments 不能为空');
  }

  const stationIds = new Set<string>();
  for (const a of input) {
    const parsed = parseAssignmentScope(a.scope);
    if (!parsed) throw new AppError(400, 'INVALID_SCOPE', `scope 不合法: ${a.scope}`);
    if (parsed.kind === 'station') {
      if (!UUID_RE.test(parsed.stationId)) throw new AppError(400, 'INVALID_SCOPE', `scope 不合法: ${a.scope}`);
      stationIds.add(parsed.stationId);
    } else if (!TICKET_TYPES.includes(parsed.ticketType)) {
      throw new AppError(400, 'INVALID_SCOPE', `scope 不合法: ${a.scope}`);
    }
    if (!a.deviceId || a.deviceId.length > 255) {
      throw new AppError(400, 'INVALID_DEVICE_ID', `deviceId 不合法: ${a.deviceId}`);
    }
  }

  if (stationIds.size > 0) {
    const owned = await prisma.printStation.findMany({
      where: { tenantId, id: { in: [...stationIds] } },
      select: { id: true },
    });
    if (owned.length !== stationIds.size) {
      throw new AppError(404, 'STATION_NOT_FOUND', 'scope 指向的备餐站不存在');
    }
  }

  await prisma.$transaction(
    input.map((a) =>
      prisma.printerAssignment.upsert({
        where: { tenantId_scope: { tenantId, scope: a.scope } },
        create: { tenantId, scope: a.scope, deviceId: a.deviceId, fallbackDeviceId: a.fallbackDeviceId ?? null },
        update: { deviceId: a.deviceId, fallbackDeviceId: a.fallbackDeviceId ?? null },
      }),
    ),
  );

  logger.info('[PrintRouting] 打印机归属已登记', { tenantId, scopes: input.map((a) => a.scope) });
  return prisma.printerAssignment.findMany({ where: { tenantId } });
}

export async function deleteAssignment(tenantId: string, scope: string) {
  const { count } = await prisma.printerAssignment.deleteMany({ where: { tenantId, scope } });
  if (count === 0) throw new AppError(404, 'ASSIGNMENT_NOT_FOUND', `没有这条归属记录: ${scope}`);
  logger.info('[PrintRouting] 打印机归属已删除', { tenantId, scope });
}

/**
 * 纯校验，不碰数据库。抽出来是为了能直接单测 ——
 * 这里守的是「恰好一个兜底站」这类可靠性不变式，配错了不会报错、
 * 只会在几个月后表现成「某道菜厨房从来收不到」。
 */
export function validateRoutingPayload(stationsIn: StationInput[], routesIn: RouteInput[]): void {
  if (!Array.isArray(stationsIn) || !Array.isArray(routesIn)) {
    throw new AppError(400, 'INVALID_PAYLOAD', 'stations 和 routes 必须是数组');
  }
  if (stationsIn.length === 0) {
    throw new AppError(400, 'NO_STATION', '至少要有一个备餐站');
  }
  const nameSeen = new Set<string>();
  for (const s of stationsIn) {
    if (!UUID_RE.test(s.id || '')) throw new AppError(400, 'INVALID_STATION_ID', `站 id 不合法: ${s.id}`);
    const name = (s.name || '').trim();
    if (!name) throw new AppError(400, 'STATION_NAME_REQUIRED', '备餐站名称不能为空');
    if (name.length > 64) throw new AppError(400, 'STATION_NAME_TOO_LONG', `名称超长: ${name}`);
    // 站名会印在单据上，重名的话厨房分不清哪张是自己的
    if (nameSeen.has(name)) throw new AppError(400, 'DUPLICATE_STATION_NAME', `备餐站名称重复: ${name}`);
    nameSeen.add(name);
  }
  const active = stationsIn.filter((s) => s.isActive !== false);
  if (active.length === 0) {
    throw new AppError(400, 'NO_ACTIVE_STATION', '至少要有一个启用的备餐站');
  }
  // 兜底站是可靠性的核心：没配路由的新菜全靠它。恰好一个，不多不少 ——
  // 零个的话新菜谁都收不到，多个的话「进哪个」取决于排序，商家看不出来
  const defaults = active.filter((s) => s.isDefault);
  if (defaults.length !== 1) {
    throw new AppError(400, 'DEFAULT_STATION_REQUIRED',
      `启用的备餐站里必须恰好有一个兜底站，当前 ${defaults.length} 个`);
  }

  const idsIn = new Set(stationsIn.map((s) => s.id));
  if (idsIn.size !== stationsIn.length) {
    throw new AppError(400, 'DUPLICATE_STATION_ID', '同一次提交里出现了重复的站 id');
  }
  const seen = new Set<string>();
  for (const r of routesIn) {
    if (r.matchType !== 'ITEM' && r.matchType !== 'CATEGORY') {
      throw new AppError(400, 'INVALID_MATCH_TYPE', `matchType 只能是 ITEM/CATEGORY，收到 ${r.matchType}`);
    }
    if (!UUID_RE.test(r.matchId || '')) {
      throw new AppError(400, 'INVALID_MATCH_ID', `matchId 不合法: ${r.matchId}`);
    }
    if (!idsIn.has(r.stationId)) {
      // 规则指向本次没提交的站 = 规则会立刻变孤儿，那条规则的商品会静默走兜底
      throw new AppError(400, 'ROUTE_STATION_UNKNOWN', `规则指向的站不在本次提交里: ${r.stationId}`);
    }
    const key = `${r.matchType}:${r.matchId}:${r.stationId}`;
    if (seen.has(key)) throw new AppError(400, 'DUPLICATE_ROUTE', `重复的路由规则: ${key}`);
    seen.add(key);
  }

}
