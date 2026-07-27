/**
 * Uber Direct 配送 Handler
 * 支付成功后，DELIVERY 类型订单通过 WebSocket 推送给 POS
 * POS 员工选择备餐时间后，由 POS 前端调用 uber service 创建配送单
 */

import type { IEventBus } from '../event-bus';
import type { OrderPaidEvent } from '../types';
import logger from '../../utils/logger';
import prisma from '../../utils/prisma';
import { broadcastDeliveryOrder } from '../../websocket/print-task-dispatcher';
import { pickupNumberConfigService } from '../../services/print-setting.service';

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

    // 记录 15 分钟自动接单截止时间，供 C 阶段自动接单 job 扫描；
    // 失败不阻断推送——watchdog/自动接单 job 找不到 deadline 时会退化为按 paidAt 计算
    const AUTO_CONFIRM_DEADLINE_MINUTES = Number(process.env.AUTO_CONFIRM_DEADLINE_MINUTES) || 15;
    prisma.order.update({
      where: { id: e.orderId },
      data: { deliveryConfirmDeadlineAt: new Date(Date.now() + AUTO_CONFIRM_DEADLINE_MINUTES * 60 * 1000) },
    }).catch(err => logger.warn('[DeliveryHandler] 写入 deliveryConfirmDeadlineAt 失败', { orderId: e.orderId, error: err.message }));

    // 将 unit/buzzer/deliveryNotes 拼成给骑手的配送备注
    const notesParts: string[] = [];
    if (deliveryAddress.unit) notesParts.push(`Unit ${deliveryAddress.unit}`);
    if (deliveryAddress.buzzer) notesParts.push(`Buzzer: ${deliveryAddress.buzzer}`);
    if (deliveryAddress.deliveryNotes) notesParts.push(deliveryAddress.deliveryNotes);
    const dropoffNotes = notesParts.length > 0 ? notesParts.join(', ') : undefined;

    // 取餐号在订单创建时已经生成（不区分订单类型），但 pickupDisplay 不落库，需要现算；
    // 配送订单其实不涉及到店取餐，取餐号在这里主要是给 POS/订单管理页面对账用的展示号
    let pickupNumber: number | undefined;
    let pickupDisplay: string | undefined;
    try {
      const order = await prisma.order.findUnique({
        where: { id: e.orderId },
        select: { pickupNumber: true, orderSource: true },
      });
      if (order?.pickupNumber != null) {
        pickupNumber = order.pickupNumber;
        const config = await pickupNumberConfigService.getConfig(e.tenantId);
        pickupDisplay = pickupNumberConfigService.formatPickupDisplay(
          order.pickupNumber,
          order.orderSource,
          config.showPrefix,
          config.channelPrefixes,
        );
      }
    } catch (err: any) {
      logger.warn('[DeliveryHandler] 读取取餐号失败（不阻断推送）', { orderId: e.orderId, error: err.message });
    }

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
      pickupNumber,
      pickupDisplay,
    });
  });
}
