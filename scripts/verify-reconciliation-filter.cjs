/**
 * 对账过滤断言：建单即 PAID 且不产生 finance 支付记录的订单，必须被排除。
 * 造真数据跑真查询，跑完清理。
 */
require('dotenv').config({ path: '.env.development' });
const { PrismaClient } = require('.prisma/client-order');
const p = new PrismaClient();
const T = '00000000-0000-0000-0000-0000000000fd';
let pass = 0, fail = 0;
const t = (n, ok, d = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? '✓' : '✗'} ${n}${d ? '  ' + d : ''}`); };

const mkOrder = (num, extra) => p.order.create({ data: {
  tenantId: T, orderNumber: num, orderType: 'DINE_IN', status: 'CONFIRMED',
  subtotal: 1000, totalAmount: 1000, taxAmount: 0, paymentStatus: 'PAID',
  createdBy: T, ...extra,
}});

(async () => {
  const clean = async () => {
    await p.order.deleteMany({ where: { tenantId: T } });
    await p.orderSourceConfig.deleteMany({ where: { tenantId: T } });
  };
  await clean();

  // 三种渠道：正常 / 平台代收(DoorDash) / 渠道记账
  const normal = await p.orderSourceConfig.create({ data: { tenantId: T, sourceType: 'DINE_IN_X', sourceName: '堂食' } });
  const doordash = await p.orderSourceConfig.create({ data: { tenantId: T, sourceType: 'DOORDASH_X', sourceName: 'DoorDash', platformType: 'DOORDASH' } });
  const credit = await p.orderSourceConfig.create({ data: { tenantId: T, sourceType: 'CORP_X', sourceName: '企业月结', checkoutMode: 'CREDIT_ACCOUNT' } });

  await mkOrder('T-NORMAL',   { channelConfigId: normal.id,   paymentMethod: 'CASH' });
  // ★ 平台单的 orderSource 仍是 POS、paymentMethod 仍是 CASH —— 只有渠道配置认得出
  await mkOrder('T-DOORDASH', { channelConfigId: doordash.id, paymentMethod: 'CASH' });
  await mkOrder('T-CREDIT',   { channelConfigId: credit.id,   paymentMethod: 'CASH' });
  await mkOrder('T-UBER',     { orderSource: 'UBER_EATS',     paymentMethod: 'UBER_EATS' });
  await mkOrder('T-PLATFORM', { paymentMethod: 'PLATFORM' });

  // 复刻接口里的过滤条件
  const excluded = (await p.orderSourceConfig.findMany({
    where: { tenantId: T, OR: [{ platformType: { not: null } }, { checkoutMode: 'CREDIT_ACCOUNT' }] },
    select: { id: true },
  })).map(c => c.id);

  const got = (await p.order.findMany({
    where: {
      tenantId: T,
      orderSource: { notIn: ['UBER_EATS'] },
      paymentMethod: { notIn: ['PLATFORM', 'ACCOUNT'] },
      ...(excluded.length ? { NOT: { channelConfigId: { in: excluded } } } : {}),
      status: { not: 'CANCELLED' },
    },
    select: { orderNumber: true },
  })).map(o => o.orderNumber).sort();

  t('正常渠道的单保留', got.includes('T-NORMAL'), got.join(','));
  t('★ 商家自建 DoorDash 渠道被排除（原来漏判）', !got.includes('T-DOORDASH'));
  t('★ 渠道记账/挂账被排除（原来漏判）', !got.includes('T-CREDIT'));
  t('Uber 直连来单被排除', !got.includes('T-UBER'));
  t('POS 显式 PLATFORM 被排除', !got.includes('T-PLATFORM'));
  t('总共只剩 1 单', got.length === 1, `实际 ${got.length}`);

  await clean();
  console.log(`\n  ${fail === 0 ? '✅' : '❌'} ${pass}/${pass + fail} 通过`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(async e => { console.error('ERR', e.message.slice(0, 300)); process.exit(1); });
