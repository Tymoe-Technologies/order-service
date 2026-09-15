import prisma from '../utils/prisma';
import { AppError } from '../middleware/errorHandler';
import logger from '../utils/logger';
import { OrderStatus, OrderSource } from '@prisma/client/client-order';
import { eventBus } from '../events';
import { v4 as uuidv4 } from 'uuid';
import { broadcastOrderUpdate } from '../websocket/queue-display-server';
import { sumSupplySubtotal } from './supply-line';

/**
 * 订单状态管理服务
 * 负责状态流转验证、状态历史记录、状态变化触发逻辑
 */
export class OrderStatusService {
  /**
   * 允许的状态转换规则
   */
  private readonly ALLOWED_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
    'SCHEDULED':        ['PENDING', 'CONFIRMED', 'CANCELLED'],  // 预约中 → 释放为确认/待确认 / 取消
    'PENDING':          ['CONFIRMED', 'CANCELLED'],
    'CONFIRMED':        ['PREPARING', 'READY', 'COMPLETED', 'CANCELLED'], // 已确认 → 制作/直接叫号(现做现取跳过PREPARING)/完成/取消
    'PREPARING':        ['READY', 'CANCELLED'],
    'READY':            ['PICKED_UP', 'OUT_FOR_DELIVERY', 'COMPLETED', 'CANCELLED'],
    'PICKED_UP':        ['COMPLETED', 'CANCELLED'],
    'OUT_FOR_DELIVERY': ['DELIVERED', 'CANCELLED'],
    'DELIVERED':        ['COMPLETED'],
    'COMPLETED':        [],  // 终态，不能转换
    'CANCELLED':        []   // 终态，不能转换
  };

  /**
   * 验证状态转换是否合法
   */
  validateStatusTransition(
    currentStatus: OrderStatus,
    newStatus: OrderStatus
  ): boolean {
    const allowedNext = this.ALLOWED_TRANSITIONS[currentStatus];
    return allowedNext.includes(newStatus);
  }

  /**
   * 获取订单来源对应的状态流程
   */
  getStatusFlowForSource(orderSource: OrderSource, isScheduled = false): OrderStatus[] {
    const prefix: OrderStatus[] = isScheduled ? ['SCHEDULED'] : [];
    switch (orderSource) {
      case 'POS':
        return [...prefix, 'PENDING', 'CONFIRMED', 'PREPARING', 'READY', 'COMPLETED'];
      case 'KIOSK':
      case 'WEB':
        return [...prefix, 'PENDING', 'CONFIRMED', 'PREPARING', 'READY', 'PICKED_UP', 'COMPLETED'];
      default:
        return [...prefix, 'PENDING', 'CONFIRMED', 'PREPARING', 'READY', 'COMPLETED'];
    }
  }

  /**
   * 更新订单状态
   */
  async updateOrderStatus(
    orderId: string,
    newStatus: OrderStatus,
    userId: string,
    tenantId: string,
    reason?: string
  ) {
    // 1. 获取订单
    const order = await prisma.order.findFirst({
      where: { id: orderId, tenantId }
    });

    if (!order) {
      throw new AppError(404, 'ORDER_NOT_FOUND', '订单不存在');
    }

    // 2. 验证状态转换
    if (!this.validateStatusTransition(order.status, newStatus)) {
      throw new AppError(
        400,
        'INVALID_STATUS_TRANSITION',
        `不允许从 ${order.status} 转换到 ${newStatus}`
      );
    }

    // 2.1 叫号屏模式下，禁止跳过制作流程直接完成
    if (newStatus === 'COMPLETED' && ['PENDING', 'CONFIRMED'].includes(order.status)) {
      const config = await prisma.pickupNumberConfig.findUnique({ where: { tenantId } });
      if (config?.queueDisplayEnabled) {
        throw new AppError(
          400,
          'QUEUE_DISPLAY_REQUIRED',
          '已开启叫号屏模式，订单需经过制作中→待取餐流程后才能完成'
        );
      }
    }

    // 2.2 Uber Direct 配送单（WEB 来源的 DELIVERY 订单）不允许通过这个通用状态接口离开 PENDING——
    // 必须先经 delivery-confirmation.service.ts 的 confirmDeliveryOrder 真正建好 Uber 配送单，
    // 状态和 deliveryConfirmedAt 才会一起联动改成 CONFIRMED，否则会出现"订单状态显示已接单，
    // 但从未真正建过配送单"的脱节（这正是这次要修的漏单问题的根源之一）
    if (
      order.status === 'PENDING' &&
      // 只有本店自配送单有「必须先建 Uber 配送单」这条约束
      order.deliveryProvider === 'MERCHANT' &&
      !order.deliveryConfirmedAt
    ) {
      throw new AppError(
        400,
        'DELIVERY_NOT_CONFIRMED',
        '该配送订单尚未创建 Uber Direct 配送单，请使用"接单"操作而不是直接改状态'
      );
    }

    // 3. 准备状态时间戳字段
    const statusTimestamp = this.getStatusTimestampField(newStatus);

    // 4. 更新订单状态
    const updatedOrder = await prisma.order.update({
      where: { id: orderId },
      data: {
        status: newStatus,
        ...(statusTimestamp && { [statusTimestamp]: new Date() })
      },
      include: {
        orderItems: true
      }
    });

    // 5. 记录状态历史
    await prisma.orderStatusHistory.create({
      data: {
        orderId,
        fromStatus: order.status,
        toStatus: newStatus,
        reason,
        changedBy: userId,
        changedAt: new Date()
      }
    });

    logger.info(`Order status updated: ${orderId}`, {
      from: order.status,
      to: newStatus,
      orderNumber: order.orderNumber,
      orderSource: order.orderSource
    });

    // 6. 触发状态变化后的业务逻辑
    await this.handleStatusChange(updatedOrder, order.status, newStatus);

    return {
      id: updatedOrder.id,
      orderNumber: updatedOrder.orderNumber,
      status: updatedOrder.status,
      previousStatus: order.status,
      updatedAt: updatedOrder.updatedAt
    };
  }

  /**
   * 获取状态对应的时间戳字段名
   */
  private getStatusTimestampField(status: OrderStatus): string | null {
    const mapping: Record<OrderStatus, string | null> = {
      'SCHEDULED':        null,
      'PENDING':          null,
      'CONFIRMED':        'confirmedAt',
      'PREPARING':        'preparingAt',
      'READY':            'readyAt',
      'PICKED_UP':        null,
      'OUT_FOR_DELIVERY': null,
      'DELIVERED':        null,
      'COMPLETED':        'completedAt',
      'CANCELLED':        'cancelledAt'
    };
    return mapping[status];
  }

  /**
   * 处理状态变化后的业务逻辑
   */
  private async handleStatusChange(
    order: any,
    oldStatus: OrderStatus,
    newStatus: OrderStatus
  ) {
    // 广播给叫号屏
    broadcastOrderUpdate(order.tenantId, order);

    switch (newStatus) {
      case 'CONFIRMED':
        await this.onOrderConfirmed(order);
        break;

      case 'PREPARING':
        await this.onOrderPreparing(order);
        break;

      case 'READY':
        await this.onOrderReady(order);
        break;

      case 'PICKED_UP':
        await this.onOrderPickedUp(order);
        break;

      case 'OUT_FOR_DELIVERY':
        await this.onOrderOutForDelivery(order);
        break;

      case 'DELIVERED':
        await this.onOrderDelivered(order);
        break;

      case 'COMPLETED':
        await this.onOrderCompleted(order);
        break;

      case 'CANCELLED':
        await this.onOrderCancelled(order);
        break;
    }
  }

  /**
   * 订单确认时的处理
   */
  private async onOrderConfirmed(order: any) {
    logger.info(`Order confirmed: ${order.orderNumber}`);
    
    // TODO: 发送确认通知
    // if (order.customerPhone) {
    //   await sendSMS(order.customerPhone, `订单 ${order.orderNumber} 已确认`);
    // }
  }

  /**
   * 开始制作时的处理
   */
  private async onOrderPreparing(order: any) {
    logger.info(`Order preparing: ${order.orderNumber}`);
    
    // TODO: 打印厨房单
    // await printKitchenTicket(order);
  }

  /**
   * 订单完成时的处理（重点：叫号逻辑）
   */
  private async onOrderReady(order: any) {
    logger.info(`Order ready: ${order.orderNumber}`, {
      orderSource: order.orderSource
    });

    // KIOSK 订单：触发叫号
    if (order.orderSource === 'KIOSK') {
      await this.callNumber(order);
    }

    // WEB 订单：发送通知
    if (order.orderSource === 'WEB') {
      await this.notifyCustomerOrderReady(order);
    }

    // 外卖订单：通知平台
    // if (isDeliveryOrder(order.orderSource)) {
    //   await notifyPlatformOrderReady(order);
    // }
  }

  /**
   * 叫号逻辑（KIOSK 订单）
   */
  private async callNumber(order: any) {
    logger.info(`Calling number for order: ${order.orderNumber}`, {
      pickupNumber: order.pickupNumber,
      pickupName: order.pickupName
    });

    // TODO: 实现叫号功能
    // 1. 在叫号屏显示
    // await displayOnScreen({
    //   orderNumber: order.pickupNumber,
    //   customerName: order.pickupName
    // });

    // 2. 发送短信通知
    // if (order.customerPhone) {
    //   await sendSMS(
    //     order.customerPhone,
    //     `您的订单 #${order.pickupNumber} 已完成，请取餐`
    //   );
    // }

    // 3. 播放语音提醒
    // await playAudio(`请 ${order.pickupNumber} 号取餐`);
  }

  /**
   * 通知客户订单已完成
   */
  private async notifyCustomerOrderReady(order: any) {
    logger.info(`Notifying customer: ${order.orderNumber}`);
    
    // TODO: 发送通知
    // if (order.customerEmail) {
    //   await sendEmail(order.customerEmail, '订单已完成，请来取餐');
    // }
  }

  /**
   * 已取餐时的处理
   */
  private async onOrderPickedUp(order: any) {
    logger.info(`Order picked up: ${order.orderNumber}`);
    
    // 可以自动完成订单
    // await this.updateOrderStatus(order.id, 'COMPLETED', order.createdBy, order.tenantId);
  }

  /**
   * 开始配送时的处理
   */
  private async onOrderOutForDelivery(order: any) {
    logger.info(`Order out for delivery: ${order.orderNumber}`);
    
    // TODO: 通知客户配送员信息
    // TODO: 同步状态到外卖平台
  }

  /**
   * 已送达时的处理
   */
  private async onOrderDelivered(order: any) {
    logger.info(`Order delivered: ${order.orderNumber}`);
    
    // TODO: 请求客户评价
  }

  /**
   * 订单完成时的处理
   */
  private async onOrderCompleted(order: any) {
    logger.info(`Order completed: ${order.orderNumber}`);

    /*
      整单直接完成时，把还挂着 PENDING 的分项一并标 READY。

      分项备餐（merchant_online_order_config.item_completion_enabled）是双向的：
      逐项点完 → 最后一项自动完成订单（见 order-item.service）；
      而反过来，店员直接点「完成订单」时这些分项得跟着收尾，
      否则订单是 COMPLETED 而 item 还停在 PENDING，备餐屏上那几行永远不消。

      这段原本写在 order.service 那个**没有调用方**的 updateOrderStatus 里，
      也就是说一直没生效。删死代码时挪过来。
    */
    try {
      const config = await (prisma.merchantOnlineOrderConfig as any).findUnique({
        where: { merchantId: order.tenantId },
        select: { itemCompletionEnabled: true },
      });
      if (config?.itemCompletionEnabled) {
        const { markAllItemsReady } = await import('./order-item.service');
        await markAllItemsReady(order.id);
      }
    } catch (err) {
      // 收尾失败不该把「订单已完成」这件事回滚
      logger.warn('[OrderStatus] 分项收尾失败（非致命）', { orderId: order.id, err });
    }

    // 从 discountReason 解析 grantedRewardId(POS/同步流程的会员券标记)
    const _dr: string | null = order.discountReason ?? null;
    const _grId = _dr && _dr.startsWith('GrantedReward:') ? _dr.slice('GrantedReward:'.length) : null;

    // 耗材不计积分（也不参与折扣），handler 要从 subtotal 里减掉它
    const supplySubtotal = await sumSupplySubtotal(prisma, order.id);

    // 发布完成事件 → 触发积分累积等副作用
    eventBus.emit({
      eventId: uuidv4(),
      type: 'ORDER_COMPLETED',
      timestamp: new Date(),
      tenantId: order.tenantId,
      orderId: order.id,
      orderNumber: order.orderNumber,
      memberId: order.memberId ?? null,
      subtotal: order.subtotal,
      supplySubtotal,
      discountAmount: order.discountAmount ?? 0,
      totalAmount: order.totalAmount,
      orderSource: order.orderSource,
      paymentStatus: order.paymentStatus,
      grantedRewardId: _grId,
    });
  }

  /**
   * 订单取消时的处理
   */
  private async onOrderCancelled(order: any) {
    logger.info(`Order cancelled: ${order.orderNumber}`);
    
    // TODO: 退款处理
    // TODO: 库存回滚
    // TODO: 通知客户
  }

  /**
   * 获取订单状态历史
   */
  async getOrderStatusHistory(orderId: string, tenantId: string) {
    const order = await prisma.order.findFirst({
      where: { id: orderId, tenantId }
    });

    if (!order) {
      throw new AppError(404, 'ORDER_NOT_FOUND', '订单不存在');
    }

    return await prisma.orderStatusHistory.findMany({
      where: { orderId },
      orderBy: { changedAt: 'asc' }
    });
  }

  /**
   * 批量更新订单状态
   */
  async batchUpdateStatus(
    orderIds: string[],
    newStatus: OrderStatus,
    userId: string,
    tenantId: string,
    reason?: string
  ) {
    const results = [];
    
    for (const orderId of orderIds) {
      try {
        const result = await this.updateOrderStatus(
          orderId,
          newStatus,
          userId,
          tenantId,
          reason
        );
        results.push({ orderId, success: true, result });
      } catch (error) {
        results.push({
          orderId,
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    }

    return results;
  }
}

export default new OrderStatusService();




