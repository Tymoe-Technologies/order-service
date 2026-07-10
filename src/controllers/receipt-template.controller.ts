import { Request, Response } from 'express';
import { PrismaClient } from '../../node_modules/.prisma/client-order';
import logger from '../utils/logger';
import CloudinaryService from '../services/cloudinary.service';

const prisma = new PrismaClient();

/**
 * 获取租户 ID 的辅助函数
 */
function getTenantId(req: Request): string | undefined {
  // 从 JWT token 中获取 tenantId
  return (req as any).user?.tenantId;
}

/**
 * 票据模板控制器
 */
export class ReceiptTemplateController {
  /**
   * 上传/更新票据模板 logo
   * 使用覆盖策略：同一票据模板的新 logo 会自动替换旧 logo
   * POST /receipt-templates/:id/logo
   */
  async uploadLogo(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const tenantId = getTenantId(req);

      // 检查 Cloudinary 配置
      if (!CloudinaryService.isConfigured()) {
        logger.error('Cloudinary 未配置');
        res.status(500).json({ error: 'Cloudinary 服务未配置，请联系管理员' });
        return;
      }

      // 检查租户 ID
      if (!tenantId) {
        res.status(400).json({
          error: '无法确定租户信息',
          code: 'TENANT_ID_MISSING'
        });
        return;
      }

      // 检查票据模板是否存在
      const existingTemplate = await prisma.receiptTemplate.findFirst({
        where: {
          id: id,
          tenantId: tenantId
        }
      });

      if (!existingTemplate) {
        res.status(404).json({ error: '票据模板不存在' });
        return;
      }

      // 检查文件是否上传
      const file = (req as any).file;
      if (!file) {
        res.status(400).json({ error: '请上传 logo 文件' });
        return;
      }

      // 验证文件类型
      const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/webp'];
      if (!allowedMimeTypes.includes(file.mimetype)) {
        res.status(400).json({
          error: '不支持的图片格式',
          allowedFormats: ['JPG', 'PNG', 'WebP']
        });
        return;
      }

      // 验证文件大小（5MB 限制）
      const maxSize = 5 * 1024 * 1024; // 5MB
      if (file.size > maxSize) {
        res.status(400).json({
          error: '图片文件过大',
          maxSize: '5MB',
          actualSize: `${(file.size / 1024 / 1024).toFixed(2)}MB`
        });
        return;
      }

      logger.info('开始上传票据模板 logo', {
        receiptTemplateId: id,
        tenantId,
        fileName: file.originalname,
        fileSize: file.size,
        mimeType: file.mimetype
      });

      // 上传到 Cloudinary（使用覆盖策略）
      const uploadResult = await CloudinaryService.uploadReceiptLogo(
        file.buffer,
        tenantId,
        id
      );

      if (!uploadResult.success) {
        res.status(500).json({
          error: '图片上传失败',
          details: uploadResult.error
        });
        return;
      }

      // 更新数据库中的 logo URL
      const updatedTemplate = await prisma.receiptTemplate.update({
        where: { id },
        data: {
          logoUrl: uploadResult.url,
          updatedAt: new Date()
        }
      });

      logger.info('票据模板 logo 上传成功', {
        receiptTemplateId: id,
        templateName: updatedTemplate.name,
        logoUrl: uploadResult.url
      });

      res.json({
        message: 'Logo 上传成功',
        template: updatedTemplate,
        logo: {
          url: uploadResult.url,
          publicId: uploadResult.publicId
        }
      });
    } catch (error: any) {
      logger.error('上传票据模板 logo 失败', {
        receiptTemplateId: req.params.id,
        error: error.message
      });
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * 删除票据模板 logo
   * DELETE /receipt-templates/:id/logo
   */
  async deleteLogo(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const tenantId = getTenantId(req);

      // 检查租户 ID
      if (!tenantId) {
        res.status(400).json({
          error: '无法确定租户信息',
          code: 'TENANT_ID_MISSING'
        });
        return;
      }

      // 检查票据模板是否存在
      const existingTemplate = await prisma.receiptTemplate.findFirst({
        where: {
          id: id,
          tenantId: tenantId
        }
      });

      if (!existingTemplate) {
        res.status(404).json({ error: '票据模板不存在' });
        return;
      }

      // 如果没有 logo，直接返回成功
      if (!existingTemplate.logoUrl) {
        res.json({ message: '票据模板没有 logo' });
        return;
      }

      logger.info('开始删除票据模板 logo', {
        receiptTemplateId: id,
        tenantId
      });

      // 从 Cloudinary 删除
      const deleteResult = await CloudinaryService.deleteReceiptLogo(tenantId, id);

      if (!deleteResult.success) {
        logger.warn('Cloudinary 删除失败，但仍继续更新数据库', {
          receiptTemplateId: id,
          error: deleteResult.error
        });
      }

      // 更新数据库，移除 logo URL
      const updatedTemplate = await prisma.receiptTemplate.update({
        where: { id },
        data: {
          logoUrl: null,
          updatedAt: new Date()
        }
      });

      logger.info('票据模板 logo 删除成功', {
        receiptTemplateId: id,
        templateName: updatedTemplate.name
      });

      res.json({
        message: 'Logo 删除成功',
        template: updatedTemplate
      });
    } catch (error: any) {
      logger.error('删除票据模板 logo 失败', {
        receiptTemplateId: req.params.id,
        error: error.message
      });
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * 获取所有票据模板
   * GET /receipt-templates
   */
  async getTemplates(req: Request, res: Response): Promise<void> {
    try {
      const tenantId = getTenantId(req);

      if (!tenantId) {
        res.status(400).json({
          error: '无法确定租户信息',
          code: 'TENANT_ID_MISSING'
        });
        return;
      }

      const templates = await prisma.receiptTemplate.findMany({
        where: {
          tenantId: tenantId
        },
        orderBy: {
          createdAt: 'desc'
        }
      });

      res.json(templates);
    } catch (error: any) {
      logger.error('获取票据模板列表失败', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * 获取单个票据模板
   * GET /receipt-templates/:id
   */
  async getTemplateById(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const tenantId = getTenantId(req);

      if (!tenantId) {
        res.status(400).json({
          error: '无法确定租户信息',
          code: 'TENANT_ID_MISSING'
        });
        return;
      }

      const template = await prisma.receiptTemplate.findFirst({
        where: {
          id: id,
          tenantId: tenantId
        }
      });

      if (!template) {
        res.status(404).json({ error: '票据模板不存在' });
        return;
      }

      res.json(template);
    } catch (error: any) {
      logger.error('获取票据模板失败', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }
}
