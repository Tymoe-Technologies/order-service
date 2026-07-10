import { v2 as cloudinary, UploadApiResponse, UploadApiErrorResponse } from 'cloudinary';
import logger from '../utils/logger';

// 初始化标记，用于确保配置只运行一次
let isConfigured = false;

// 延迟配置 Cloudinary（在首次使用时配置，而不是导入时）
function ensureCloudinaryConfigured(): void {
  if (isConfigured) return;

  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });

  isConfigured = true;
}

export interface UploadResult {
  success: boolean;
  url?: string;
  publicId?: string;
  error?: string;
}

export class CloudinaryService {
  // 票据 logo 存储的文件夹前缀
  private static readonly RECEIPT_LOGO_FOLDER_PREFIX = 'tymoe/receipts';
  // 打印设置 logo 存储的文件夹前缀
  private static readonly PRINT_LOGO_FOLDER_PREFIX = 'tymoe/print-settings';

  /**
   * 生成票据 logo 的 public_id
   * 格式: tymoe/receipts/{tenant_id}/{receipt_template_id}
   * 使用固定的 public_id 实现覆盖策略
   */
  private static getReceiptLogoPublicId(tenantId: string, receiptTemplateId: string): string {
    return `${this.RECEIPT_LOGO_FOLDER_PREFIX}/${tenantId}/${receiptTemplateId}`;
  }

  /**
   * 上传票据 logo
   * 使用 overwrite 策略：同一个票据模板上传新图片会自动覆盖旧图片
   * @param file - 文件 Buffer 或 base64 字符串
   * @param tenantId - 租户 ID
   * @param receiptTemplateId - 票据模板 ID
   */
  static async uploadReceiptLogo(
    file: Buffer | string,
    tenantId: string,
    receiptTemplateId: string
  ): Promise<UploadResult> {
    const publicId = this.getReceiptLogoPublicId(tenantId, receiptTemplateId);

    try {
      // 确保 Cloudinary 已配置
      ensureCloudinaryConfigured();

      // 如果是 Buffer，转换为 base64 data URI
      const uploadData = Buffer.isBuffer(file)
        ? `data:image/jpeg;base64,${file.toString('base64')}`
        : file;

      const result: UploadApiResponse = await cloudinary.uploader.upload(uploadData, {
        public_id: publicId,
        overwrite: true,           // 关键：启用覆盖模式
        invalidate: true,          // 清除 CDN 缓存
        resource_type: 'image',
        // 图片优化配置
        transformation: [
          {
            width: 800,            // 限制最大宽度
            height: 800,           // 限制最大高度
            crop: 'limit',         // 保持比例，不超过限制
            quality: 'auto:good',  // 自动优化质量
            fetch_format: 'auto',  // 自动选择最佳格式（webp/avif）
          }
        ],
      });

      logger.info('Cloudinary 票据 logo 上传成功', {
        receiptTemplateId,
        tenantId,
        publicId: result.public_id,
        url: result.secure_url,
        bytes: result.bytes,
        format: result.format,
      });

      return {
        success: true,
        url: result.secure_url,
        publicId: result.public_id,
      };
    } catch (error: any) {
      const cloudinaryError = error as UploadApiErrorResponse;
      logger.error('Cloudinary 票据 logo 上传失败', {
        receiptTemplateId,
        tenantId,
        publicId,
        error: cloudinaryError.message || error.message,
      });

      return {
        success: false,
        error: cloudinaryError.message || error.message || '图片上传失败',
      };
    }
  }

  /**
   * 删除票据 logo
   * @param tenantId - 租户 ID
   * @param receiptTemplateId - 票据模板 ID
   */
  static async deleteReceiptLogo(tenantId: string, receiptTemplateId: string): Promise<UploadResult> {
    const publicId = this.getReceiptLogoPublicId(tenantId, receiptTemplateId);

    try {
      // 确保 Cloudinary 已配置
      ensureCloudinaryConfigured();

      const result = await cloudinary.uploader.destroy(publicId, {
        invalidate: true, // 清除 CDN 缓存
      });

      if (result.result === 'ok' || result.result === 'not found') {
        logger.info('Cloudinary 票据 logo 删除成功', {
          receiptTemplateId,
          tenantId,
          publicId,
          result: result.result,
        });

        return { success: true };
      }

      logger.warn('Cloudinary 票据 logo 删除返回异常结果', {
        receiptTemplateId,
        tenantId,
        publicId,
        result,
      });

      return {
        success: false,
        error: `删除操作返回: ${result.result}`,
      };
    } catch (error: any) {
      logger.error('Cloudinary 票据 logo 删除失败', {
        receiptTemplateId,
        tenantId,
        publicId,
        error: error.message,
      });

      return {
        success: false,
        error: error.message || '图片删除失败',
      };
    }
  }

  /**
   * 获取图片的优化 URL（带变换参数）
   * @param url - 原始 Cloudinary URL
   * @param options - 变换选项
   */
  static getOptimizedUrl(
    url: string,
    options: {
      width?: number;
      height?: number;
      quality?: string;
    } = {}
  ): string {
    if (!url) return url;

    // 如果不是 Cloudinary URL，直接返回
    if (!url.includes('cloudinary.com')) {
      return url;
    }

    const { width = 400, height = 400, quality = 'auto' } = options;

    // 构建变换参数
    const transformation = `w_${width},h_${height},c_limit,q_${quality},f_auto`;

    // 插入变换参数到 URL
    // Cloudinary URL 格式: https://res.cloudinary.com/{cloud}/image/upload/{transformations}/{public_id}
    return url.replace('/upload/', `/upload/${transformation}/`);
  }

  /**
   * 生成打印设置 logo 的 public_id
   * 格式: tymoe/print-settings/{tenant_id}/logo
   * 租户级别的全局 Logo
   */
  private static getPrintLogoPublicId(tenantId: string): string {
    return `${this.PRINT_LOGO_FOLDER_PREFIX}/${tenantId}/logo`;
  }

  /**
   * 上传打印设置 Logo（租户级别）
   * @param file - 文件 Buffer 或 base64 字符串
   * @param tenantId - 租户 ID
   */
  static async uploadPrintLogo(
    file: Buffer | string,
    tenantId: string
  ): Promise<UploadResult> {
    const publicId = this.getPrintLogoPublicId(tenantId);

    try {
      ensureCloudinaryConfigured();

      const uploadData = Buffer.isBuffer(file)
        ? `data:image/jpeg;base64,${file.toString('base64')}`
        : file;

      const result: UploadApiResponse = await cloudinary.uploader.upload(uploadData, {
        public_id: publicId,
        overwrite: true,
        invalidate: true,
        resource_type: 'image',
        transformation: [
          {
            width: 800,
            height: 800,
            crop: 'limit',
            quality: 'auto:good',
            fetch_format: 'auto',
          }
        ],
      });

      logger.info('Cloudinary 打印设置 logo 上传成功', {
        tenantId,
        publicId: result.public_id,
        url: result.secure_url,
      });

      return {
        success: true,
        url: result.secure_url,
        publicId: result.public_id,
      };
    } catch (error: any) {
      const cloudinaryError = error as UploadApiErrorResponse;
      logger.error('Cloudinary 打印设置 logo 上传失败', {
        tenantId,
        publicId,
        error: cloudinaryError.message || error.message,
      });

      return {
        success: false,
        error: cloudinaryError.message || error.message || '图片上传失败',
      };
    }
  }

  /**
   * 删除打印设置 Logo
   * @param tenantId - 租户 ID
   */
  static async deletePrintLogo(tenantId: string): Promise<UploadResult> {
    const publicId = this.getPrintLogoPublicId(tenantId);

    try {
      ensureCloudinaryConfigured();

      const result = await cloudinary.uploader.destroy(publicId, {
        invalidate: true,
      });

      if (result.result === 'ok' || result.result === 'not found') {
        logger.info('Cloudinary 打印设置 logo 删除成功', {
          tenantId,
          publicId,
          result: result.result,
        });

        return { success: true };
      }

      logger.warn('Cloudinary 打印设置 logo 删除返回异常结果', {
        tenantId,
        publicId,
        result,
      });

      return {
        success: false,
        error: `删除操作返回: ${result.result}`,
      };
    } catch (error: any) {
      logger.error('Cloudinary 打印设置 logo 删除失败', {
        tenantId,
        publicId,
        error: error.message,
      });

      return {
        success: false,
        error: error.message || '图片删除失败',
      };
    }
  }

  /**
   * 检查 Cloudinary 配置是否有效
   */
  static isConfigured(): boolean {
    const hasConfig = !!(
      process.env.CLOUDINARY_CLOUD_NAME &&
      process.env.CLOUDINARY_API_KEY &&
      process.env.CLOUDINARY_API_SECRET
    );

    if (hasConfig) {
      logger.debug('Cloudinary 配置已验证', {
        cloud_name: process.env.CLOUDINARY_CLOUD_NAME ? '✓' : '✗',
        api_key: process.env.CLOUDINARY_API_KEY ? '✓' : '✗',
        api_secret: process.env.CLOUDINARY_API_SECRET ? '✓' : '✗'
      });
    }

    return hasConfig;
  }
}

export default CloudinaryService;
