import { Request, Response, NextFunction } from 'express';
import printBrandService from '../services/print-brand.service';
import printSettingService from '../services/print-setting.service';
import CloudinaryService from '../services/cloudinary.service';
import { successResponse } from '../utils/response';
import logger from '../utils/logger';

export class PrintBrandController {
  /**
   * 获取品牌配置
   * GET /print-brand
   */
  async getBrandProfile(req: Request, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;
      const profile = await printBrandService.getBrandProfile(tenantId);
      // 未配置时返回空对象，前端可判断 null
      successResponse(res, profile ?? null);
    } catch (error) {
      next(error);
    }
  }

  /**
   * 上传品牌 Logo（自动保存 URL 到数据库）
   * POST /print-brand/logo
   */
  async uploadLogo(req: Request, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;

      if (!CloudinaryService.isConfigured()) {
        res.status(500).json({
          success: false,
          error: { code: 'CLOUDINARY_NOT_CONFIGURED', message: 'Cloudinary 服务未配置，请联系管理员' },
        });
        return;
      }

      const file = (req as any).file;
      if (!file) {
        res.status(400).json({
          success: false,
          error: { code: 'FILE_MISSING', message: '请上传图片文件' },
        });
        return;
      }

      const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/webp'];
      if (!allowedMimeTypes.includes(file.mimetype)) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_FILE_TYPE', message: '不支持的图片格式', allowedFormats: ['JPG', 'PNG', 'WebP'] },
        });
        return;
      }

      const maxSize = 5 * 1024 * 1024;
      if (file.size > maxSize) {
        res.status(400).json({
          success: false,
          error: { code: 'FILE_TOO_LARGE', message: '图片文件过大，最大 5MB' },
        });
        return;
      }

      logger.info('开始上传品牌 Logo', { tenantId, fileName: file.originalname, fileSize: file.size });

      const uploadResult = await CloudinaryService.uploadPrintLogo(file.buffer, tenantId);

      if (!uploadResult.success || !uploadResult.url) {
        res.status(500).json({
          success: false,
          error: { code: 'UPLOAD_FAILED', message: '图片上传失败', details: uploadResult.error },
        });
        return;
      }

      // 将 URL 和 publicId 持久化到数据库
      const profile = await printBrandService.upsertLogo(tenantId, uploadResult.url, uploadResult.publicId ?? '');

      // 同步更新 CUSTOMER_RECEIPT 的 logoUrl
      try {
        await printSettingService.updateLogoUrl(tenantId, uploadResult.url);
        logger.info('品牌 Logo 已同步到 CUSTOMER_RECEIPT 打印设置', { tenantId });
      } catch (syncError: any) {
        logger.warn('同步品牌 Logo 到打印设置失败（不影响上传结果）', {
          tenantId,
          error: syncError.message,
        });
      }

      successResponse(res, { url: profile.logoUrl, profile });
    } catch (error) {
      next(error);
    }
  }

  /**
   * 删除品牌 Logo
   * DELETE /print-brand/logo
   */
  async deleteLogo(req: Request, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;

      // 从 Cloudinary 删除
      const deleteResult = await CloudinaryService.deletePrintLogo(tenantId);
      if (!deleteResult.success) {
        logger.warn('Cloudinary 品牌 Logo 删除失败，继续清除数据库记录', { tenantId, error: deleteResult.error });
      }

      // 清除数据库中的 URL
      await printBrandService.clearLogo(tenantId);

      // 同步清除 CUSTOMER_RECEIPT 的 logoUrl
      try {
        await printSettingService.updateLogoUrl(tenantId, '');
        logger.info('已清除 CUSTOMER_RECEIPT 打印设置中的品牌 logoUrl', { tenantId });
      } catch (syncError: any) {
        logger.warn('清除打印设置 logoUrl 失败（不影响删除结果）', {
          tenantId,
          error: syncError.message,
        });
      }

      successResponse(res, { message: '品牌 Logo 已删除' });
    } catch (error) {
      next(error);
    }
  }
}

export default new PrintBrandController();
