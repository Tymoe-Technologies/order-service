import { Router } from 'express';
import orderRoutes from './order.routes';
import deliveryConfirmationRoutes from './delivery-confirmation.routes';
import printRoutes from './print.routes';
import noteRoutes from './note.routes';
import statisticsRoutes from './statistics.routes';
import salesChannelRoutes from './sales-channel.routes';
import syncRoutes from './sync.routes';
import merchantConfigRoutes from './merchant-config.routes';
import fulfillmentOptionRoutes from './fulfillment-option.routes';
import { markCustomerArrived } from '../controllers/curbside.controller';
import itemProxyRoutes from './item-proxy.routes';
import checkoutSnapshotRoutes from './checkout-snapshot.routes';
import printSettingRoutes from './print-setting.routes';
import printBrandRoutes from './print-brand.routes';
import receiptTemplateRoutes from './receipt-template.routes';

const router = Router();

// ========== 标准 REST 端点（需要认证或商家 ID） ==========
// 在 /orders 前缀下注册标准 REST 端点
// 但 order.routes 中同时包含 /pos, /, /web, /internal 等多个前缀的路由
// 所以需要分别处理

// 对于 /orders 前缀的路由：POST /, GET /, GET /:orderId, PATCH /:orderId/status 等
// 需要从 orderRoutes 中过滤出来，或者在这里重新定义

// 简单解决方案：将 orderRoutes 挂载到 /orders，但这样会导致 /web 和 /internal 也被挂载到 /orders 下
// 实际上，我们需要拆分 order.routes.ts，或者使用正则表达式来匹配
router.use('/orders', orderRoutes);
router.use('/orders', printRoutes);
router.use('/orders', noteRoutes);
router.use('/orders', deliveryConfirmationRoutes);
router.use('/statistics', statisticsRoutes);
router.use('/sales-channels', salesChannelRoutes);
router.use('/sync', syncRoutes);
router.use('/', merchantConfigRoutes);
// 履约方式配置（管理端 + /public 顾客端），与 merchantConfig 同前缀
router.use('/', fulfillmentOptionRoutes);
router.use('/', itemProxyRoutes);
router.use('/print-settings', printSettingRoutes);
router.use('/print-brand', printBrandRoutes);
router.use('/receipt-templates', receiptTemplateRoutes);

// ========== Checkout Snapshot 端点（公开，无需认证） ==========
router.use('/checkout-snapshots', checkoutSnapshotRoutes);

// ========== Web 在线点单端点（公开，无需认证） ==========
// 这些路由被定义在 orderRoutes 中但被挂载到了 /orders，
// 所以需要从 orderRoutes 中提取出来，直接在这里注册
// 为了避免重复，我们使用条件挂载或在这里引用 orderController

// 注意：以下路由定义重复于 order.routes.ts，但为了正确的路径，必须在这里重新定义
import orderController from '../controllers/order.controller';
import { authenticate } from '../middleware/auth';
import { requireModulePermission } from '../middleware/requirePermission';
import prisma from '../utils/prisma';

const requireOrdersView = requireModulePermission('orders', 'view');
const requireOrdersEdit = requireModulePermission('orders', 'edit');

// ========== Consumer 端点（Consumer JWT 认证） ==========
router.get('/consumer/orders', authenticate, orderController.getConsumerOrders.bind(orderController));
router.get('/consumer/orders/:orderId', authenticate, orderController.getConsumerOrderDetail.bind(orderController));

// ========== 预约订单端点 ==========
// GET  /orders/scheduled?date=YYYY-MM-DD  — 查询当日预约单（需要认证）
// POST /orders/scheduled/release          — 释放到期预约单（需要认证，也可由定时任务内部调用）
router.get('/orders/scheduled', authenticate, requireOrdersView, orderController.getScheduledOrders.bind(orderController));
router.post('/orders/scheduled/release', authenticate, requireOrdersEdit, orderController.releaseScheduledOrders.bind(orderController));

router.get('/web/by-payment/:paymentIntentId', orderController.getByPaymentIntent);
router.get('/web/orders/:orderId', orderController.getOrderById);
router.post('/web/create-from-snapshot', orderController.createTemporaryOrder);
router.post('/web/confirm-free-order', orderController.confirmFreeOrder);
router.post('/web/confirm-account-order', orderController.confirmAccountOrder);
// 路边取餐「我到了」：点这个按钮的是顾客，所以和同前缀的其它 /web 接口一样无需认证
router.post('/web/orders/:orderId/arrived', markCustomerArrived);
// /web/create-verified 已废弃，Web 端统一走 create-from-snapshot + confirm-free-order/Stripe webhook

// 内部服务接口已迁移到 src/routes/internal.ts（挂载在 /internal，无需 merchantId）

// 仅开发环境：清除当前商户所有测试订单数据
router.delete('/admin/dev/clear-test-data', authenticate, async (req, res) => {
  if (process.env.NODE_ENV !== 'development') {
    res.status(403).json({ success: false, message: '仅开发环境可用' });
    return;
  }
  const merchantId = (req as any).merchantId || req.headers['x-merchant-id'] as string;
  if (!merchantId) {
    res.status(400).json({ success: false, message: '缺少 merchantId' });
    return;
  }
  try {
    const orderIds = (await prisma.order.findMany({ where: { merchantId }, select: { id: true } })).map(o => o.id);
    const [notes, items, orders] = await Promise.all([
      prisma.orderNote.deleteMany({ where: { orderId: { in: orderIds } } }),
      prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } }),
      prisma.order.deleteMany({ where: { merchantId } }),
    ]);
    res.json({ success: true, deleted: { orderNotes: notes.count, orderItems: items.count, orders: orders.count } });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
});

export default router;
