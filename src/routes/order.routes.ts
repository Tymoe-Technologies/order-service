import { Router } from 'express';
import orderController from '../controllers/order.controller';
import { authenticate } from '../middleware/auth';
import { requireModulePermission } from '../middleware/requirePermission';
import { validate } from '../middleware/validation';
import {
  createOrderSchema,
  updateOrderStatusSchema,
  cancelOrderSchema,
} from '../validators/order.validator';

const router = Router();
const requireOrders = requireModulePermission('orders');

// ========== POS 专用端点（不需要认证）==========
// 本地 POS 系统通过 Kotlin 服务调用，无需认证
// 需要在请求头中提供 X-Tenant-ID
router.post('/pos', validate(createOrderSchema), orderController.createOrderFromPOS);

// ========== 标准 REST 端点 ==========
router.post('/', authenticate, requireOrders, validate(createOrderSchema), orderController.createOrder);
router.get('/', authenticate, requireOrders, orderController.getOrders);
router.get('/:orderId', authenticate, requireOrders, orderController.getOrderById);
router.patch(
  '/:orderId/status',
  authenticate,
  requireOrders,
  validate(updateOrderStatusSchema),
  orderController.updateOrderStatus
);
router.get(
  '/:orderId/status-history',
  authenticate,
  requireOrders,
  orderController.getOrderStatusHistory
);
router.post(
  '/batch-status',
  authenticate,
  requireOrders,
  orderController.batchUpdateStatus
);
router.post(
  '/:orderId/cancel',
  authenticate,
  requireOrders,
  validate(cancelOrderSchema),
  orderController.cancelOrder
);

// ========== Item 扫码完成端点 ==========
router.post(
  '/items/:orderItemId/ready',
  authenticate,
  requireOrders,
  orderController.markItemReady
);

// ========== Web 和内部服务端点已在 routes/index.ts 中定义，避免重复 ==========
// - /web/* 路由在 index.ts 中注册（正确的路径）
// - /internal/* 路由在 index.ts 中注册（正确的路径）
// - /:orderId/payment-status 在 index.ts 中注册（正确的路径）

// ========== 备注 ==========
// RabbitMQ 消费已通过直连方式实现（src/services/rabbitmq-consumer.ts）
// 不再需要 HTTP webhook 端点

export default router;
