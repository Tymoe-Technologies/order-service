import { Request, Response } from 'express';
import { PrismaClient } from '.prisma/client-order';
import logger from '../utils/logger';

const prisma = new PrismaClient();

/**
 * 路边取餐（CURBSIDE）的「我到了」
 *
 * 顾客到店后在车里点一下，门店才知道该把餐送出去。没有这一步，CURBSIDE 订单
 * 在 READY 之后就断了 —— 店员不知道人来没来，顾客不知道该等还是该进店。
 *
 * 走 /web 前缀（无认证）：点这个按钮的是顾客，不是商家用户。
 * 用 orderId 做凭证 —— 与同前缀下的 GET /web/orders/:orderId 一致：
 * orderId 是 UUID，猜不出来，而这个操作的最坏后果只是让店员白跑一趟。
 */
export async function markCustomerArrived(req: Request, res: Response) {
  try {
    const { orderId } = req.params;
    const { spot, vehicleInfo } = req.body ?? {};

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, orderType: true, status: true, arrivedAt: true, vehicleInfo: true, tenantId: true },
    });

    if (!order) {
      return res.status(404).json({
        success: false,
        error: { code: 'ORDER_NOT_FOUND', message: '订单不存在' },
      });
    }

    if (order.orderType !== 'CURBSIDE') {
      return res.status(400).json({
        success: false,
        error: { code: 'NOT_CURBSIDE_ORDER', message: '只有路边取餐订单可以报到' },
      });
    }

    // 已取餐/已完成/已取消的单不该再报到
    if (['PICKED_UP', 'COMPLETED', 'CANCELLED'].includes(order.status)) {
      return res.status(400).json({
        success: false,
        error: { code: 'ORDER_CLOSED', message: '订单已结束' },
      });
    }

    // 重复点击直接返回成功：顾客等急了会连点，每次都报错反而像是没生效
    if (order.arrivedAt) {
      return res.json({
        success: true,
        data: { orderId: order.id, arrivedAt: order.arrivedAt, alreadyArrived: true },
      });
    }

    // 到店时把车位号/车辆信息补上：不少顾客是到了才知道自己停在几号位
    const mergedVehicle = {
      ...(order.vehicleInfo as Record<string, any> | null ?? {}),
      ...(vehicleInfo ?? {}),
      ...(spot ? { spot } : {}),
    };

    const updated = await prisma.order.update({
      where: { id: orderId },
      data: {
        arrivedAt: new Date(),
        vehicleInfo: Object.keys(mergedVehicle).length > 0 ? mergedVehicle : undefined,
        // 只在餐已备好时推进状态：还在 PREPARING 就改成 CUSTOMER_ARRIVED 会让
        // 厨房以为可以出餐了。到得早就只记时间，等 READY 之后店员自己看 arrivedAt
        ...(order.status === 'READY' ? { status: 'CUSTOMER_ARRIVED' as const } : {}),
      },
      select: { id: true, status: true, arrivedAt: true, vehicleInfo: true },
    });

    logger.info('顾客已到店（curbside）', { orderId, status: updated.status });
    return res.json({ success: true, data: updated });
  } catch (error: any) {
    logger.error('curbside 报到失败', { error: error.message });
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: error.message },
    });
  }
}
