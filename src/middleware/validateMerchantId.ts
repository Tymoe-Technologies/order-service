/**
 * 商家 ID 验证中间件
 * 把请求头里的 subdomain（或 UUID）翻译成真实的 organizationId
 * 商家身份解析交给 auth-service（通过 organizationService.resolveBySlug，5 分钟缓存）
 */

import { Request, Response, NextFunction } from 'express'
import organizationService from '../services/organization.service'
import logger from '../utils/logger'

// UUID 格式校验
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * 验证商家 ID 格式
 * 规则: /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/i
 * - 开头和结尾必须是字母或数字
 * - 中间可以包含字母、数字、连字符
 * - 长度 3-50 字符
 */
function isValidMerchantId(merchantId: string): boolean {
  const pattern = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/i
  return pattern.test(merchantId)
}

/**
 * 商家 ID 验证中间件
 * 1. 从请求头获取商家标识 (X-Merchant-Id)
 * 2. 验证格式
 * 3. 从数据库查找商家配置 (可以是 subdomain 或 merchantId)
 * 4. 存储配置信息到请求对象中
 */
export async function validateMerchantId(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    // 跳过不需要 X-Merchant-Id 头的路径
    // 这些路径使用 URL 路径参数中的 merchantId 或者是服务间调用
    const skipPaths = [
      /^\/merchants\/[^/]+\/items$/,  // 商品代理端点
      /^\/orders\/[^/]+\/payment-status$/,  // 订单支付状态更新（Finance Service 服务间调用）
/^\/sales-channels/,  // 销售渠道接口（使用 JWT 认证）
      /^\/statistics/,  // 统计接口（使用 JWT 认证）
      /^\/print-settings/,  // 打印设置接口（使用 JWT 认证）
      /^\/print-brand/,     // 品牌配置接口（使用 JWT 认证）
      /^\/receipt-templates/, // 票据模板接口（使用 JWT 认证）
      /^\/public\//,           // 公开端点（前端直接访问，无需 X-Merchant-Id）
      /^\/consumer\//,         // 消费者端点（Consumer JWT 认证，无需 X-Merchant-Id）
    ]
    
    const shouldSkip = skipPaths.some(pattern => pattern.test(req.path))
    if (shouldSkip) {
      logger.info('Skipping merchant ID validation for path', {
        path: req.path,
        method: req.method,
      })
      next()
      return
    }

    // 从请求头获取商家标识
    const merchantIdentifier = req.headers['x-merchant-id']?.toString()?.trim()

    // 检查是否存在
    if (!merchantIdentifier) {
      logger.warn('Missing merchant ID in request', {
        path: req.path,
        method: req.method,
        ip: req.ip,
      })
      res.status(400).json({
        success: false,
        error: {
          code: 'MISSING_MERCHANT_ID',
          message: '缺少商家标识 (X-Merchant-Id header)',
          details: '请求必须包含 X-Merchant-Id 请求头'
        }
      })
      return
    }

    // 验证格式
    if (!isValidMerchantId(merchantIdentifier)) {
      logger.warn('Invalid merchant ID format', {
        merchantId: merchantIdentifier,
        path: req.path,
        method: req.method,
        ip: req.ip,
      })
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_MERCHANT_ID',
          message: '商家 ID 格式无效',
          details: '商家 ID 只能包含字母、数字和连字符，且长度在 3-50 字符之间'
        }
      })
      return
    }

    // 解析商家身份：UUID 直接用；否则当作 subdomain，向 auth-service 解析
    let merchantId: string | null = null
    if (UUID_RE.test(merchantIdentifier)) {
      merchantId = merchantIdentifier
    } else {
      const org = await organizationService.resolveBySlug(merchantIdentifier)
      if (org) {
        merchantId = org.id
      }
    }

    if (!merchantId) {
      logger.warn('Merchant not found', {
        merchantIdentifier,
        path: req.path,
        method: req.method,
        ip: req.ip,
      })
      res.status(404).json({
        success: false,
        error: {
          code: 'MERCHANT_NOT_FOUND',
          message: '商家不存在',
          details: `找不到商家标识: ${merchantIdentifier}`,
        },
      })
      return
    }

    // 注意：不再挂 merchantConfig（点单配置由真正需要它的 controller 自行从 db 查询）
    // 也不再检查 enabled 状态，业务层（如门店列表、下单接口）按需判断
    ;(req as any).merchantId = merchantId
    logger.debug('Merchant validated', { merchantId, merchantIdentifier })

    next()
  } catch (error: any) {
    logger.error('Error in merchant validation middleware:', error)
    res.status(500).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: '商家验证失败',
        details: error.message
      }
    })
  }
}

/**
 * 导出验证函数供测试或其他用途
 */
export { isValidMerchantId }
