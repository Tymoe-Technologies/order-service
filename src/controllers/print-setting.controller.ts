import { Request, Response, NextFunction } from 'express';
import printSettingService, { pickupNumberConfigService } from '../services/print-setting.service';
import printBrandService from '../services/print-brand.service';
import { successResponse } from '../utils/response';
import logger from '../utils/logger';
import CloudinaryService from '../services/cloudinary.service';

/*
  可配置的票据类型。DAILY_REPORT / SHIFT_REPORT 已下线 ——
  它们的 config 从来没有读取方（见 print-setting.service 的说明）。
  仍然放行是为了让存量租户那两行能被读/改（比如关掉），只是后台不再提供入口。
*/
const VALID_TICKET_TYPES = ['CUSTOMER_RECEIPT', 'KITCHEN_TICKET', 'ITEM_LABEL', 'DAILY_REPORT', 'SHIFT_REPORT'];

export class PrintSettingController {
  /**
   * 获取所有打印设置
   * GET /print-settings
   */
  async getAllSettings(req: Request, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;
      logger.info('获取所有打印设置', { tenantId });
      const settings = await printSettingService.getAllSettings(tenantId);
      successResponse(res, settings);
    } catch (error) {
      next(error);
    }
  }

  /**
   * 获取票据类型元信息
   * GET /print-settings/meta
   */
  async getTicketTypeMeta(_req: Request, res: Response, next: NextFunction) {
    try {
      const meta = printSettingService.getTicketTypeMeta();
      successResponse(res, meta);
    } catch (error) {
      next(error);
    }
  }

  /**
   * 检查版本号（POS 同步用）
   * GET /print-settings/check-version?versions=CUSTOMER_RECEIPT:3,KITCHEN_TICKET:2
   */
  async checkVersion(req: Request, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;
      const versionsStr = req.query.versions as string | undefined;
      const result = await printSettingService.checkVersion(tenantId, versionsStr);
      successResponse(res, result);
    } catch (error) {
      next(error);
    }
  }

  /**
   * 初始化默认打印设置
   * POST /print-settings/initialize
   */
  async initialize(req: Request, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;
      const userId = req.user!.userId;
      // 提取 JWT token 用于调用 Auth Service
      const token = req.headers.authorization?.replace('Bearer ', '');
      logger.info('初始化打印设置', { tenantId, userId });
      const settings = await printSettingService.initialize(tenantId, userId, token);
      successResponse(res, settings, 201);
    } catch (error) {
      next(error);
    }
  }

  /**
   * 获取某种票据类型的设置
   * GET /print-settings/:ticketType
   */
  async getSettingByType(req: Request, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;
      const { ticketType } = req.params;

      if (!VALID_TICKET_TYPES.includes(ticketType)) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_TICKET_TYPE', message: `无效的票据类型: ${ticketType}` },
        });
        return;
      }

      const setting = await printSettingService.getSettingByType(tenantId, ticketType);
      successResponse(res, setting);
    } catch (error) {
      next(error);
    }
  }

  /**
   * 更新打印设置
   * PUT /print-settings/:ticketType
   */
  async updateSetting(req: Request, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;
      const { ticketType } = req.params;

      if (!VALID_TICKET_TYPES.includes(ticketType)) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_TICKET_TYPE', message: `无效的票据类型: ${ticketType}` },
        });
        return;
      }

      // 提取 JWT token 用于调用 Auth Service
      const token = req.headers.authorization?.replace('Bearer ', '');
      const { isEnabled, copies, config } = req.body;
      const setting = await printSettingService.updateSetting(tenantId, ticketType, { isEnabled, copies, config }, token);
      successResponse(res, setting);
    } catch (error) {
      next(error);
    }
  }

  /**
   * 启用/禁用票据类型
   * PATCH /print-settings/:ticketType/toggle
   */
  async toggleSetting(req: Request, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;
      const { ticketType } = req.params;

      if (!VALID_TICKET_TYPES.includes(ticketType)) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_TICKET_TYPE', message: `无效的票据类型: ${ticketType}` },
        });
        return;
      }

      const setting = await printSettingService.toggleSetting(tenantId, ticketType);
      successResponse(res, setting);
    } catch (error) {
      next(error);
    }
  }

  /**
   * 上传打印设置 Logo（租户级别）
   * POST /print-settings/logo
   */
  async uploadLogo(req: Request, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;

      // 检查 Cloudinary 配置
      if (!CloudinaryService.isConfigured()) {
        logger.error('Cloudinary 未配置');
        res.status(500).json({
          success: false,
          error: { code: 'CLOUDINARY_NOT_CONFIGURED', message: 'Cloudinary 服务未配置，请联系管理员' }
        });
        return;
      }

      // 检查文件是否上传
      const file = (req as any).file;
      if (!file) {
        res.status(400).json({
          success: false,
          error: { code: 'FILE_MISSING', message: '请上传图片文件' }
        });
        return;
      }

      // 验证文件类型
      const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/webp'];
      if (!allowedMimeTypes.includes(file.mimetype)) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_FILE_TYPE',
            message: '不支持的图片格式',
            allowedFormats: ['JPG', 'PNG', 'WebP']
          }
        });
        return;
      }

      // 验证文件大小（5MB 限制）
      const maxSize = 5 * 1024 * 1024;
      if (file.size > maxSize) {
        res.status(400).json({
          success: false,
          error: {
            code: 'FILE_TOO_LARGE',
            message: '图片文件过大',
            maxSize: '5MB',
            actualSize: `${(file.size / 1024 / 1024).toFixed(2)}MB`
          }
        });
        return;
      }

      logger.info('开始上传打印设置 logo', {
        tenantId,
        fileName: file.originalname,
        fileSize: file.size,
        mimeType: file.mimetype
      });

      // 上传到 Cloudinary
      const uploadResult = await CloudinaryService.uploadPrintLogo(file.buffer, tenantId);

      if (!uploadResult.success) {
        res.status(500).json({
          success: false,
          error: {
            code: 'UPLOAD_FAILED',
            message: '图片上传失败',
            details: uploadResult.error
          }
        });
        return;
      }

      logger.info('打印设置 logo 上传成功', {
        tenantId,
        logoUrl: uploadResult.url
      });

      // 同步保存到品牌配置表，供其他模板复用
      await printBrandService.upsertLogo(tenantId, uploadResult.url!, uploadResult.publicId ?? '');

      // 同步更新 CUSTOMER_RECEIPT 的 config.sections.storeInfo.logoUrl
      try {
        await printSettingService.updateLogoUrl(tenantId, uploadResult.url!);
        logger.info('已同步 logoUrl 到 CUSTOMER_RECEIPT 打印设置', { tenantId });
      } catch (syncError: any) {
        logger.warn('同步 logoUrl 到打印设置失败（不影响上传结果）', {
          tenantId,
          error: syncError.message,
        });
      }

      successResponse(res, { url: uploadResult.url });
    } catch (error) {
      next(error);
    }
  }

  /**
   * 删除打印设置 Logo
   * DELETE /print-settings/logo
   */
  async deleteLogo(req: Request, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;

      logger.info('开始删除打印设置 logo', { tenantId });

      // 从 Cloudinary 删除
      const deleteResult = await CloudinaryService.deletePrintLogo(tenantId);

      if (!deleteResult.success) {
        logger.warn('Cloudinary 删除失败', {
          tenantId,
          error: deleteResult.error
        });
      }

      logger.info('打印设置 logo 删除成功', { tenantId });

      // 同步清除品牌配置表中的 Logo
      await printBrandService.clearLogo(tenantId);

      // 同步清除 CUSTOMER_RECEIPT 的 logoUrl
      try {
        await printSettingService.updateLogoUrl(tenantId, '');
        logger.info('已清除 CUSTOMER_RECEIPT 打印设置中的 logoUrl', { tenantId });
      } catch (syncError: any) {
        logger.warn('清除打印设置 logoUrl 失败（不影响删除结果）', {
          tenantId,
          error: syncError.message,
        });
      }

      successResponse(res, { message: 'Logo 删除成功' });
    } catch (error) {
      next(error);
    }
  }
}

export default new PrintSettingController();

// ─── 取餐号配置 Controller ──────────────────────────────────────────────────

export class PickupNumberConfigController {
  /**
   * 获取取餐号配置
   * GET /print-settings/pickup-number-config
   */
  async getConfig(req: Request, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;
      const config = await pickupNumberConfigService.getConfig(tenantId);
      successResponse(res, config);
    } catch (error) {
      next(error);
    }
  }

  /**
   * 更新取餐号配置
   * PUT /print-settings/pickup-number-config
   * Body: { startAt: 1, showPrefix: true }
   */
  async updateConfig(req: Request, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;
      const { startAt, showPrefix, channelPrefixes, queueDisplayEnabled } = req.body;

      const result = await pickupNumberConfigService.upsertConfig(tenantId, { startAt, showPrefix, channelPrefixes, queueDisplayEnabled });
      successResponse(res, result);
    } catch (error) {
      next(error);
    }
  }
}

export const pickupNumberConfigController = new PickupNumberConfigController();
