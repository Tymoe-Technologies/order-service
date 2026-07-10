/**
 * 内部服务接口（服务间调用）
 * 挂载路径：/internal（绕过 validateMerchantId 中间件）
 * 认证方式：x-service-api-key
 */

import { Router, Request, Response } from 'express';
import { internalAuth } from '../middleware/auth';
import {
  broadcastDeliveryStatusUpdate,
  broadcastThirdPartyOrder,
  broadcastOrderStatusChanged,
} from '../websocket/print-task-dispatcher';
import prisma from '../utils/prisma';
import logger from '../utils/logger';
import orderController from '../controllers/order.controller';
import orderService from '../services/order.service';
import { v7 as uuidv7 } from 'uuid';
import { dayBoundaries, pgTimezone } from '../utils/timezone';
import organizationService from '../services/organization.service';

const FINANCE_SERVICE_URL = process.env.FINANCE_SERVICE_URL || 'http://localhost:7007';
const INTERNAL_SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY || '';

/** 非阻塞通知 finance-service 记录外卖平台订单分录 */
async function notifyFinanceOrderPaid(params: {
  tenantId: string;
  orderId: string;
  orderNumber: string;
  totalAmount: number;
  platformType: string;
  commissionRate?: string | null;
}): Promise<void> {
  if (!INTERNAL_SERVICE_KEY) return;
  try {
    await fetch(`${FINANCE_SERVICE_URL}/internal/ledger/order-paid`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-service-api-key': INTERNAL_SERVICE_KEY },
      body: JSON.stringify({ paymentMethod: 'PLATFORM', currency: 'CAD', ...params }),
    });
  } catch (err: any) {
    logger.warn('[Internal] finance order-paid 通知失败（非致命）', { orderId: params.orderId, err: err.message });
  }
}

const router = Router();

// ── Uber Direct 配送状态更新 ────────────────────────────────────────

router.post('/delivery-status-update', internalAuth, (req: Request, res: Response) => {
  const { tenantId, deliveryId, status, courier, dropoff_eta, pickup_eta, tracking_url } = req.body;
  if (!tenantId || !deliveryId || !status) {
    res.status(400).json({ error: 'tenantId, deliveryId, status 必填' });
    return;
  }
  broadcastDeliveryStatusUpdate(tenantId, { deliveryId, status, courier, dropoff_eta, pickup_eta, tracking_url });
  res.json({ success: true });
});

// ── Uber Eats 来单 ──────────────────────────────────────────────────

/**
 * Uber Eats 来单 - 创建标准订单并通知 POS
 * 由 uber-service webhook 处理完成后调用
 */
router.post('/uber-eats-order', internalAuth, async (req: Request, res: Response) => {
  const {
    tenantId,
    externalOrderId,
    externalDisplayId,
    customerName,
    customerPhone,
    items,
    totalAmount,
    taxAmount,
    currency,
    estimatedPickupTime,
    timeoutAt,
    isScheduled,
    scheduledAt,
  } = req.body;

  if (!tenantId || !externalOrderId || !items) {
    res.status(400).json({ error: 'tenantId, externalOrderId, items 必填' });
    return;
  }

  try {
    // 幂等性：同一 externalOrderId 不重复创建
    const existing = await prisma.order.findFirst({
      where: { externalOrderId, tenantId },
      select: { id: true, orderNumber: true },
    });

    if (existing) {
      logger.warn('[UberEats] 订单已存在，跳过创建', { externalOrderId, orderId: existing.id });
      res.json({ success: true, orderId: existing.id, orderNumber: existing.orderNumber, duplicate: true });
      return;
    }

    const { orderNumber } = await orderService.generateOrderNumber(tenantId, 'UBER_EATS');

    // 计算 subtotal：优先用各行 unitPrice*quantity 求和；缺价时回退 totalAmount - tax
    const itemsSubtotal = (items as any[]).reduce(
      (sum: number, item: any) => sum + (item.unitPrice ?? 0) * item.quantity,
      0,
    );
    const subtotal = itemsSubtotal > 0
      ? itemsSubtotal
      : Math.max(0, (totalAmount ?? 0) - (taxAmount ?? 0));

    const order = await prisma.order.create({
      data: {
        id: uuidv7(), // 订单主键统一用 UUID v7（时间有序）
        tenantId,
        orderNumber,
        orderType: 'DELIVERY',
        orderSource: 'UBER_EATS',
        status: 'PENDING',
        externalOrderId,
        externalDisplayId,
        externalPlatform: 'UBER_EATS',
        customerName: customerName || null,
        customerPhone: customerPhone || null,
        subtotal,
        totalAmount: totalAmount ?? 0,
        taxAmount: taxAmount ?? 0,
        paymentStatus: 'PAID',
        paymentMethod: 'UBER_EATS',
        createdBy: tenantId,
        orderItems: {
          create: (items as any[]).map((item: any) => ({
            itemId: item.itemId || '00000000-0000-0000-0000-000000000000',
            itemName: item.name,
            quantity: item.quantity,
            unitPrice: item.unitPrice ?? 0,
            totalPrice: (item.unitPrice ?? 0) * item.quantity,
            specialNotes: item.specialInstructions || null,
            modifiers: item.modifiers || null,
          })),
        },
      },
      include: { orderItems: true },
    });

    logger.info('[UberEats] 订单已创建', {
      orderId: order.id,
      orderNumber: order.orderNumber,
      externalOrderId,
      itemCount: order.orderItems.length,
    });

    // 查找该租户的 Uber Eats 系统渠道，获取佣金率
    const uberChannel = await prisma.orderSourceConfig.findFirst({
      where: { tenantId, platformType: 'UBER_EATS' },
      select: { commissionRate: true },
    }).catch(() => null);

    // 非阻塞通知 finance-service 写分录
    notifyFinanceOrderPaid({
      tenantId,
      orderId: order.id,
      orderNumber: order.orderNumber,
      totalAmount: totalAmount ?? 0,
      platformType: 'UBER_EATS',
      commissionRate: uberChannel?.commissionRate?.toString() ?? null,
    }).catch(() => {});

    broadcastThirdPartyOrder(tenantId, {
      orderId: order.id,
      orderNumber: order.orderNumber,
      externalOrderId,
      externalDisplayId: externalDisplayId || '',
      platform: 'UBER_EATS',
      tenantId,
      customerName: customerName || '',
      customerPhone: customerPhone || '',
      items: (items as any[]).map((item: any) => ({
        externalItemId: item.itemId,
        name: item.name,
        quantity: item.quantity,
        unitPrice: item.unitPrice ?? 0,
        specialInstructions: item.specialInstructions,
        modifiers: item.modifiers,
      })),
      totalAmount: totalAmount ?? 0,
      currency: currency || 'CAD',
      estimatedPickupTime: estimatedPickupTime || '',
      timeoutAt: timeoutAt || '',
      isScheduled: isScheduled ?? false,
      scheduledAt: scheduledAt || null,
      createdAt: order.createdAt.toISOString(),
    });

    res.json({ success: true, orderId: order.id, orderNumber: order.orderNumber });
  } catch (error: any) {
    logger.error('[UberEats] 创建订单失败', { error: error.message, externalOrderId });
    res.status(500).json({ error: error.message });
  }
});

/**
 * 第三方平台订单状态更新 - 同步状态并广播给 POS
 */
router.post('/order-status-update', internalAuth, async (req: Request, res: Response) => {
  const { externalOrderId, externalPlatform, status, tenantId } = req.body;

  if (!externalOrderId || !status || !tenantId) {
    res.status(400).json({ error: 'externalOrderId, status, tenantId 必填' });
    return;
  }

  const statusMap: Record<string, string> = {
    ACCEPTED:    'CONFIRMED',
    PREPARING:   'PREPARING',
    READY:       'READY',
    HANDED_OFF:  'PICKED_UP',   // Uber: 骑手已取餐
    CANCELLED:   'CANCELLED',
    DENIED:      'CANCELLED',   // Uber: 商家拒单
    FAILED:      'CANCELLED',   // Uber: 系统故障取消
    COMPLETED:   'COMPLETED',
    SUCCEEDED:   'COMPLETED',   // Uber Fulfillment API 的完成状态
  };

  const newStatus = statusMap[status];
  if (!newStatus) {
    res.status(400).json({ error: `未知状态: ${status}` });
    return;
  }

  try {
    const order = await prisma.order.findFirst({
      where: { externalOrderId, tenantId },
      select: { id: true, orderNumber: true, status: true },
    });

    if (!order) {
      res.status(404).json({ error: '订单不存在' });
      return;
    }

    const previousStatus = order.status;

    const timestampField: Record<string, any> = {
      CANCELLED:  { cancelledAt: new Date() },
      COMPLETED:  { completedAt: new Date() },
    };

    await prisma.order.update({
      where: { id: order.id },
      data: { status: newStatus as any, ...timestampField[newStatus] },
    });

    logger.info('[OrderStatus] 订单状态已更新', {
      orderId: order.id,
      externalOrderId,
      previousStatus,
      newStatus,
    });

    broadcastOrderStatusChanged(tenantId, {
      orderId: order.id,
      orderNumber: order.orderNumber,
      externalOrderId,
      platform: externalPlatform,
      status: newStatus,
      previousStatus,
      tenantId,
    });

    res.json({ success: true, orderId: order.id, status: newStatus });
  } catch (error: any) {
    logger.error('[OrderStatus] 更新订单状态失败', { error: error.message, externalOrderId });
    res.status(500).json({ error: error.message });
  }
});

/**
 * 预约单备餐提醒 - 推送打印任务给 POS
 * 由 uber-service 在预约时间前 30 分钟调用
 */
router.post('/uber-eats-order-print-reminder', internalAuth, async (req: Request, res: Response) => {
  const { tenantId, orderId, externalOrderId, scheduledAt } = req.body;

  if (!tenantId || !externalOrderId) {
    res.status(400).json({ error: 'tenantId, externalOrderId 必填' });
    return;
  }

  try {
    const order = await prisma.order.findFirst({
      where: { externalOrderId, tenantId },
      include: { orderItems: true },
    });

    if (!order) {
      res.status(404).json({ error: '订单不存在' });
      return;
    }

    // 广播给 POS：打印预约单
    broadcastThirdPartyOrder(tenantId, {
      orderId: order.id,
      orderNumber: order.orderNumber,
      externalOrderId,
      externalDisplayId: order.externalDisplayId || '',
      platform: 'UBER_EATS',
      tenantId,
      customerName: order.customerName || '',
      customerPhone: order.customerPhone || '',
      items: (order.orderItems as any[]).map((item: any) => ({
        externalItemId: item.itemId,
        name: item.itemName,
        quantity: item.quantity,
        unitPrice: item.unitPrice ?? 0,
        specialInstructions: item.specialNotes,
        modifiers: item.modifiers,
      })),
      totalAmount: order.totalAmount ?? 0,
      currency: 'CAD',
      isScheduled: true,
      scheduledAt: scheduledAt || null,
      printReminder: true,   // POS 收到此标志直接打印，不弹来单提示
      createdAt: order.createdAt.toISOString(),
    });

    logger.info('[UberEats] 预约单备餐提醒已推送', { orderId: order.id, externalOrderId, scheduledAt });
    res.json({ success: true });
  } catch (error: any) {
    logger.error('[UberEats] 推送预约单打印提醒失败', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// ── Uber Direct 待确认配送订单 ──────────────────────────────────────

/**
 * 查询待 POS 确认的配送订单
 * 由 uber-service HTTP Pull 调用，返回已支付但尚未创建 Uber 配送单的 DELIVERY 订单
 */
router.get('/delivery-pending-confirmations', internalAuth, async (req: Request, res: Response) => {
  const { tenantId } = req.query as { tenantId?: string };
  if (!tenantId) {
    res.status(400).json({ error: 'tenantId 必填' });
    return;
  }

  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000); // 只补偿 24 小时内的订单
    const orders = await prisma.order.findMany({
      where: {
        tenantId,
        orderType: 'DELIVERY',
        paymentStatus: 'PAID',
        status: { notIn: ['COMPLETED', 'CANCELLED'] },
        createdAt: { gte: since },
      },
      include: { orderItems: true },
      orderBy: { createdAt: 'asc' },
    });

    const data = orders.map((order: any) => {
      const addr = order.deliveryAddress as any;
      // 将 unit/buzzer/deliveryNotes 拼成骑手备注
      const notesParts: string[] = [];
      if (addr?.unit) notesParts.push(`Unit ${addr.unit}`);
      if (addr?.buzzer) notesParts.push(`Buzzer: ${addr.buzzer}`);
      if (addr?.deliveryNotes) notesParts.push(addr.deliveryNotes);
      return {
        orderId: order.id,
        orderNumber: order.orderNumber,
        tenantId: order.tenantId,
        customerName: order.customerName || '',
        customerPhone: order.customerPhone || '',
        dropoffAddress: addr?.fullAddress || '',
        dropoffNotes: notesParts.length > 0 ? notesParts.join(', ') : undefined,
        items: (order.orderItems as any[]).map((item: any) => ({
          name: item.itemName,
          quantity: item.quantity,
        })),
        createdAt: order.createdAt.toISOString(),
      };
    });

    logger.info('[Internal] 待确认配送订单查询', { tenantId, count: data.length });
    res.json({ success: true, data });
  } catch (error: any) {
    logger.error('[Internal] 查询待确认配送订单失败', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

/**
 * 标记配送订单已确认（POS 员工选择备餐时间并提交后调用）
 * 由 uber-service 在 createDeliveryFromOrder 成功后调用
 */
router.post('/delivery-confirmation/:orderId/confirm', internalAuth, async (req: Request, res: Response) => {
  const { orderId } = req.params;
  if (!orderId) {
    res.status(400).json({ error: 'orderId 必填' });
    return;
  }

  try {
    await prisma.$transaction([
      prisma.order.update({
        where: { id: orderId },
        data: { status: 'CONFIRMED' },
      }),
      prisma.orderStatusHistory.create({
        data: {
          orderId,
          fromStatus: 'PENDING' as any,
          toStatus: 'CONFIRMED' as any,
          reason: 'Delivery confirmed by merchant',
          changedAt: new Date(),
        },
      }),
    ]);
    logger.info('[Internal] 配送订单已标记确认', { orderId });
    res.json({ success: true });
  } catch (error: any) {
    logger.error('[Internal] 标记配送确认失败', { orderId, error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// ── 其他内部接口 ─────────────────────────────────────────────────────

// Finance Service 回调 - 更新支付状态
router.patch('/orders/:orderId/payment-status', internalAuth, orderController.updatePaymentStatus);

// 服务间调用 - 取消订单（uber-service 取消配送时调用）
router.post('/orders/:orderId/cancel', internalAuth, async (req: Request, res: Response) => {
  const { orderId } = req.params;
  const { reason = '配送已取消', tenantId } = req.body;

  if (!orderId) {
    res.status(400).json({ error: 'orderId 必填' });
    return;
  }

  try {
    // 先查订单获取 orderNumber 用于广播
    const order = await prisma.order.findFirst({
      where: { id: orderId },
      select: { orderNumber: true, status: true, tenantId: true },
    });

    if (!order) {
      res.status(404).json({ error: '订单不存在' });
      return;
    }

    const resolvedTenantId = tenantId || order.tenantId;
    const previousStatus = order.status;

    await orderService.cancelOrder(orderId, reason, resolvedTenantId);
    logger.info('[Internal] 订单已取消', { orderId, reason });

    // 广播订单状态变更给 POS
    broadcastOrderStatusChanged(resolvedTenantId, {
      orderId,
      orderNumber: order.orderNumber,
      status: 'CANCELLED',
      previousStatus,
      tenantId: resolvedTenantId,
    });

    res.json({ success: true });
  } catch (error: any) {
    // 已取消的订单不视为错误
    if (error?.code === 'ALREADY_CANCELLED') {
      logger.info('[Internal] 订单已是取消状态，跳过', { orderId });
      res.json({ success: true, note: 'already_cancelled' });
      return;
    }
    logger.error('[Internal] 取消订单失败', { orderId, error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// 从订单快照创建订单
router.post('/orders/from-snapshot', internalAuth, orderController.createFromSnapshot);

/**
 * 对账查询接口 - 返回指定时间段内的订单支付摘要
 * 供 Finance Service 内部对账使用
 */
router.get('/orders/reconciliation', internalAuth, async (req: Request, res: Response) => {
  const { tenantId, startDate, endDate } = req.query as {
    tenantId?: string;
    startDate?: string;
    endDate?: string;
  };

  if (!tenantId || !startDate || !endDate) {
    res.status(400).json({ error: 'tenantId, startDate, endDate 必填' });
    return;
  }

  try {
    const orders = await prisma.order.findMany({
      where: {
        tenantId,
        createdAt: {
          gte: new Date(startDate),
          lte: new Date(endDate),
        },
        // 只对账有实际支付行为的订单（排除 Uber Eats 等第三方平台代收）
        orderSource: { notIn: ['UBER_EATS'] },
        status: { not: 'CANCELLED' },
      },
      select: {
        id: true,
        orderNumber: true,
        totalAmount: true,
        paymentStatus: true,
        paymentMethod: true,
        transactionId: true,
        paidAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    res.json({ success: true, data: orders });
  } catch (error: any) {
    logger.error('[Internal] 对账查询失败', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// ── 日结汇总（Finance Service 专用）────────────────────────────────
// GET /internal/daily-summary?tenantId=&date=2026-04-29
// 返回当日订单的税、折扣、小费、subtotal 汇总

router.get('/daily-summary', internalAuth, async (req: Request, res: Response) => {
  try {
    const { tenantId, date, timezone } = req.query as { tenantId: string; date: string; timezone?: string };
    if (!tenantId || !date) {
      res.status(400).json({ error: 'tenantId 和 date 必填' });
      return;
    }

    // 用门店时区计算当日边界，确保日结范围与本地营业日一致
    const tz = timezone || await organizationService.getStoreTimezone(tenantId);
    const { periodStart, periodEnd } = dayBoundaries(date, tz);

    const [agg, refundAgg] = await Promise.all([
      prisma.order.aggregate({
        where: {
          tenantId,
          status: 'COMPLETED',
          createdAt: { gte: periodStart, lte: periodEnd },
        },
        _sum: {
          subtotal:       true,
          taxAmount:      true,
          discountAmount: true,
          tipAmount:      true,
          totalAmount:    true,
        },
        _count: { id: true },
      }),
      prisma.order.aggregate({
        where: {
          tenantId,
          paymentStatus: 'REFUNDED',
          createdAt: { gte: periodStart, lte: periodEnd },
        },
        _sum: { totalAmount: true },
        _count: { id: true },
      }),
    ]);

    res.json({
      success: true,
      data: {
        date,
        orderCount:     agg._count.id,
        subtotal:       Number(agg._sum.subtotal       ?? 0),
        taxAmount:      Number(agg._sum.taxAmount      ?? 0),
        discountAmount: Number(agg._sum.discountAmount ?? 0),
        tipAmount:      Number(agg._sum.tipAmount      ?? 0),
        totalAmount:    Number(agg._sum.totalAmount    ?? 0),
        refundCount:    refundAgg._count.id,
        refundAmount:   Number(refundAgg._sum.totalAmount ?? 0),
      },
    });
  } catch (error: any) {
    logger.error('[Internal] 日结汇总失败', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

/**
 * 热销商品排行 - 供 Finance Service 报表使用
 * GET /internal/top-items?tenantId=&startDate=&endDate=&limit=10
 */
router.get('/top-items', internalAuth, async (req: Request, res: Response) => {
  try {
    const { tenantId, startDate, endDate, limit = '10', timezone } = req.query as {
      tenantId: string; startDate: string; endDate: string; limit?: string; timezone?: string;
    };
    if (!tenantId || !startDate || !endDate) {
      res.status(400).json({ error: 'tenantId, startDate, endDate 必填' });
      return;
    }

    // 用门店时区计算日期范围
    const tz = timezone || await organizationService.getStoreTimezone(tenantId);
    const { periodStart: start } = dayBoundaries(startDate, tz);
    const { periodEnd: end } = dayBoundaries(endDate, tz);

    const rows = await prisma.$queryRaw<Array<{
      item_name: string;
      total_qty: bigint;
      total_revenue: bigint;
    }>>`
      SELECT
        oi.item_name,
        SUM(oi.quantity)    AS total_qty,
        SUM(oi.total_price) AS total_revenue
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE o.tenant_id = ${tenantId}::uuid
        AND o.status = 'COMPLETED'
        AND o.created_at >= ${start}
        AND o.created_at <= ${end}
      GROUP BY oi.item_name
      ORDER BY total_qty DESC
      LIMIT ${Number(limit)}
    `;

    res.json({
      success: true,
      data: rows.map(r => ({
        itemName:     r.item_name,
        totalQty:     Number(r.total_qty),
        totalRevenue: Number(r.total_revenue),
      })),
    });
  } catch (error: any) {
    logger.error('[Internal] 热销商品查询失败', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

/**
 * 按小时销售分布 - 供报表使用
 * GET /internal/sales-by-hour?tenantId=&startDate=&endDate=
 */
router.get('/sales-by-hour', internalAuth, async (req: Request, res: Response) => {
  try {
    const { tenantId, startDate, endDate, timezone } = req.query as {
      tenantId: string; startDate: string; endDate: string; timezone?: string;
    };
    if (!tenantId || !startDate || !endDate) {
      res.status(400).json({ error: 'tenantId, startDate, endDate 必填' });
      return;
    }

    // 用门店时区计算日期范围及 SQL 时区转换
    const tz = timezone || await organizationService.getStoreTimezone(tenantId);
    const { periodStart: start } = dayBoundaries(startDate, tz);
    const { periodEnd: end } = dayBoundaries(endDate, tz);
    const sqlTz = pgTimezone(tz);

    const rows = await prisma.$queryRaw<Array<{
      hour: number;
      order_count: bigint;
      total_amount: bigint;
    }>>`
      SELECT
        EXTRACT(HOUR FROM o.created_at AT TIME ZONE ${sqlTz})::int AS hour,
        COUNT(o.id)           AS order_count,
        SUM(o.total_amount)   AS total_amount
      FROM orders o
      WHERE o.tenant_id = ${tenantId}::uuid
        AND o.status = 'COMPLETED'
        AND o.created_at >= ${start}
        AND o.created_at <= ${end}
      GROUP BY hour
      ORDER BY hour
    `;

    res.json({
      success: true,
      data: rows.map(r => ({
        hour:       Number(r.hour),
        orderCount: Number(r.order_count),
        amount:     Number(r.total_amount),
      })),
    });
  } catch (error: any) {
    logger.error('[Internal] 小时销售分布查询失败', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// ─── 仅开发环境：清除测试数据 ─────────────────────────────────────────────────
router.delete('/dev/clear-test-data', internalAuth, async (req: Request, res: Response) => {
  if (process.env.NODE_ENV !== 'development') {
    res.status(403).json({ error: '仅开发环境可用' });
    return;
  }

  const { tenantId } = req.query as { tenantId: string };
  if (!tenantId) {
    res.status(400).json({ error: '缺少 tenantId' });
    return;
  }

  try {
    await prisma.$executeRawUnsafe(`
      DELETE FROM order_item_modifiers
      WHERE order_item_id IN (
        SELECT id FROM order_items
        WHERE order_id IN (SELECT id FROM orders WHERE tenant_id = $1::uuid)
      )
    `, tenantId);

    const items = await prisma.$executeRawUnsafe(`
      DELETE FROM order_items
      WHERE order_id IN (SELECT id FROM orders WHERE tenant_id = $1::uuid)
    `, tenantId);

    const snapshots = await prisma.$executeRawUnsafe(`
      DELETE FROM checkout_snapshots WHERE merchant_id = $1::uuid
    `, tenantId);

    await prisma.$executeRawUnsafe(`DELETE FROM order_analytics`);

    const orders = await prisma.order.deleteMany({ where: { tenantId } });

    logger.info('[Dev] 测试订单数据已清除', { tenantId });
    res.json({
      success: true,
      deleted: {
        orders: orders.count,
        orderItems: items,
        checkoutSnapshots: snapshots,
      },
    });
  } catch (error: any) {
    logger.error('[Dev] 清除测试数据失败', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// ── 礼品卡购买订单（Finance Service 发卡成功后创建）────────────────────────

/**
 * 创建礼品卡购买订单
 * 由 Finance Service 在 GC 发卡成功后调用
 * 不经过正常下单流程，直接写库，状态为 COMPLETED + PAID
 */
router.post('/orders/gift-card', internalAuth, async (req: Request, res: Response) => {
  const {
    tenantId,
    consumerId,
    memberId,
    customerEmail,
    amount,          // 分（cents）
    currency,
    giftCardId,      // Finance Service 的 gift_cards.id
    stripePaymentIntentId,
    isGift,
    recipientEmail,
    senderName,
    recipientName,
  } = req.body;

  if (!tenantId || !amount || !giftCardId) {
    res.status(400).json({ error: 'tenantId, amount, giftCardId 必填' });
    return;
  }

  try {
    // 幂等性：同一 giftCardId 不重复创建订单
    const existing = await prisma.order.findFirst({
      where: { tenantId, externalOrderId: `gc:${giftCardId}` },
      select: { id: true, orderNumber: true },
    });

    if (existing) {
      res.json({ success: true, orderId: existing.id, orderNumber: existing.orderNumber, duplicate: true });
      return;
    }

    const { orderNumber } = await orderService.generateOrderNumber(tenantId, 'WEB');

    const itemName = isGift
      ? `Gift Card (to ${recipientName || recipientEmail || 'recipient'})`
      : 'Gift Card';

    const order = await prisma.order.create({
      data: {
        tenantId,
        orderNumber,
        orderType:     'GIFT_CARD' as any,
        orderSource:   'WEB',
        status:        'COMPLETED',
        paymentStatus: 'PAID',
        paymentMethod: req.body.paymentMethod || 'stripe',
        transactionId: stripePaymentIntentId ?? null,
        externalOrderId: `gc:${giftCardId}`,
        consumerId:    consumerId ?? null,
        memberId:      memberId ?? null,
        customerEmail: customerEmail ?? recipientEmail ?? null,
        subtotal:      amount,
        totalAmount:   amount,
        taxAmount:     0,
        discountAmount: 0,
        createdBy:     tenantId,
        paidAt:        new Date(),
        completedAt:   new Date(),
        orderItems: {
          create: [{
            itemId:     '00000000-0000-0000-0000-000000000000',
            itemName,
            quantity:   1,
            unitPrice:  amount,
            totalPrice: amount,
            specialNotes: isGift && senderName
              ? `From: ${senderName}`
              : null,
          }],
        },
      },
      select: { id: true, orderNumber: true },
    });

    logger.info('[GiftCard] 礼品卡购买订单已创建', {
      orderId: order.id,
      orderNumber: order.orderNumber,
      giftCardId,
      amount,
    });

    res.json({ success: true, orderId: order.id, orderNumber: order.orderNumber });
  } catch (error: any) {
    logger.error('[GiftCard] 创建礼品卡订单失败', { error: error.message, giftCardId });
    res.status(500).json({ error: error.message });
  }
});

// ========== 渠道授信额度接口 ==========

import { getChannelCreditStatus, markOrdersCreditSettled } from '../services/credit.service';

/**
 * GET /internal/channel-credit/:channelConfigId?tenantId=xxx
 * 查询渠道当前周期授信使用情况
 */
router.get('/channel-credit/:channelConfigId', internalAuth, async (req: Request, res: Response) => {
  const { channelConfigId } = req.params;
  const tenantId = req.query.tenantId as string;

  if (!tenantId) {
    res.status(400).json({ error: 'tenantId 必填' });
    return;
  }

  try {
    const status = await getChannelCreditStatus(tenantId, channelConfigId);
    if (!status) {
      res.json({ success: true, data: null, message: '未配置授信额度' });
      return;
    }
    res.json({ success: true, data: status });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /internal/channel-credit/settle
 * finance-service 结清回调：标记订单已结清，额度自动恢复
 * Body: { tenantId, channelConfigId, orderIds? }
 */
router.post('/channel-credit/settle', internalAuth, async (req: Request, res: Response) => {
  const { tenantId, channelConfigId, orderIds } = req.body;

  if (!tenantId || !channelConfigId) {
    res.status(400).json({ error: 'tenantId、channelConfigId 必填' });
    return;
  }

  try {
    const result = await markOrdersCreditSettled({ tenantId, channelConfigId, orderIds });
    logger.info('[Credit] finance 结清回调处理完成', { tenantId, channelConfigId, ...result });
    res.json({ success: true, data: result });
  } catch (error: any) {
    logger.error('[Credit] 结清回调失败', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

export default router;
