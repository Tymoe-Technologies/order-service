/**
 * 打印任务生成器
 *
 * 新设计：后端只生成「打印触发」事件，将完整 order 数据发送给前端
 * 前端（POS）负责所有格式化逻辑：
 * - 使用本地时间（不是服务器时间）
 * - 根据 PrintSetting 决定打印内容
 * - 使用 PrinterService 进行统一的格式化渲染
 *
 * 优点：
 * ✅ 所有渠道订单使用同一套打印格式逻辑
 * ✅ 自动支持所有自定义选项、制作指引等
 * ✅ 时间问题自动解决（使用设备本地时间）
 * ✅ 减少后端打印逻辑复杂度
 */

import prisma from '../utils/prisma';
import logger from '../utils/logger';
import type { PrintTaskSource } from './types';
import { splitByStation, type RoutingStation, type RoutingRule } from '../services/print-routing';

// OrderSource -> PrintTaskSource 映射
const SOURCE_MAP: Record<string, PrintTaskSource> = {
  POS: 'POS',
  WEB: 'ONLINE',
  KIOSK: 'KIOSK',
};

// TicketType -> 基础优先级（数字越小越先打）
// 标签类任务（ITEM_LABEL / CUSTOM_LABEL）使用动态 priority 确保交错顺序
const PRIORITY_MAP: Record<string, number> = {
  KITCHEN_TICKET: 1,
  CUSTOMER_RECEIPT: 2,
};
// 标签任务优先级起始值（高于收据/厨房单）
const LABEL_PRIORITY_BASE = 100;

// 订单（含关联数据）
interface OrderWithItems {
  id: string;
  tenantId: string;
  orderNumber: string;
  orderType: string;
  orderSource: string;
  tableNumber: string | null;
  customerName: string | null;
  customerPhone: string | null;
  subtotal: number;
  taxAmount: number;
  discountAmount: number;
  serviceFee: number;
  deliveryFee: number;
  tipAmount: number;
  totalAmount: number;
  paymentStatus: string;
  paymentMethod: string | null;
  notes: string | null;
  customLabelData: any | null;
  createdAt: Date;
  orderItems: Array<{
    id: string;
    itemId: string;
    categoryId?: string | null;
    itemName: string;
    quantity: number;
    unitPrice: number;
    totalPrice: number;
    discountAmount: number;
    attributes: any;
    specialNotes: string | null;
    orderItemModifiers: Array<{
      groupName: string;
      optionName: string;
      unitPrice: number;
      quantity: number;
    }>;
  }>;
}

/**
 * 为订单生成打印任务
 *
 * 新逻辑：只检查租户的打印设置是否启用，然后为每个启用的票据类型创建一个任务
 * 不再在后端生成 payload，而是将完整 order 数据作为 payload 发送给前端
 *
 * 前端（POS PrinterService）将负责：
 * 1. 根据 ticketType 和 PrintSetting 决定输出内容
 * 2. 使用本地时间格式化
 * 3. 渲染标签、收据、厨房单等
 */
export async function generatePrintTasksForOrder(
  order: OrderWithItems,
  tenantId: string,
  clientOrigin: string,
): Promise<any[]> {
  // 查询租户已启用的打印设置
  const printSettings = await prisma.printSetting.findMany({
    where: {
      tenantId,
      isEnabled: true,
      ticketType: { in: ['CUSTOMER_RECEIPT', 'KITCHEN_TICKET', 'ITEM_LABEL'] },
    },
  });

  if (printSettings.length === 0) {
    logger.info('[PrintTaskGen] 租户无启用的打印设置，跳过', { tenantId });
    return [];
  }

  const source = SOURCE_MAP[clientOrigin] || 'POS';
  // 备餐站配置只在真要出厨房单时查，省掉一次往返
  const routing = printSettings.some((s) => s.ticketType === 'KITCHEN_TICKET')
    ? await loadRoutingConfig(tenantId)
    : null;
  const tasks: any[] = [];
  // 标签任务序号：用于生成唯一递增的 priority，保证 ITEM_LABEL 与 CUSTOM_LABEL 交错打印
  // PostgreSQL 同一事务内 createdAt 相同，不能依赖 createdAt 排序，必须用 priority 区分
  let labelSeq = 0;

  const hasCustomLabel = clientOrigin === 'WEB' && !!order.customLabelData;

  for (const setting of printSettings) {
    const ticketType = setting.ticketType;

    if (ticketType === 'ITEM_LABEL') {
      // 全单总标签数（所有商品数量之和）
      const totalLabels = order.orderItems.reduce((sum, it) => sum + it.quantity, 0);
      let globalSeq = 0;

      for (let i = 0; i < order.orderItems.length; i++) {
        const item = order.orderItems[i];
        for (let q = 0; q < item.quantity; q++) {
          globalSeq++;
          // 每张 item label 使用偶数 priority slot
          const itemLabelPriority = LABEL_PRIORITY_BASE + labelSeq * 2;
          labelSeq++;

          tasks.push({
            tenantId,
            orderId: order.id,
            ticketType: 'ITEM_LABEL',
            source,
            priority: itemLabelPriority,
            payload: {
              orderData: order,
              itemIndex: i,
              itemQuantity: globalSeq,
              totalQuantity: totalLabels,
            },
          });

          // 自定义标签紧跟在对应 item label 后面（奇数 priority slot）
          if (hasCustomLabel) {
            tasks.push({
              tenantId,
              orderId: order.id,
              ticketType: 'CUSTOM_LABEL',
              source,
              priority: itemLabelPriority + 1,
              payload: {
                orderData: order,
                itemIndex: i,
                customLabelData: order.customLabelData,
              },
            });
          }
        }
      }
    } else if (ticketType === 'KITCHEN_TICKET') {
      // 厨房单：按备餐站拆成多张，每张只印属于该站的商品
      const groups = splitByStation(order.orderItems, routing?.stations || [], routing?.rules || []);
      for (const g of groups) {
        tasks.push({
          tenantId,
          orderId: order.id,
          ticketType,
          stationId: g.stationId,
          source,
          priority: PRIORITY_MAP[ticketType],
          payload: {
            orderData: order,
            station: g.stationId ? { id: g.stationId, name: g.stationName } : null,
            // 只带行 id，不复制商品对象 —— orderData 里已经有全量，
            // 复制一份会让 payload 随站数翻倍，而且两份数据早晚会不一致
            lineIds: g.lines.map((l) => l.id),
            stationIndex: g.stationIndex,
            stationTotal: g.stationTotal,
            coStations: g.coStations,
            unroutedLineIds: g.unroutedLineIds,
          },
        });
      }
    } else {
      // 收据：一个任务
      tasks.push({
        tenantId,
        orderId: order.id,
        ticketType,
        source,
        priority: PRIORITY_MAP[ticketType] || 2,
        payload: {
          orderData: order,
        },
      });
    }
  }

  if (tasks.length === 0) return [];

  // 批量创建打印任务
  const createdTasks = await prisma.$transaction(
    tasks.map((task) =>
      prisma.printTask.create({ data: task }),
    ),
  );

  logger.info('[PrintTaskGen] 打印任务已生成', {
    orderId: order.id,
    orderNumber: order.orderNumber,
    count: createdTasks.length,
    types: createdTasks.map((t) => t.ticketType),
    kitchenStations: createdTasks.filter((t) => t.stationId).length,
  });

  return createdTasks;
}

/**
 * 读租户的备餐站与路由规则。
 *
 * 停用的站也读回来 —— 路由算法要靠 isActive 判断「规则指向的站已停用，
 * 继续往下一级找」，在 SQL 里先滤掉的话它就只能看到「没有规则」，
 * 两种情况的处置本来是一样的，但少了这个字段就没法在日志里区分。
 */
async function loadRoutingConfig(
  tenantId: string,
): Promise<{ stations: RoutingStation[]; rules: RoutingRule[] }> {
  const [stations, rules] = await Promise.all([
    prisma.printStation.findMany({
      where: { tenantId },
      select: { id: true, name: true, isDefault: true, isActive: true, sortOrder: true },
    }),
    prisma.printRoute.findMany({
      where: { tenantId },
      select: { stationId: true, matchType: true, matchId: true },
    }),
  ]);
  return { stations, rules };
}
