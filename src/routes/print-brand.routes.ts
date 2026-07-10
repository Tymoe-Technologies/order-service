import { Router } from 'express';
import printBrandController from '../controllers/print-brand.controller';
import { authenticate } from '../middleware/auth';
import { uploadSingleImage } from '../middleware/upload';

const router = Router();

router.use(authenticate);

// 获取品牌配置（含 Logo URL）
router.get('/', printBrandController.getBrandProfile);

// 上传品牌 Logo（同时写入数据库）
router.post('/logo', uploadSingleImage, printBrandController.uploadLogo);

// 删除品牌 Logo
router.delete('/logo', printBrandController.deleteLogo);

export default router;
