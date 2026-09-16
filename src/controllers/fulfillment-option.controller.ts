import { Request, Response } from 'express';
import * as fulfillmentService from '../services/fulfillment-option.service';
import logger from '../utils/logger';

/**
 * 门店履约方式配置（堂食 / 外带 / 配送 / 路边取餐 / 车道取餐）
 *
 * 管理端接口跟 merchant-config 一样做商家隔离校验；
 * 顾客端读的是下面的 public 接口，无需认证。
 */

/** 校验 URL 上的 merchantId 与中间件解析出来的一致，不一致直接拒 */
function assertSameMerchant(req: Request, res: Response): string | null {
  const { merchantId } = req.params;
  const requestMerchantId = (req as any).merchantId;
  if (requestMerchantId && merchantId !== requestMerchantId) {
    logger.warn('Merchant ID mismatch', { urlMerchantId: merchantId, headerMerchantId: requestMerchantId });
    res.status(403).json({
      success: false,
      error: { code: 'MERCHANT_ID_MISMATCH', message: '无权访问该商家的配置' },
    });
    return null;
  }
  return merchantId;
}

/**
 * GET /api/order/v1/merchants/:merchantId/fulfillment-options
 * 返回全部五种（含未配置过的，按默认值补齐），供 Portal 配置界面渲染
 */
export async function listOptions(req: Request, res: Response) {
  try {
    const merchantId = assertSameMerchant(req, res);
    if (!merchantId) return;

    const data = await fulfillmentService.listOptions(merchantId);
    return res.json({ success: true, data });
  } catch (error: any) {
    logger.error('获取履约方式配置失败', { error: error.message });
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: error.message },
    });
  }
}

/**
 * PUT /api/order/v1/merchants/:merchantId/fulfillment-options
 * body: { options: [{ fulfillmentType, enabled, displayOrder, config }] }
 *
 * 整份提交。至少要留一种启用 —— 一种都不开等于关店，商家真想关店该用
 * MerchantOnlineOrderConfig.enabled，而不是把履约方式全关掉（那会让顾客端
 * 显示一个没有任何选项的空选择器，看起来像坏了）。
 */
export async function saveOptions(req: Request, res: Response) {
  try {
    const merchantId = assertSameMerchant(req, res);
    if (!merchantId) return;

    const { options } = req.body;
    if (!Array.isArray(options) || options.length === 0) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_PAYLOAD', message: 'options 必须是非空数组' },
      });
    }

    for (const o of options) {
      if (!o?.fulfillmentType) {
        return res.status(400).json({
          success: false,
          error: { code: 'INVALID_PAYLOAD', message: '每项必须带 fulfillmentType' },
        });
      }
    }

    // 合并出提交后的最终状态再判断：只提交了部分方式时，不能拿这次的入参当全集
    const current = await fulfillmentService.listOptions(merchantId);
    const merged = new Map(current.map(c => [c.fulfillmentType as string, c.enabled]));
    for (const o of options) {
      if (o.enabled !== undefined) merged.set(o.fulfillmentType, !!o.enabled);
    }
    if (![...merged.values()].some(Boolean)) {
      return res.status(400).json({
        success: false,
        error: { code: 'NO_FULFILLMENT_ENABLED', message: '至少要启用一种履约方式' },
      });
    }

    const data = await fulfillmentService.saveOptions(merchantId, options);
    return res.json({ success: true, data });
  } catch (error: any) {
    logger.error('保存履约方式配置失败', { error: error.message });
    const isBadInput = error.message?.includes('不支持的履约方式');
    return res.status(isBadInput ? 400 : 500).json({
      success: false,
      error: { code: isBadInput ? 'INVALID_FULFILLMENT_TYPE' : 'INTERNAL_ERROR', message: error.message },
    });
  }
}

/**
 * GET /api/order/v1/public/merchants/:merchantId/fulfillment-options
 * 顾客端用：只返回启用了的，无需认证
 */
export async function listPublicOptions(req: Request, res: Response) {
  try {
    const { merchantId } = req.params;
    const all = await fulfillmentService.listOptions(merchantId);
    /*
      原来这里还给一个 posDefault（商家配的「POS 默认下单方式」）。已去掉：
      POS 的履约方式由下单入口决定，不由商家配（见 fulfillment-option.service
      里 getPosDefaultType 被删处的说明）。

      去掉这个字段不破坏兼容：唯一解析过它的 consumer-app 写的是
      `json?.posDefault ?? 'DINE_IN'`，而且拿到之后从没用过。
    */
    return res.json({
      success: true,
      data: all.filter(o => o.enabled),
    });
  } catch (error: any) {
    logger.error('获取公开履约方式失败', { error: error.message });
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: error.message },
    });
  }
}
