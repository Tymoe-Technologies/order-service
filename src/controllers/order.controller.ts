import { Request, Response, NextFunction } from 'express';
import orderService from '../services/order.service';
import orderStatusService from '../services/order-status.service';
import { successResponse } from '../utils/response';

function requireDateRange(req: Request, res: Response): { startDate: string; endDate: string } | null {
  const startDate = req.query.startDate as string;
  const endDate = req.query.endDate as string;
  if (!startDate || !endDate) {
    res.status(400).json({
      success: false,
      error: { code: 'MISSING_PARAMS', message: '缺少必需的查询参数: startDate, endDate' },
    });
    return null;
  }
  return { startDate, endDate };
}

export class OrderController {
  async createOrder(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.userId;
      const tenantId = req.user!.tenantId;
      // 获取 token（可选，POS/KIOSK 不需要，Web 端需要用于价格验证）
      const token = req.headers.authorization;
      
      const result = await orderService.createOrder(req.body, userId, tenantId, token);
      successResponse(res, result, 201);
    } catch (error) {
      next(error);
    }
  }

  async getOrders(req: Request, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;
      const query = {
        status: req.query.status as string,
        orderType: req.query.orderType as string,
        clientOrigin: req.query.clientOrigin as string,
        startDate: req.query.startDate as string,
        endDate: req.query.endDate as string,
        page: req.query.page ? parseInt(req.query.page as string) : undefined,
        limit: req.query.limit ? parseInt(req.query.limit as string) : undefined,
        search: req.query.search as string | undefined,
      };
      const result = await orderService.getOrders(query, tenantId);
      successResponse(res, result);
    } catch (error) {
      next(error);
    }
  }

  async getOrderById(req: Request, res: Response, next: NextFunction) {
    try {
      const { orderId } = req.params;

      // 支持两种方式获取 tenantId：
      // 1. 认证请求 (req.user.tenantId)
      // 2. Web 请求 (X-Merchant-Id header)
      let tenantId = req.user?.tenantId;

      if (!tenantId) {
        // 尝试从 X-Merchant-Id header 获取（Web 前端请求）
        const merchantId = req.headers['x-merchant-id'] as string;
        if (!merchantId) {
          return res.status(400).json({
            success: false,
            error: 'Missing authentication or X-Merchant-Id header',
          });
        }
        // 对于 Web 请求，使用 merchantId 作为 tenantId
        tenantId = merchantId;
      }

      const result = await orderService.getOrderById(orderId, tenantId);
      successResponse(res, result);
    } catch (error) {
      next(error);
    }
  }

  async updateOrderStatus(req: Request, res: Response, next: NextFunction) {
    try {
      const { orderId } = req.params;
      const { status, reason } = req.body;
      const userId = req.user!.userId;
      const tenantId = req.user!.tenantId;
      const result = await orderStatusService.updateOrderStatus(
        orderId,
        status,
        userId,
        tenantId,
        reason
      );
      successResponse(res, result);
    } catch (error) {
      next(error);
    }
  }

  async getOrderStatusHistory(req: Request, res: Response, next: NextFunction) {
    try {
      const { orderId } = req.params;
      const tenantId = req.user!.tenantId;
      const result = await orderStatusService.getOrderStatusHistory(orderId, tenantId);
      successResponse(res, result);
    } catch (error) {
      next(error);
    }
  }

  async batchUpdateStatus(req: Request, res: Response, next: NextFunction) {
    try {
      const { orderIds, status, reason } = req.body;
      const userId = req.user!.userId;
      const tenantId = req.user!.tenantId;
      const result = await orderStatusService.batchUpdateStatus(
        orderIds,
        status,
        userId,
        tenantId,
        reason
      );
      successResponse(res, result);
    } catch (error) {
      next(error);
    }
  }

  async cancelOrder(req: Request, res: Response, next: NextFunction) {
    try {
      const { orderId } = req.params;
      const { reason } = req.body;
      const tenantId = req.user!.tenantId;
      await orderService.cancelOrder(orderId, reason, tenantId);
      successResponse(res, { message: '订单已取消' });
    } catch (error) {
      next(error);
    }
  }

  async getStatistics(req: Request, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;
      const startDate = req.query.startDate as string;
      const endDate = req.query.endDate as string;

      if (!startDate || !endDate) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'MISSING_PARAMS',
            message: '缺少必需的查询参数: startDate, endDate',
          },
        });
      }

      const result = await orderService.getStatistics(startDate, endDate, tenantId);
      successResponse(res, result);
    } catch (error) {
      next(error);
    }
  }

  async getRevenueStatistics(req: Request, res: Response, next: NextFunction) {
    try {
      const range = requireDateRange(req, res);
      if (!range) return;
      const tenantId = req.user!.tenantId;
      const groupBy = (req.query.groupBy as any) || 'day';
      const result = await orderService.getRevenueStatistics(
        range.startDate,
        range.endDate,
        tenantId,
        groupBy
      );
      successResponse(res, result);
    } catch (error) {
      next(error);
    }
  }

  async getItemStatistics(req: Request, res: Response, next: NextFunction) {
    try {
      const range = requireDateRange(req, res);
      if (!range) return;
      const tenantId = req.user!.tenantId;
      const page = req.query.page ? parseInt(req.query.page as string) : 1;
      const pageSize = req.query.pageSize ? parseInt(req.query.pageSize as string) : 20;
      const result = await orderService.getItemStatistics(
        range.startDate,
        range.endDate,
        tenantId,
        page,
        pageSize
      );
      successResponse(res, result);
    } catch (error) {
      next(error);
    }
  }

  async getTaxStatistics(req: Request, res: Response, next: NextFunction) {
    try {
      const range = requireDateRange(req, res);
      if (!range) return;
      const tenantId = req.user!.tenantId;
      const groupBy = (req.query.groupBy as any) || 'day';
      const result = await orderService.getTaxStatistics(
        range.startDate,
        range.endDate,
        tenantId,
        groupBy
      );
      successResponse(res, result);
    } catch (error) {
      next(error);
    }
  }

  async getReconciliationStatistics(req: Request, res: Response, next: NextFunction) {
    try {
      const range = requireDateRange(req, res);
      if (!range) return;
      const tenantId = req.user!.tenantId;
      const result = await orderService.getReconciliationStatistics(
        range.startDate,
        range.endDate,
        tenantId
      );
      successResponse(res, result);
    } catch (error) {
      next(error);
    }
  }

  /**
   * POS 可信订单创建端点（不需要认证）
   * 用于本地 POS 系统通过 Kotlin 服务调用
   * 需要通过 X-Tenant-ID 头提供租户ID
   */
  async createOrderFromPOS(req: Request, res: Response, next: NextFunction) {
    try {
      // 从请求头获取租户ID
      const tenantId = req.headers['x-tenant-id'] as string;
      if (!tenantId) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'MISSING_TENANT_ID',
            message: '缺少必需的 X-Tenant-ID 请求头',
          },
        });
      }

      // 确保客户端入口为 POS
      const data = req.body;
      data.clientOrigin = 'POS';

      // POS 是可信来源，使用固定的系统 userId
      const userId = 'pos-system';

      const result = await orderService.createOrder(data, userId, tenantId, undefined);
      successResponse(res, result, 201);
    } catch (error) {
      next(error);
    }
  }

  /**
   * 从快照创建订单（内部端点，Finance Service Webhook 调用）
   * POST /internal/orders/from-snapshot
   */
  async createFromSnapshot(req: Request, res: Response, next: NextFunction) {
    try {
      const merchantId = req.headers['x-merchant-id'] as string;
      if (!merchantId) {
        return res.status(400).json({
          success: false,
          error: 'Missing X-Merchant-Id header',
        });
      }

      const { snapshotId, paymentIntentId } = req.body;
      if (!snapshotId || !paymentIntentId) {
        return res.status(400).json({
          success: false,
          error: 'Missing required fields: snapshotId, paymentIntentId',
        });
      }

      const order = await orderService.createOrderFromSnapshot({
        snapshotId,
        paymentIntentId,
        merchantId,
      });

      successResponse(res, order, 201);
    } catch (error) {
      next(error);
    }
  }

  /**
   * 通过 paymentIntentId 查询订单（前端轮询）
   * GET /web/by-payment/:paymentIntentId
   */
  async getByPaymentIntent(req: Request, res: Response, next: NextFunction) {
    try {
      const merchantId = req.headers['x-merchant-id'] as string;
      if (!merchantId) {
        return res.status(400).json({
          success: false,
          error: 'Missing X-Merchant-Id header',
        });
      }

      const { paymentIntentId } = req.params;
      if (!paymentIntentId) {
        return res.status(400).json({
          success: false,
          error: 'Missing paymentIntentId parameter',
        });
      }

      const order = await orderService.getOrderByPaymentIntent(paymentIntentId, merchantId);

      if (!order) {
        return res.status(404).json({
          success: false,
          error: 'Order not found',
        });
      }

      successResponse(res, order);
    } catch (error) {
      next(error);
    }
  }

  /**
   * 前端直接创建订单（备用路径，带支付验证）
   * POST /web/create-verified
   */
  async createTemporaryOrder(req: Request, res: Response, next: NextFunction) {
    try {
      const merchantId = req.headers['x-merchant-id'] as string;
      if (!merchantId) {
        return res.status(400).json({
          success: false,
          error: 'Missing X-Merchant-Id header',
        });
      }

      const { snapshotId } = req.body;
      if (!snapshotId) {
        return res.status(400).json({
          success: false,
          error: 'Missing required field: snapshotId',
        });
      }

      const order = await orderService.createTemporaryOrderFromSnapshot({
        snapshotId,
        merchantId,
      });

      successResponse(res, order, 201);
    } catch (error) {
      next(error);
    }
  }

  async createOrderVerified(req: Request, res: Response, next: NextFunction) {
    try {
      const merchantId = req.headers['x-merchant-id'] as string;
      if (!merchantId) {
        return res.status(400).json({
          success: false,
          error: 'Missing X-Merchant-Id header',
        });
      }

      const { snapshotId, paymentIntentId } = req.body;
      if (!snapshotId || !paymentIntentId) {
        return res.status(400).json({
          success: false,
          error: 'Missing required fields: snapshotId, paymentIntentId',
        });
      }

      const order = await orderService.createOrderVerified({
        snapshotId,
        paymentIntentId,
        merchantId,
      });

      successResponse(res, order, 201);
    } catch (error) {
      next(error);
    }
  }

  /**
   * 渠道记账下单，无需在线支付
   * POST /web/confirm-account-order
   */
  async confirmAccountOrder(req: Request, res: Response, next: NextFunction) {
    try {
      const merchantId = req.headers['x-merchant-id'] as string;
      if (!merchantId) {
        return res.status(400).json({ success: false, error: 'Missing X-Merchant-Id header' });
      }
      const { orderId, channelId, channelName } = req.body;
      if (!orderId) {
        return res.status(400).json({ success: false, error: 'Missing required field: orderId' });
      }
      const result = await orderService.confirmAccountOrder({ orderId, merchantId, channelId, channelName });
      successResponse(res, result, 200);
    } catch (error) {
      next(error);
    }
  }

  /**
   * 免支付确认订单（total = 0 的订单，如全额兑换 reward）
   * POST /web/confirm-free-order
   */
  async confirmFreeOrder(req: Request, res: Response, next: NextFunction) {
    try {
      const merchantId = req.headers['x-merchant-id'] as string;
      if (!merchantId) {
        return res.status(400).json({ success: false, error: 'Missing X-Merchant-Id header' });
      }

      const { orderId } = req.body;
      if (!orderId) {
        return res.status(400).json({ success: false, error: 'Missing required field: orderId' });
      }

      const result = await orderService.confirmFreeOrder({ orderId, merchantId });
      successResponse(res, result, 200);
    } catch (error) {
      next(error);
    }
  }

  /**
   * 更新订单支付状态（服务间调用，来自 Finance Service）
   * PATCH /api/order/v1/orders/:orderId/payment-status
   */
  async updatePaymentStatus(req: Request, res: Response, next: NextFunction) {
    try {
      // 从请求头获取 tenantId（Finance Service 传递）
      const tenantId = req.headers['x-organization-id'] as string;
      if (!tenantId) {
        return res.status(400).json({
          success: false,
          error: { code: 'MISSING_TENANT_ID', message: '缺少必需的 X-Organization-Id 请求头' },
        });
      }

      const { orderId } = req.params;
      const {
        paymentStatus, paymentIntentId, paymentMethod,
        paymentId, externalPaymentId, tipAmount, totalAmount, provider,
      } = req.body;

      // 验证 paymentStatus 值
      const validStatuses = ['PAID', 'UNPAID', 'PARTIALLY_PAID', 'REFUNDED', 'FAILED'];
      if (!paymentStatus || !validStatuses.includes(paymentStatus)) {
        return res.status(400).json({
          success: false,
          error: { code: 'INVALID_PAYMENT_STATUS', message: `无效的支付状态。允许的值: ${validStatuses.join(', ')}` },
        });
      }

      const result = await orderService.updatePaymentStatus({
        orderId,
        tenantId,
        paymentStatus,
        paymentIntentId,
        paymentMethod,
        paymentId,
        externalPaymentId,
        tipAmount,
        totalAmount,
        provider,
      });

      successResponse(res, result);
    } catch (error) {
      next(error);
    }
  }

  /**
   * 消费者查询自己的订单历史（Consumer JWT 认证）
   * GET /consumer/orders
   */
  async getConsumerOrders(req: Request, res: Response, next: NextFunction) {
    try {
      const consumerId = req.user!.userId;
      const page = req.query.page ? parseInt(req.query.page as string) : 1;
      const limit = req.query.limit ? parseInt(req.query.limit as string) : 10;

      const result = await orderService.getConsumerOrders(consumerId, { page, limit });
      successResponse(res, result);
    } catch (error) {
      next(error);
    }
  }

  /**
   * 查询当日预约订单列表
   * GET /orders/scheduled?date=YYYY-MM-DD
   */
  async getScheduledOrders(req: Request, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user!.tenantId;
      const date = req.query.date as string | undefined;
      const result = await orderService.getScheduledOrders(tenantId, date);
      successResponse(res, result);
    } catch (error) {
      next(error);
    }
  }

  /**
   * 手动触发释放到期预约订单（也可由定时任务调用）
   * POST /orders/scheduled/release
   * Body: { leadMinutes?: number }  默认提前 30 分钟释放
   */
  async releaseScheduledOrders(req: Request, res: Response, next: NextFunction) {
    try {
      const leadMinutes = req.body?.leadMinutes ?? 30;
      const released = await orderService.releaseScheduledOrders(leadMinutes);
      successResponse(res, { released, message: `已释放 ${released} 个预约订单` });
    } catch (error) {
      next(error);
    }
  }

  async markItemReady(req: Request, res: Response, next: NextFunction) {
    try {
      const { orderItemId } = req.params;
      const completedBy = (req as any).user?.id;
      const { markItemReady } = await import('../services/order-item.service');
      const result = await markItemReady(orderItemId, completedBy);
      successResponse(res, result);
    } catch (error) {
      next(error);
    }
  }
}

export default new OrderController();
