/**
 * 创建测试小票模板
 * 运行: npx tsx scripts/seed-receipt-template.ts
 */

import { PrismaClient } from '.prisma/client-order';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 开始创建测试小票模板...\n');

  // 测试用的 tenantId 和 userId (替换为你实际的值)
  const tenantId = 'your-tenant-id-here'; // ← 替换为实际的组织ID
  const userId = 'your-user-id-here';     // ← 替换为实际的用户ID

  // 检查是否已有默认模板
  const existingDefault = await prisma.receiptTemplate.findFirst({
    where: { tenantId, isDefault: true },
  });

  if (existingDefault) {
    console.log('✅ 已存在默认模板:', existingDefault.name);
    console.log('   ID:', existingDefault.id);
    console.log('   版本:', existingDefault.version);
    return;
  }

  // 创建标准堂食模板
  const dineInTemplate = await prisma.receiptTemplate.create({
    data: {
      tenantId,
      name: '标准堂食模板',
      description: '适用于堂食订单的详细小票',
      paperWidth: 80,
      isDefault: true,
      isActive: true,
      version: 1,
      createdBy: userId,
      config: {
        header: {
          logo: {
            enabled: false,
          },
          storeName: {
            enabled: true,
            text: '星巴克咖啡',
            fontSize: 'large',
            bold: true,
            alignment: 'center',
          },
          storeInfo: {
            enabled: true,
            showAddress: true,
            showPhone: true,
            fontSize: 'small',
          },
          separator: {
            enabled: true,
            char: '=',
          },
        },
        body: {
          orderInfo: {
            enabled: true,
            fields: [
              { label: '订单号', field: 'orderNumber', bold: true },
              { label: '订单类型', field: 'orderType' },
              { label: '订单来源', field: 'orderSource' },
              { label: '桌号', field: 'tableNumber' },
              { label: '时间', field: 'createdAt' },
            ],
          },
          items: {
            enabled: true,
            showHeader: true,
            headerText: '商品明细',
            showAttributes: true,
            showAddons: true,
            showNotes: true,
          },
        },
        footer: {
          summary: {
            enabled: true,
            showSubtotal: true,
            showDiscount: true,
            showTax: false,
            showTotal: true,
          },
          qrcode: {
            enabled: true,
            size: 6,
            alignment: 'center',
          },
          customMessage: '感谢您的光临，欢迎再次光临！',
          wifi: {
            enabled: true,
            ssid: 'Starbucks-WiFi',
            password: 'welcome123',
          },
        },
        style: {
          lineSpacing: 1,
          feedLines: 3,
          cutPaper: true,
        },
      },
    },
  });

  console.log('✅ 创建成功: 标准堂食模板');
  console.log('   ID:', dineInTemplate.id);
  console.log('   版本:', dineInTemplate.version);
  console.log('');

  // 创建简化外带模板
  const takeoutTemplate = await prisma.receiptTemplate.create({
    data: {
      tenantId,
      name: '简化外带模板',
      description: '适用于外带订单的简洁小票',
      paperWidth: 58,
      isDefault: false,
      isActive: true,
      version: 1,
      createdBy: userId,
      config: {
        header: {
          logo: {
            enabled: false,
          },
          storeName: {
            enabled: true,
            text: '星巴克',
            fontSize: 'medium',
            bold: true,
            alignment: 'center',
          },
          storeInfo: {
            enabled: false,
          },
          separator: {
            enabled: true,
            char: '-',
          },
        },
        body: {
          orderInfo: {
            enabled: true,
            fields: [
              { label: '单号', field: 'orderNumber', bold: true },
              { label: '时间', field: 'createdAt', format: 'HH:mm' },
            ],
          },
          items: {
            enabled: true,
            showHeader: false,
            showAttributes: false,
            showAddons: false,
            showNotes: true,
          },
        },
        footer: {
          summary: {
            enabled: true,
            showSubtotal: false,
            showDiscount: false,
            showTax: false,
            showTotal: true,
          },
          qrcode: {
            enabled: false,
          },
          customMessage: '谢谢惠顾',
          wifi: {
            enabled: false,
          },
        },
        style: {
          lineSpacing: 0,
          feedLines: 2,
          cutPaper: true,
        },
      },
    },
  });

  console.log('✅ 创建成功: 简化外带模板');
  console.log('   ID:', takeoutTemplate.id);
  console.log('   版本:', takeoutTemplate.version);
  console.log('');

  // 查询所有模板
  const allTemplates = await prisma.receiptTemplate.findMany({
    where: { tenantId },
    select: {
      id: true,
      name: true,
      paperWidth: true,
      isDefault: true,
      isActive: true,
      version: true,
    },
  });

  console.log('📋 当前所有模板:');
  allTemplates.forEach((t) => {
    console.log(`   - ${t.name} (${t.paperWidth}mm) ${t.isDefault ? '[默认]' : ''}`);
  });
  console.log('');
  console.log('🎉 完成!');
}

main()
  .catch((e) => {
    console.error('❌ 错误:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
