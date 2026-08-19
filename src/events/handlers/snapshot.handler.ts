/**
 * 快照状态标记 Handler
 * 支付成功后，标记关联的 CheckoutSnapshot 为 USED
 *
 * 幂等性：先查 status !== 'USED' 再更新
 */

import type { IEventBus } from '../event-bus';
import type { OrderPaidEvent } from '../types';
import prisma from '../../utils/prisma';
import logger from '../../utils/logger';

export function registerSnapshotHandler(bus: IEventBus): void {
  bus.on('ORDER_PAID', async function snapshot_ORDER_PAID(event) {
    const e = event as OrderPaidEvent;

    const snapshot = await prisma.checkoutSnapshot.findFirst({
      where: { orderId: e.orderId },
    });

    if (!snapshot || snapshot.status === 'USED') return;

    await prisma.checkoutSnapshot.update({
      where: { id: snapshot.id },
      data: {
        status: 'USED',
        paymentIntentId: e.paymentIntentId || null,
      },
    });

    logger.info('[SnapshotHandler] CheckoutSnapshot 已标记为 USED', {
      snapshotId: snapshot.id,
      orderId: e.orderId,
    });
  });
}
