/**
 * 验证渠道版本接口的两件事：
 *   ① 路由顺序 —— `/version` 必须排在 `/:channelId` 之前
 *   ② 版本号派生 —— count:maxUpdatedAtMs 的取值和对增/改/删的敏感性
 *
 * ## 为什么路由顺序要专门验
 * 写错的话 Express 会把 "version" 当成 channelId，返回 404。而 POS 那边只会记
 * 一条「取版本失败」，从现象完全看不出是路由顺序问题 —— 这类错还极容易在
 * 后人往这个文件里加路由时被重新引入。所以断言的是**结构**而不是某次请求的结果。
 *
 * ## 为什么增/改/删跑在会回滚的事务里
 * 开发库是远程共享的（155.248.x.x），不能留下测试数据。整段放进
 * prisma.$transaction 并在最后主动抛错回滚 —— 既真实验证了 SQL 聚合的敏感性，
 * 又不落任何一行。
 */
import path from 'path';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(process.cwd(), '.env.development') });

const rows: Array<[string, boolean, string]> = [];
const t = (name: string, ok: boolean, note = '') => rows.push([name, ok, note]);

/** 事务内直接算版本号，和 service 里的实现保持同一套语义 */
async function versionIn(tx: any, tenantId: string): Promise<string> {
  const agg = await tx.orderSourceConfig.aggregate({
    where: { tenantId },
    _count: { _all: true },
    _max: { updatedAt: true },
  });
  return `${agg._count._all}:${agg._max.updatedAt ? agg._max.updatedAt.getTime() : 0}`;
}

(async () => {
  // ── ① 路由顺序（纯结构检查，不需要数据库也不需要 auth）
  {
    const router = require('../src/routes/sales-channel.routes').default;
    const paths: string[] = router.stack
      .filter((l: any) => l.route)
      .map((l: any) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`);
    const iVersion = paths.indexOf('GET /version');
    const iParam = paths.indexOf('GET /:channelId');
    t('/version 路由已注册', iVersion >= 0, paths.join(' | '));
    t('★ /version 排在 /:channelId 之前（否则会被当成 channelId）',
      iVersion >= 0 && iParam >= 0 && iVersion < iParam, `version@${iVersion}, :channelId@${iParam}`);
  }

  // ── ② 版本号派生
  const prisma = require('../src/utils/prisma').default;
  const svc = require('../src/services/sales-channel.service').default;

  // 找一个真实存在的租户来验读取路径
  const any = await prisma.orderSourceConfig.findFirst({ select: { tenantId: true } });
  if (any) {
    const v = await svc.getChannelVersion(any.tenantId);
    t('版本号形如 count:timestamp', /^\d+:\d+$/.test(v), v);

    // 和手工算出来的对照，确认 Prisma 聚合的返回结构没理解错
    const list = await prisma.orderSourceConfig.findMany({
      where: { tenantId: any.tenantId }, select: { updatedAt: true },
    });
    const expectMax = list.reduce((m: number, r: any) => Math.max(m, r.updatedAt.getTime()), 0);
    t('★ 聚合结果 == 手工算的 count 和 MAX(updated_at)',
      v === `${list.length}:${expectMax}`, `聚合 ${v} vs 手工 ${list.length}:${expectMax}`);
  } else {
    t('（库里没有渠道数据，跳过读取路径对照）', true, '');
  }

  // 增 / 改 / 删的敏感性 —— 全程在会回滚的事务里
  const tenantId = '00000000-0000-4000-8000-0000000000ff';   // 不存在的租户，避免碰到真实数据
  try {
    await prisma.$transaction(async (tx: any) => {
      const v0 = await versionIn(tx, tenantId);
      t('空租户的版本号是 0:0', v0 === '0:0', v0);

      const a = await tx.orderSourceConfig.create({
        data: { tenantId, sourceType: 'VERIFY_A', sourceName: 'verify A' },
      });
      const v1 = await versionIn(tx, tenantId);
      t('★ 新增渠道 → 版本号变化', v1 !== v0, `${v0} → ${v1}`);

      const v1b = await versionIn(tx, tenantId);
      t('没有任何改动 → 版本号稳定不变', v1b === v1, `${v1} → ${v1b}`);

      await tx.orderSourceConfig.update({
        where: { id: a.id }, data: { sourceName: 'verify A 改名' },
      });
      const v2 = await versionIn(tx, tenantId);
      t('★ 修改渠道 → 版本号变化（MAX(updated_at) 推进）', v2 !== v1, `${v1} → ${v2}`);

      // 再加一条，然后删掉**较旧**的那条 —— 这是最关键的一种：
      // 被删的不是最新行，MAX(updated_at) 完全不动，只有 COUNT 会变
      const b = await tx.orderSourceConfig.create({
        data: { tenantId, sourceType: 'VERIFY_B', sourceName: 'verify B' },
      });
      const v3 = await versionIn(tx, tenantId);
      await tx.orderSourceConfig.delete({ where: { id: a.id } });   // a 比 b 旧
      const v4 = await versionIn(tx, tenantId);
      t('★ 删除较旧的渠道 → 版本号仍变化（这就是必须带 COUNT 的原因）',
        v4 !== v3, `${v3} → ${v4}`);
      t('  ↑ 且 MAX(updated_at) 那半段确实没变（证明单靠它会漏）',
        v3.split(':')[1] === v4.split(':')[1], `${v3} → ${v4}`);

      await tx.orderSourceConfig.delete({ where: { id: b.id } });
      throw new Error('__ROLLBACK__');   // 主动回滚，一行都不留
    });
  } catch (e: any) {
    if (e?.message !== '__ROLLBACK__') {
      t('事务内验证意外失败', false, String(e?.message).slice(0, 160));
    }
  }

  // 确认真的没留下东西
  const leftover = await prisma.orderSourceConfig.count({ where: { tenantId } });
  t('回滚干净，没有残留测试数据', leftover === 0, `残留 ${leftover} 条`);

  let fail = 0;
  for (const [n, ok, note] of rows) {
    if (!ok) fail++;
    console.log(`  ${ok ? '✓' : '✗'} ${n.padEnd(52)} ${note}`);
  }
  console.log(`\n  ${fail === 0 ? '✅' : '❌'} ${rows.length - fail}/${rows.length} 通过`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
})();
