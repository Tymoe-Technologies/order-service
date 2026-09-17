import prisma from '../utils/prisma';
import organizationService from './organization.service';

/**
 * POS 同步用的版本号（order-service 负责的那几类数据）
 *
 * ## 为什么是一个接口返回多个版本号
 * POS 的同步引擎**每个后端源只取一个 bundle**。渠道和打印设置都在 order-service，
 * 如果各自一个版本接口，每轮就要打两次 —— 而版本请求的全部意义就是「便宜」。
 * 所以这里统一出口，以后 order-service 再加需要同步的数据也只是多一个字段。
 *
 * ## 版本号为什么是 `count:maxUpdatedAtMs` 字符串
 * 两个量都需要：
 *   · `MAX(updated_at)` 覆盖新增和修改
 *   · `COUNT(*)` 覆盖删除 —— 两张表都是硬删，被删那行的 updated_at 随之消失，
 *     光看 MAX 可能一点变化都没有（实测过：删掉较旧的一行时时间戳段完全不变）
 *
 * 塞不进一个整数（要么溢出 MAX_SAFE_INTEGER，要么降到秒级精度而漏掉同一秒内的
 * 第二次修改），而 POS 的引擎对版本号只做相等比较、从不比大小。
 *
 * ## 为什么不用 Redis
 * order-service 一个 Redis 连接都没有，为几个计数器引入 ioredis 依赖不划算。
 * 一次带索引的聚合远比它替代掉的全量拉取便宜。
 */

/** 空表时的取值。用固定形状而不是空串，读日志时不用分心 */
const EMPTY = '0:0';

const shape = (count: number, maxUpdatedAt: Date | null): string =>
  count === 0 ? EMPTY : `${count}:${maxUpdatedAt ? maxUpdatedAt.getTime() : 0}`;

/**
 * 渠道版本。
 *
 * 刻意**不按 isActive 过滤**：POS 只要 active 且非系统渠道的那些，这里统计全部。
 * 少同步是数据错误，多同步只是一次多余请求；而在这儿复刻一遍调用方的过滤条件，
 * 两边迟早悄悄漂移 —— 那种 bug 表现为「改了渠道 POS 不更新」，极难查。
 */
export async function getChannelVersion(tenantId: string): Promise<string> {
  const agg = await prisma.orderSourceConfig.aggregate({
    where: { tenantId },
    _count: { _all: true },
    _max: { updatedAt: true },
  });
  return shape(agg._count._all, agg._max.updatedAt);
}

/**
 * 打印设置版本。
 *
 * 表里本来就有 `version Int` 列，但这里用 updated_at 而不是它：
 * `@updatedAt` 由 Prisma 保证每次写入都动，而 `version` 要靠写入方记得自增 ——
 * 少写一处就会出现「配置改了、版本号没动」，POS 永久用着旧的打印格式。
 *
 * ## 必须把**品牌那条**也算进去
 *
 * 分店读到的是「品牌模板 + 本店覆盖」的合并结果（见 print-setting.service
 * 的 getSettings），所以品牌那条一改，分店读到的内容就变了 ——
 * 可分店**自己那条记录没动**。只按 `tenantId` 聚合的话版本号纹丝不动，
 * 同步引擎直接跳过，表现是「总部改了打印格式，分店的 POS 永远还是旧的」，
 * 而且没有任何报错，只能靠人去打印设置面板点一次「同步」才会发现。
 *
 * 主店自己调用时 main === tenantId，`in` 去重后就是原来那一条，行为不变。
 */
export async function getPrintSettingVersion(tenantId: string): Promise<string> {
  const mainOrgId = await organizationService.resolveMainOrgId(tenantId);
  const scope = mainOrgId === tenantId ? [tenantId] : [tenantId, mainOrgId];
  const agg = await prisma.printSetting.aggregate({
    where: { tenantId: { in: scope } },
    _count: { _all: true },
    _max: { updatedAt: true },
  });
  return shape(agg._count._all, agg._max.updatedAt);
}

/**
 * 备餐站路由版本（站 + 规则 + 打印机归属）。
 *
 * 三张表合成一个版本号，因为 POS 是**整份一起用**的：拆单要站和规则，
 * 判断「本机负责哪些站」要归属。分开三个版本号只会让引擎多两次比较，
 * 而任何一张变了都得重拉那一整份。
 *
 * `PrintRoute` 没有 `updatedAt`（规则是删了重建，不存在原地修改），
 * 所以用 `createdAt`；count 照旧覆盖删除。
 */
export async function getPrintRoutingVersion(tenantId: string): Promise<string> {
  const [stations, routes, assignments] = await Promise.all([
    prisma.printStation.aggregate({ where: { tenantId }, _count: { _all: true }, _max: { updatedAt: true } }),
    prisma.printRoute.aggregate({ where: { tenantId }, _count: { _all: true }, _max: { createdAt: true } }),
    prisma.printerAssignment.aggregate({ where: { tenantId }, _count: { _all: true }, _max: { updatedAt: true } }),
  ]);
  return [
    shape(stations._count._all, stations._max.updatedAt),
    shape(routes._count._all, routes._max.createdAt),
    shape(assignments._count._all, assignments._max.updatedAt),
  ].join('|');
}

export interface PosSyncVersions {
  channelVersion: string;
  printSettingVersion: string;
  printRoutingVersion: string;
  serverTime: string;
}

/** 聚合并行 —— 互不依赖，串行只是白等往返 */
export async function getPosSyncVersions(tenantId: string): Promise<PosSyncVersions> {
  const [channelVersion, printSettingVersion, printRoutingVersion] = await Promise.all([
    getChannelVersion(tenantId),
    getPrintSettingVersion(tenantId),
    getPrintRoutingVersion(tenantId),
  ]);
  return { channelVersion, printSettingVersion, printRoutingVersion, serverTime: new Date().toISOString() };
}
