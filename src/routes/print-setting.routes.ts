import { Router } from 'express';
import printSettingController, { pickupNumberConfigController } from '../controllers/print-setting.controller';
import { authenticate } from '../middleware/auth';
import { requireModulePermission } from '../middleware/requirePermission';
import { uploadSingleImage } from '../middleware/upload';

const router = Router();

// 所有路由都需要认证
router.use(authenticate);
router.use(requireModulePermission('printSettings'));

// 取餐号渠道起始配置（放在 :ticketType 之前避免路由冲突）
router.get('/pickup-number-config', pickupNumberConfigController.getConfig.bind(pickupNumberConfigController));
router.put('/pickup-number-config', pickupNumberConfigController.updateConfig.bind(pickupNumberConfigController));

// 获取票据类型元信息（放在 :ticketType 之前避免冲突）
router.get('/meta', printSettingController.getTicketTypeMeta);

// 检查版本号（POS 同步用）
router.get('/check-version', printSettingController.checkVersion);

// 初始化默认打印设置
router.post('/initialize', printSettingController.initialize);

// Logo 上传接口（放在 /:ticketType 之前避免冲突）
router.post('/logo', uploadSingleImage, printSettingController.uploadLogo);
router.delete('/logo', printSettingController.deleteLogo);

// 获取所有打印设置
router.get('/', printSettingController.getAllSettings);

// 获取某种票据类型的设置
router.get('/:ticketType', printSettingController.getSettingByType);

// 更新打印设置
router.put('/:ticketType', printSettingController.updateSetting);

// 启用/禁用票据类型
router.patch('/:ticketType/toggle', printSettingController.toggleSetting);

export default router;
