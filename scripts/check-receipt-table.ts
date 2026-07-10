/**
 * 检查 receipt_templates 表是否存在
 * 运行: npx tsx scripts/check-receipt-table.ts
 */

import { PrismaClient } from '.prisma/client-order';

const prisma = new PrismaClient();

async function main() {
  console.log('🔍 检查 receipt_templates 表...\n');

  try {
    // 尝试查询表
    const count = await prisma.receiptTemplate.count();
    console.log('✅ receipt_templates 表存在!');
    console.log(`   当前记录数: ${count}`);
    
    if (count > 0) {
      console.log('\n📋 现有模板:');
      const templates = await prisma.receiptTemplate.findMany({
        select: {
          id: true,
          name: true,
          tenantId: true,
          paperWidth: true,
          isDefault: true,
          isActive: true,
          version: true,
          createdAt: true,
        },
      });
      
      templates.forEach((t) => {
        console.log(`\n   模板: ${t.name}`);
        console.log(`   - ID: ${t.id}`);
        console.log(`   - 组织ID: ${t.tenantId}`);
        console.log(`   - 纸张宽度: ${t.paperWidth}mm`);
        console.log(`   - 默认: ${t.isDefault ? '是' : '否'}`);
        console.log(`   - 启用: ${t.isActive ? '是' : '否'}`);
        console.log(`   - 版本: ${t.version}`);
        console.log(`   - 创建时间: ${t.createdAt}`);
      });
    } else {
      console.log('\n💡 提示: 表是空的,需要创建模板');
      console.log('   可以通过以下方式创建:');
      console.log('   1. 使用 API: POST /api/order/v1/receipt-templates');
      console.log('   2. 运行种子脚本: npx ts-node scripts/seed-receipt-template.ts');
      console.log('   3. 使用 Prisma Studio: http://localhost:5555');
    }
    
  } catch (error: any) {
    console.error('❌ 错误:', error.message);
    
    if (error.code === 'P2021') {
      console.log('\n💡 表不存在,需要运行迁移:');
      console.log('   npm run prisma:migrate dev -- --name add_receipt_template');
    }
  }
}

main()
  .catch((e) => {
    console.error('❌ 发生错误:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
