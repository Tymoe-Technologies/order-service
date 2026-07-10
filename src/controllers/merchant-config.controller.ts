import { Request, Response } from 'express';
import * as merchantConfigService from '../services/merchant-config.service';
import {
  createConfigSchema,
  updateConfigSchema,
} from '../validators/merchant-config.validator';
import logger from '../utils/logger';
import printSettingService from '../services/print-setting.service';

/**
 * 根据商家 ID 获取配置
 * GET /api/order/v1/merchants/:merchantId/config
 * 响应中额外包含 labelDimensions（来自 ITEM_LABEL 打印设置），供前端自定义标签编辑器使用
 */
export async function getConfigByMerchantId(req: Request, res: Response) {
  try {
    const { merchantId } = req.params;
    const requestMerchantId = (req as any).merchantId;

    // 验证 URL 参数中的 merchantId 与中间件中的 merchantId 一致（商家隔离）
    if (merchantId !== requestMerchantId) {
      logger.warn('Merchant ID mismatch', {
        urlMerchantId: merchantId,
        headerMerchantId: requestMerchantId,
      });
      return res.status(403).json({
        success: false,
        error: {
          code: 'MERCHANT_ID_MISMATCH',
          message: '无权访问该商家的配置',
        },
      });
    }

    // 按需从数据库读取点单配置（不再依赖中间件预加载）
    const merchantConfig = await merchantConfigService.getConfigByMerchantId(requestMerchantId);
    if (!merchantConfig) {
      return res.status(404).json({
        success: false,
        error: { code: 'CONFIG_NOT_FOUND', message: '商家点单配置未初始化' },
      });
    }

    // 尝试获取 ITEM_LABEL 打印设置，提取标签尺寸供前端编辑器使用
    // 如果未初始化则使用默认值，不影响主配置返回
    let labelDimensions = { width: 40, height: 30 };
    try {
      const labelSetting = await printSettingService.getSettingByType(requestMerchantId, 'ITEM_LABEL');
      const config = labelSetting.config as any;
      if (config?.labelWidth && config?.labelHeight) {
        labelDimensions = {
          width: config.labelWidth,
          height: config.labelHeight,
        };
      }
    } catch {
      // 打印设置未初始化时使用默认尺寸 40×30mm
    }

    res.json({
      success: true,
      data: {
        ...merchantConfig,
        labelDimensions,
      },
    });
  } catch (error: any) {
    logger.error('Error in getConfigByMerchantId:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: '获取配置失败',
        details: error.message,
      },
    });
  }
}

/**
 * 创建商家配置
 * POST /api/order/v1/merchants/:merchantId/config
 *
 * 支持两种创建模式：
 * 1. 主店创建：body 需要包含 subdomain，不包含 parentMerchantId
 * 2. 分店创建：body 需要包含 parentMerchantId，subdomain 可选（会从主店继承）
 */
export async function createConfig(req: Request, res: Response) {
  try {
    const { merchantId } = req.params;
    const requestMerchantId = (req as any).merchantId;

    // 验证 URL 参数中的 merchantId 与中间件中的 merchantId 一致（商家隔离）
    if (merchantId !== requestMerchantId) {
      logger.warn('Merchant ID mismatch', {
        urlMerchantId: merchantId,
        headerMerchantId: requestMerchantId,
      });
      return res.status(403).json({
        success: false,
        error: {
          code: 'MERCHANT_ID_MISMATCH',
          message: '无权创建该商家的配置',
        },
      });
    }

    // 验证请求体
    const { error, value } = createConfigSchema.validate({
      ...req.body,
      merchantId,
    });

    if (error) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: error.details[0].message,
          details: error.details,
        },
      });
    }

    const config = await merchantConfigService.createConfig(value);

    res.status(201).json({
      success: true,
      data: config,
    });
  } catch (error: any) {
    logger.error('Error in createConfig:', error);

    if (error.message === 'Merchant already has a configuration') {
      return res.status(409).json({
        success: false,
        error: { code: 'CONFIG_EXISTS', message: '该商家已有配置' },
      });
    }

    if (error.message === 'Organization not found in auth-service') {
      return res.status(404).json({
        success: false,
        error: { code: 'ORG_NOT_FOUND', message: '商家在 auth-service 中不存在' },
      });
    }

    if (error.message === 'Parent merchant has not enabled online ordering') {
      return res.status(409).json({
        success: false,
        error: { code: 'PARENT_NOT_ENABLED', message: '主店未启用在线点单，无法启用子店' },
      });
    }

    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: '创建配置失败', details: error.message },
    });
  }
}

/**
 * 更新商家配置
 * PUT /api/order/v1/merchants/:merchantId/config
 */
export async function updateConfig(req: Request, res: Response) {
  try {
    const { merchantId } = req.params;

    // 验证请求体
    const { error, value } = updateConfigSchema.validate(req.body);

    if (error) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: error.details[0].message,
          details: error.details,
        },
      });
    }

    const config = await merchantConfigService.updateConfig(merchantId, value);

    res.json({
      success: true,
      data: config,
    });
  } catch (error: any) {
    logger.error('Error in updateConfig:', error);

    if (error.message === 'Merchant config not found' || error.code === 'P2025') {
      return res.status(404).json({
        success: false,
        error: { code: 'CONFIG_NOT_FOUND', message: '未找到该商家的配置' },
      });
    }

    if (error.message === 'Parent merchant has not enabled online ordering') {
      return res.status(409).json({
        success: false,
        error: { code: 'PARENT_NOT_ENABLED', message: '主店未启用在线点单，无法启用子店' },
      });
    }

    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: '更新配置失败', details: error.message },
    });
  }
}

/**
 * 删除商家配置
 * DELETE /api/order/v1/merchants/:merchantId/config
 */
export async function deleteConfig(req: Request, res: Response) {
  try {
    const { merchantId } = req.params;

    await merchantConfigService.deleteConfig(merchantId);

    res.json({
      success: true,
      message: '配置已删除',
    });
  } catch (error: any) {
    logger.error('Error in deleteConfig:', error);

    if (error.code === 'P2025') {
      return res.status(404).json({
        success: false,
        error: {
          code: 'CONFIG_NOT_FOUND',
          message: '未找到该商家的配置',
        },
      });
    }

    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: '删除配置失败',
        details: error.message,
      },
    });
  }
}

// 注意：子域名唯一性检查与 subdomain 解析已迁移到 auth-service。
// 旧接口 POST /merchant-config/check-subdomain 和 GET /merchant-config/by-subdomain/:subdomain 已删除。

/**
 * 获取所有配置列表(管理员)
 * GET /api/order/v1/admin/merchant-configs
 */
export async function getAllConfigs(req: Request, res: Response) {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;

    const result = await merchantConfigService.getAllConfigs(page, limit);

    res.json({
      success: true,
      data: result,
    });
  } catch (error: any) {
    logger.error('Error in getAllConfigs:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: '获取配置列表失败',
        details: error.message,
      },
    });
  }
}

/**
 * 获取公开的商家门店列表（前端使用）
 * GET /api/order/v1/public/merchants/:merchantId/stores
 *
 * 返回商家的在线点单配置与组织信息的合并数据
 * 组织信息（orgName、location、phone、email）直接从 Order Service 数据库获取
 */
export async function getPublicMerchantStores(req: Request, res: Response) {
  try {
    const { merchantId } = req.params;

    if (!merchantId) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: 'merchantId is required',
        },
      });
    }

    // 获取商家的在线点单配置（主店和所有分店；不过滤 enabled）
    // 注意：本接口只返回点单业务字段。门店名称/地址/经纬度/电话由前端调 auth-service
    // GET /organizations/public/resolve/:slug 拿到，按 storeId 与本接口的结果 join。
    const stores = await merchantConfigService.getMerchantStores(merchantId);

    if (!stores || stores.length === 0) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'No store configuration found for this merchant',
        },
      });
    }

    res.json({
      success: true,
      data: stores,
    });
  } catch (error: any) {
    logger.error('Error in getPublicMerchantStores:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to retrieve store information',
        details: error.message,
      },
    });
  }
}

// resolveMerchant 已迁移到 auth-service：
//   GET /api/auth-service/v1/organizations/public/resolve/:slug
// 前端的 MerchantContext 应直接调 auth-service 拿品牌身份和门店列表（OrgName/地址/经纬度），
// 门店的点单业务字段（enabled / businessHours / deliveryFee）仍由本服务的 /public/merchants/:id/stores 提供。
