/**
 * 验证 POS 同步版本接口（GET /api/order/v1/sync/version）：
 *   ① 一个接口同时给出渠道和打印设置两个版本号
 *      （引擎每个源只取一个 bundle，分成两个接口每轮就要多打一次）
 *   ② 版本号派生 —— count:maxUpdatedAtMs 的取值和对增/改/删的敏感性
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
  // ── ① 路由结构（纯结构检查，不需要数据库也不需要 auth）
  {
    const syncRouter = require('../src/routes/sync.routes').default;
    const paths: string[] = syncRouter.stack
      .filter((l: any) => l.route)
      .map((l: any) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`);
    t('/sync/version 路由已注册', paths.includes('GET /version'), paths.join(' | '));

    /*
      ★ 旧的 /sales-channels/version 必须已经撤掉。
      两条路做同一件事时，后人改了一处忘了另一处 —— 而「版本号来源不一致」
      会让同步在两种行为之间随机跳。所以这里钉住只剩一条。
    */
    const chRouter = require('../src/routes/sales-channel.routes').default;
    const chPaths: string[] = chRouter.stack
      .filter((l: any) => l.route)
      .map((l: any) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`);
    t('★ 旧的 /sales-channels/version 已撤掉（避免两个版本号来源）',
      !chPaths.includes('GET /version'), chPaths.join(' | '));
  }

  // ── ② 版本号派生
  const prisma = require('../src/utils/prisma').default;
  const svc = require('../src/services/sync-version.service');

  // 找一个真实存在的租户来验读取路径
  const any = await prisma.orderSourceConfig.findFirst({ select: { tenantId: true } });
  if (any) {
    const all = await svc.getPosSyncVersions(any.tenantId);
    t('一个接口同时给出两个版本号',
      typeof all.channelVersion === 'string' && typeof all.printSettingVersion === 'string',
      JSON.stringify(all));
    t('带 serverTime（POS 用它校正设备时钟偏差）',
      !!all.serverTime && !Number.isNaN(Date.parse(all.serverTime)), String(all.serverTime));

    const v = all.channelVersion;
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

      /*
        打印设置：这类数据原来只在「打开打印设置面板」时才会检查更新，
        商家在后台改了打印格式，POS 直到有人去开那个面板才知道。
        版本号用 updated_at 而不是表里的 version 列 —— @updatedAt 由 Prisma 保证，
        version 要靠写入方记得自增，少写一处就会「配置改了、版本号没动」。
      */
      const psVer = async () => {
        const a = await tx.printSetting.aggregate({
          where: { tenantId }, _count: { _all: true }, _max: { updatedAt: true },
        });
        return a._count._all === 0 ? '0:0'
          : `${a._count._all}:${a._max.updatedAt ? a._max.updatedAt.getTime() : 0}`;
      };
      const p0 = await psVer();
      t('空租户的打印设置版本是 0:0', p0 === '0:0', p0);
      const ps = await tx.printSetting.create({
        data: { tenantId, ticketType: 'CUSTOMER_RECEIPT', config: {}, createdBy: tenantId },
      });
      const p1 = await psVer();
      t('★ 新增打印设置 → 版本变化', p1 !== p0, `${p0} → ${p1}`);
      await tx.printSetting.update({ where: { id: ps.id }, data: { copies: 2 } });
      const p2 = await psVer();
      t('★ 改打印设置（份数）→ 版本变化（原来只在开面板时才发现）', p2 !== p1, `${p1} → ${p2}`);
      await tx.printSetting.delete({ where: { id: ps.id } });

      throw new Error('__ROLLBACK__');   // 主动回滚，一行都不留
    });
  } catch (e: any) {
    if (e?.message !== '__ROLLBACK__') {
      t('事务内验证意外失败', false, String(e?.message).slice(0, 160));
    }
  }

  // 确认真的没留下东西
  const leftCh = await prisma.orderSourceConfig.count({ where: { tenantId } });
  const leftPs = await prisma.printSetting.count({ where: { tenantId } });
  t('回滚干净，没有残留测试数据', leftCh === 0 && leftPs === 0, `残留 ${leftCh} / ${leftPs} 条`);

  let fail = 0;
  for (const [n, ok, note] of rows) {
    if (!ok) fail++;
    console.log(`  ${ok ? '✓' : '✗'} ${n.padEnd(52)} ${note}`);
  }
  console.log(`\n  ${fail === 0 ? '✅' : '❌'} ${rows.length - fail}/${rows.length} 通过`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
})();
