import prisma from './src/utils/prisma';
import printSettingService from './src/services/print-setting.service';

async function test() {
  const tenantId = 'a6aee8e9-fc5f-419a-8504-3d106b1a3534';
  const userId = 'test-user-id';
  
  // 删除现有设置
  await prisma.printSetting.deleteMany({
    where: { tenantId, ticketType: 'CUSTOMER_RECEIPT' }
  });
  
  console.log('已删除现有设置，准备重新初始化...\n');
  
  // 模拟一个 JWT token（实际使用时需要真实的 token）
  const mockToken = 'mock-token-for-testing';
  
  // 重新初始化（不传 token，先测试没有 token 的情况）
  console.log('=== 测试1：不传 token（会使用 ADMIN_API_KEY） ===\n');
  await printSettingService.initialize(tenantId, userId);
  
  const setting1 = await prisma.printSetting.findUnique({
    where: { tenantId_ticketType: { tenantId, ticketType: 'CUSTOMER_RECEIPT' } }
  });
  
  console.log('storeInfo:', JSON.stringify((setting1?.config as any)?.sections?.storeInfo, null, 2));
  console.log('\n提示：需要使用真实的 JWT token 才能成功获取组织信息');
  console.log('请通过 Portal 前端或 Postman 使用真实 JWT token 测试 API\n');
  
  process.exit(0);
}

test().catch(error => {
  console.error('测试失败:', error);
  process.exit(1);
});
