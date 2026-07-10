import printSettingService from './src/services/print-setting.service';
import logger from './src/utils/logger';

async function test() {
  const tenantId = 'a6aee8e9-fc5f-419a-8504-3d106b1a3534';
  
  console.log('\n=== 测试更新打印设置 ===\n');
  
  // 获取当前设置
  const current = await printSettingService.getSettingByType(tenantId, 'CUSTOMER_RECEIPT');
  console.log('当前 version:', current.version);
  console.log('当前 storeInfo:', JSON.stringify((current.config as any)?.sections?.storeInfo, null, 2));
  
  // 更新设置（保持原有 config，触发自动填充）
  console.log('\n调用 updateSetting...\n');
  const updated = await printSettingService.updateSetting(tenantId, 'CUSTOMER_RECEIPT', {
    config: current.config
  });
  
  console.log('\n=== 更新后 ===');
  console.log('新 version:', updated.version);
  console.log('新 storeInfo:', JSON.stringify((updated.config as any)?.sections?.storeInfo, null, 2));
  
  process.exit(0);
}

test().catch(error => {
  console.error('测试失败:', error);
  process.exit(1);
});
