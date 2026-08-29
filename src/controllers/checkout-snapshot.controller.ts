import { Request, Response } from 'express'
import * as checkoutSnapshotService from '../services/checkout-snapshot.service'
// 用共享常量而不是就地写字面量：加履约方式时只改一处，不会再出现
// 「枚举加了但校验白名单没加，那种单直接被拒」
import { FULFILLMENT_TYPES } from '../services/fulfillment-option.service'

/**
 * 创建结账快照
 * POST /api/order/v1/checkout-snapshots
 * Header: X-Merchant-Id
 */
export async function createSnapshot(req: Request, res: Response) {
  try {
    const merchantId = req.headers['x-merchant-id'] as string

    if (!merchantId) {
      return res.status(400).json({
        success: false,
        error: 'Missing X-Merchant-Id header',
      })
    }

    const { orderType, customer, items, tipAmount, notes, expectedTotal, customLabelData, deliveryAddress, consumerId, grantedRewardId, deliveryFee, uberDeliveryFee, deliveryQuoteId, isScheduled, scheduledAt, salesChannelId, giftCardDeductionEstimate, supplySelections, vehicleInfo } = req.body

    // 验证必填字段
    if (!orderType || !customer || !items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: orderType, customer, items',
      })
    }

    if (!customer.name || !customer.phone) {
      return res.status(400).json({
        success: false,
        error: 'Missing required customer fields: name, phone',
      })
    }

    // 验证 orderType
    if (!FULFILLMENT_TYPES.includes(orderType)) {
      return res.status(400).json({
        success: false,
        error: `Invalid orderType. Must be one of: ${FULFILLMENT_TYPES.join(', ')}`,
      })
    }

    // 验证 items（套餐行传 comboId 不传 itemId，普通商品行反之，二选一即可）
    for (const item of items) {
      if ((!item.itemId && !item.comboId) || !item.quantity || item.quantity < 1) {
        return res.status(400).json({
          success: false,
          error: 'Each item must have itemId or comboId, and quantity >= 1',
        })
      }
    }

    // 路边取餐至少要留一个能认出车的信息，否则店员出去找不到人。
    // 不强制具体是哪个字段——有的商家只要车牌，有的看车型颜色
    if (orderType === 'CURBSIDE') {
      const v = vehicleInfo
      const hasAny = v && typeof v === 'object' &&
        [v.make, v.model, v.color, v.plate, v.spot].some((x: any) => typeof x === 'string' && x.trim())
      if (!hasAny) {
        return res.status(400).json({
          success: false,
          error: 'VEHICLE_INFO_REQUIRED',
          message: 'Curbside orders require vehicle information so staff can find you',
        })
      }
    }

    // 耗材答复：quantity 可以是 0（明确不要），但必须带 supplyId
    if (supplySelections !== undefined) {
      if (!Array.isArray(supplySelections)) {
        return res.status(400).json({
          success: false,
          error: 'supplySelections must be an array',
        })
      }
      for (const sel of supplySelections) {
        if (!sel?.supplyId || typeof sel.quantity !== 'number' || sel.quantity < 0) {
          return res.status(400).json({
            success: false,
            error: 'Each supply selection must have supplyId and quantity >= 0',
          })
        }
      }
    }

    const result = await checkoutSnapshotService.createCheckoutSnapshot(merchantId, {
      orderType,
      consumerId,
      customer,
      items,
      tipAmount,
      notes,
      expectedTotal,
      customLabelData,
      deliveryAddress,
      grantedRewardId,
      deliveryFee,
      uberDeliveryFee,
      deliveryQuoteId,
      isScheduled,
      scheduledAt,
      salesChannelId,
      giftCardDeductionEstimate,
      supplySelections,
      // 路边取餐的车辆信息。这里漏过一次：前端传了、service 会存、建单会搬，
      // 唯独 controller 的解构没列它，于是一路走到底都是 null，
      // 店员在小票和订单页上什么都看不到
      vehicleInfo,
    })

    if (!result.success) {
      // 处理价格变化错误
      if (result.error === 'PRICE_CHANGED') {
        return res.status(409).json(result)
      }
      return res.status(400).json(result)
    }

    return res.status(201).json(result)
  } catch (error: any) {
    console.error('[CheckoutSnapshotController] Error creating snapshot:', error)
    return res.status(500).json({
      success: false,
      error: error.message || 'Internal server error',
    })
  }
}

/**
 * 获取快照详情（可选，用于调试）
 * GET /api/order/v1/checkout-snapshots/:snapshotId
 */
export async function getSnapshot(req: Request, res: Response) {
  try {
    const { snapshotId } = req.params

    const snapshot = await checkoutSnapshotService.getSnapshotById(snapshotId)

    if (!snapshot) {
      return res.status(404).json({
        success: false,
        error: 'Snapshot not found',
      })
    }

    return res.json({
      success: true,
      data: snapshot,
    })
  } catch (error: any) {
    console.error('[CheckoutSnapshotController] Error getting snapshot:', error)
    return res.status(500).json({
      success: false,
      error: error.message || 'Internal server error',
    })
  }
}
