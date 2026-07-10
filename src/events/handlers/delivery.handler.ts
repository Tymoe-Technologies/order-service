/**
 * Uber Direct 配送 Handler
 * 支付成功后，DELIVERY 类型订单通过 WebSocket 推送给 POS
 * POS 员工选择备餐时间后，由 POS 前端调用 uber service 创建配送单
 */

import type { IEventBus } from '../event-bus';
import type { OrderPaidEvent } from '../types';
import logger from '../../utils/logger';
import { broadcastDeliveryOrder } from '../../websocket/print-task-dispatcher';

export function registerDeliveryHandler(bus: IEventBus): void {
  bus.on('ORDER_PAID', async (event) => {
    const e = event as OrderPaidEvent;

    // 仅 DELIVERY 类型 + 有配送地址时触发
    if (e.orderType !== 'DELIVERY') return;
    if (!e.snapshot) return;

    const deliveryAddress = (e.snapshot as any).deliveryAddress;
    if (!deliveryAddress) {
      logger.warn('[DeliveryHandler] DELIVERY 订单但快照无配送地址，跳过', {
        orderId: e.orderId,
        snapshotId: e.snapshot?.id,
      });
      return;
    }

    const items = ((e.snapshot.items || []) as any[]).map((item: any) => ({
      name: item.itemName,
      quantity: item.quantity,
    }));

    logger.info('[DeliveryHandler] 推送配送订单到 POS', {
      orderId: e.orderId,
      tenantId: e.tenantId,
    });

    // 将 unit/buzzer/deliveryNotes 拼成给骑手的配送备注
    const notesParts: string[] = [];
    if (deliveryAddress.unit) notesParts.push(`Unit ${deliveryAddress.unit}`);
    if (deliveryAddress.buzzer) notesParts.push(`Buzzer: ${deliveryAddress.buzzer}`);
    if (deliveryAddress.deliveryNotes) notesParts.push(deliveryAddress.deliveryNotes);
    const dropoffNotes = notesParts.length > 0 ? notesParts.join(', ') : undefined;

    // 通过 WebSocket 推送给 POS，由员工选择备餐时间后创建 Uber 配送单
    broadcastDeliveryOrder(e.tenantId, {
      orderId: e.orderId,
      orderNumber: e.orderNumber,
      tenantId: e.tenantId,
      customerName: e.snapshot.customerName || '',
      customerPhone: e.snapshot.customerPhone || '',
      dropoffAddress: deliveryAddress.fullAddress,
      dropoffNotes,
      items,
      createdAt: new Date().toISOString(),
    });
  });
}
