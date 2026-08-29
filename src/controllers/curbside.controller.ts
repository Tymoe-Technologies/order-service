import { Request, Response } from 'express';
import { PrismaClient } from '.prisma/client-order';
import logger from '../utils/logger';

const prisma = new PrismaClient();

/**
 * 路边取餐（CURBSIDE）的「我到了」
 *
 * ⚠️ 顾客端暂未启用：consumer-app 是网页端，顾客付完款跳到确认页后如果关掉
 * 页面就很难找回订单（底部导航没有「我的订单」入口，未登录也查不了），
 * 所以这个按钮暂时没做。当前的运作方式是：顾客下单时留车牌，店员在
 * 订单详情和小票上看到车辆信息，做好后直接送到停车场 —— 不依赖顾客操作。
 *
 * 接口本身是完整的、有测试覆盖的，要启用只需在确认页加一个按钮
 * （最好同时给确认页加状态轮询，否则顾客不知道餐做好没有）。
 * 在那之前这个端点不会被调用。
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
