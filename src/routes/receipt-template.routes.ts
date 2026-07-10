import express from 'express';
import { ReceiptTemplateController } from '../controllers/receipt-template.controller';
import { uploadSingleLogo } from '../middleware/upload';
import { authenticate } from '../middleware/auth';

const router = express.Router();
const receiptTemplateController = new ReceiptTemplateController();

/**
 * 票据模板路由
 * 基础路径: /receipt-templates
 */

// ====================================
// 票据模板 CRUD 路由
// ====================================

/**
 * GET /receipt-templates
 * 获取所有票据模板
 */
router.get('/', authenticate, (req, res) => receiptTemplateController.getTemplates(req, res));

/**
 * GET /receipt-templates/:id
 * 获取单个票据模板
 */
router.get('/:id', authenticate, (req, res) => receiptTemplateController.getTemplateById(req, res));

// ====================================
// 票据模板 Logo 管理路由
// ====================================

/**
 * POST /receipt-templates/:id/logo
 * 上传或更新票据模板 logo
 * 使用覆盖策略：同一票据模板上传新 logo 会自动替换旧 logo
 *
 * Content-Type: multipart/form-data
 * Body: { logo: File }
 *
 * 支持格式: JPG, PNG, WebP
 * 最大文件大小: 5MB
 */
router.post('/:id/logo', authenticate, uploadSingleLogo, (req, res) => receiptTemplateController.uploadLogo(req, res));

/**
 * DELETE /receipt-templates/:id/logo
 * 删除票据模板 logo
 */
router.delete('/:id/logo', authenticate, (req, res) => receiptTemplateController.deleteLogo(req, res));

export default router;
