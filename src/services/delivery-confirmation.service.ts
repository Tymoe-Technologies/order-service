import prisma from '../utils/prisma';
import logger from '../utils/logger';
import { AppError } from '../middleware/errorHandler';
import { pickupNumberConfigService } from './print-setting.service';

// 确认接单编排逻辑：由 order-service 同步调用 uber-service 建单、并在同一请求内写回
// deliveryConfirmedAt/deliveryConfirmedBy/uberDeliveryId，取代此前"POS 前端直连 uber-service、
// order-service 只能靠 best-effort 回调得知"的架构，B1（人工点击）和 C1（15分钟自动接单）共用本模块

const UBER_SERVICE_URL = process.env.UBER_SERVICE_URL || 'http://localhost:3006';
const INTERNAL_SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY || '';

export type DeliveryConfirmedBy = 'MANUAL' | 'AUTO';

export interface ConfirmDeliveryResult {
  success: boolean;
  errorCode?: string;
  error?: string;
  data?: { deliveryConfirmedAt: Date; uberDeliveryId: string | null };
}

/** 组装调用 uber-service /deliveries/from-order 所需的请求体（复用 delivery.handler.ts 的拼装逻辑） */
async function buildDeliveryPayload(orderId: string, tenantId: string, prepTimeMinutes: number) {
  const order = await prisma.order.findFirst({
    where: { id: orderId, tenantId },
    include: { orderItems: true },
  });
  if (!order) {
    throw new AppError(404, 'ORDER_NOT_FOUND', '订单不存在');
  }

  const deliveryAddress = order.deliveryAddress as any;
  // 平台单没有「确认备餐时间」这一步（骑手由平台派），所以判的是自配送而非 DELIVERY
  if (order.deliveryProvider !== 'MERCHANT' || !deliveryAddress) {
    throw new AppError(400, 'NOT_DELIVERY_ORDER', '不是配送订单');
  }
  if (order.deliveryConfirmedAt) {
    throw new AppError(409, 'ALREADY_CONFIRMED', '该订单已确认接单');
  }
  if (order.cancelledAt) {
    throw new AppError(409, 'ALREADY_CANCELLED', '该订单已取消');
  }

  const notesParts: string[] = [];
  if (deliveryAddress.unit) notesParts.push(`Unit ${deliveryAddress.unit}`);
  if (deliveryAddress.buzzer) notesParts.push(`Buzzer: ${deliveryAddress.buzzer}`);
  if (deliveryAddress.deliveryNotes) notesParts.push(deliveryAddress.deliveryNotes);
  const dropoffNotes = notesParts.length > 0 ? notesParts.join(', ') : undefined;

  let pickupDisplay: string | undefined;
  if (order.pickupNumber != null) {
    const config = await pickupNumberConfigService.getConfig(tenantId);
    pickupDisplay = pickupNumberConfigService.formatPickupDisplay(
      order.pickupNumber,
      order.orderSource,
      config.showPrefix,
      config.channelPrefixes,
    );
  }

  return {
    merchantId: tenantId,
    orderId: order.id,
    orderNumber: order.orderNumber,
    customerName: order.customerName || '',
    customerPhone: order.customerPhone || '',
    dropoffAddress: deliveryAddress.fullAddress,
    dropoffNotes,
    manifestItems: order.orderItems.map(item => ({
      name: item.itemName,
      quantity: item.quantity,
      size: 'small',
    })),
    prepTimeMinutes,
    pickupNumber: order.pickupNumber ?? undefined,
    pickupDisplay,
  };
}

/**
 * 确认接单编排：调用 uber-service 建单 → 成功后同请求内写回订单确认字段
 * by='MANUAL' 供 B1 人工确认接口使用，by='AUTO' 供 C1 自动接单 job 使用
 */
export async function confirmDeliveryOrder(
  orderId: string,
  tenantId: string,
  prepTimeMinutes: number,
  by: DeliveryConfirmedBy,
): Promise<ConfirmDeliveryResult> {
  const payload = await buildDeliveryPayload(orderId, tenantId, prepTimeMinutes);

  let uberResp: Response;
  try {
    uberResp = await fetch(`${UBER_SERVICE_URL}/api/direct/v1/deliveries/from-order`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-service-api-key': INTERNAL_SERVICE_KEY,
      },
      body: JSON.stringify(payload),
    });
  } catch (err: any) {
    logger.error('[DeliveryConfirmation] 调用 uber-service 网络异常', { orderId, error: err.message });
    return { success: false, errorCode: 'UBER_SERVICE_UNREACHABLE', error: err.message };
  }

  const body: any = await uberResp.json().catch(() => ({}));
  if (!uberResp.ok || !body.success) {
    logger.error('[DeliveryConfirmation] uber-service 建单失败', {
      orderId,
      status: uberResp.status,
      errorCode: body.errorCode,
      error: body.error,
    });
    return { success: false, errorCode: body.errorCode || 'UBER_CREATE_DELIVERY_FAILED', error: body.error || 'Uber 建单失败' };
  }

  const uberDeliveryId: string | null = body.data?.id ?? null;
  const now = new Date();
  // status 和 deliveryConfirmedAt 必须在同一次更新里联动：Uber 配送单建成功才允许 PENDING → CONFIRMED，
  // 否则会出现"订单状态显示已确认，但从未真正建过配送单"的脱节（配合 order.service.ts 里的转移守卫一起生效）
  await prisma.order.updateMany({
    where: { id: orderId, deliveryConfirmedAt: null },
    data: {
      status: 'CONFIRMED',
      confirmedAt: now,
      deliveryConfirmedAt: now,
      deliveryConfirmedBy: by,
      deliveryPrepMinutes: prepTimeMinutes,
      uberDeliveryId,
    },
  });

  logger.info('[DeliveryConfirmation] 确认接单成功', { orderId, by, uberDeliveryId });
  return { success: true, data: { deliveryConfirmedAt: now, uberDeliveryId } };
}
