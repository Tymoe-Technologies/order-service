import { Router, Request, Response } from 'express';
import { authenticate } from '../middleware/auth';
import { requireModulePermission } from '../middleware/requirePermission';
import { confirmDeliveryOrder } from '../services/delivery-confirmation.service';
import { AppError } from '../middleware/errorHandler';
import { successResponse, errorResponse } from '../utils/response';
import logger from '../utils/logger';

const router = Router();
const requireOrders = requireModulePermission('orders');

/**
 * 员工在 POS 上确认接单（人工路径）：走登录态认证，不是 internalAuth，
 * 由 order-service 同步调用 uber-service 建单并写回确认字段，
 * 取代此前 POS 前端直连 uber-service 的旧链路
 * POST /orders/:orderId/delivery/confirm
 * Body: { prepTimeMinutes: number }
 */
router.post('/:orderId/delivery/confirm', authenticate, requireOrders, async (req: Request, res: Response) => {
  const { orderId } = req.params;
  const { prepTimeMinutes } = req.body as { prepTimeMinutes?: number };
  const tenantId = req.user!.tenantId;

  if (typeof prepTimeMinutes !== 'number' || prepTimeMinutes <= 0) {
    errorResponse(res, 'INVALID_PREP_TIME', 'prepTimeMinutes 必须为正数', 400);
    return;
  }

  try {
    const result = await confirmDeliveryOrder(orderId, tenantId, prepTimeMinutes, 'MANUAL');
    if (!result.success) {
      errorResponse(res, result.errorCode || 'UBER_CREATE_DELIVERY_FAILED', result.error || 'Uber 建单失败', 502);
      return;
    }
    successResponse(res, result.data);
  } catch (err: any) {
    if (err instanceof AppError) {
      errorResponse(res, err.code, err.message, err.statusCode, err.details);
      return;
    }
    logger.error('[DeliveryConfirmationRoutes] 确认接单失败', { orderId, error: err.message });
    errorResponse(res, 'INTERNAL_ERROR', err.message, 500);
  }
});

export default router;
