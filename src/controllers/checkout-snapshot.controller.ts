import { Request, Response } from 'express'
import * as checkoutSnapshotService from '../services/checkout-snapshot.service'

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

    const { orderType, customer, items, tipAmount, notes, expectedTotal, customLabelData, deliveryAddress, consumerId, grantedRewardId, deliveryFee, uberDeliveryFee, deliveryQuoteId, isScheduled, scheduledAt, salesChannelId, giftCardDeductionEstimate } = req.body

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
    if (!['TAKEOUT', 'DINE_IN', 'DELIVERY'].includes(orderType)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid orderType. Must be TAKEOUT, DINE_IN, or DELIVERY',
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
