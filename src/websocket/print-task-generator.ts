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
import { splitByStation, splitByItem, type RoutingStation, type RoutingRule, type KitchenSplitMode } from '../services/print-routing';

/**
 * 这一行是耗材还是真商品。
 *
 * 耗材（餐具 / 购物袋 / 打包费）作为独立订单行存在同一张 order_items 里
 * （见 OrderItem.lineKind 的说明），好处是小票、退款、计税全都复用商品行
 * 那套逻辑；代价是**每个「按商品」的口径都得记得排除它**。
 * 漏掉的表现是静默的：每个购物袋各出一张标签、厨房单上出现「1× 打包费」。
 */
const isSupplyLine = (line: { lineKind?: string }): boolean => line.lineKind === 'SUPPLY';

/**
 * 套餐子项（出标签用）。
 *
 * ## ⚠️ 这个筛选规则和 POS 的 `utils/comboLine.comboChildrenOf` 必须一致
 * 服务端只在 payload 里带 `comboChildIndex` 这一个数字，客户端是拿
 * **自己**摊开后的数组按这个下标取子项的。两边的过滤规则（`itemId` 非空）
 * 或顺序错开一点，标签上就印成**另一个子项**的名字和配方 ——
 * 和 `itemIndex` 那条一样，是不会报错的静默错误。
 * 两边各钉一组同样的测试（POS: comboLine.test.ts）。
 */
const comboChildrenOf = (line: any): any[] => {
  const raw = line?.comboSelections;
  if (!Array.isArray(raw)) return [];
  return raw.filter((c: any) => !!c?.itemId);
};

/** 一个「标签单位」：要打几张、客户端怎么反查这一行 */
export interface LabelUnit<T> {
  /** 这一行（套餐子项时是**套餐那一行**，子项不在 order_items 里） */
  item: T;
  /** **原数组**的下标 */
  index: number;
  /** 套餐子项下标；普通行不带。客户端摊开套餐后按它取子项 */
  comboChildIndex?: number;
  /** 这一单位要出几张标签（套餐 ×2 里的 1 杯奶茶 = 2 张） */
  quantity: number;
}

/**
 * 要出标签的「单位」+ 它们在**原数组**里的下标。
 *
 * 下标必须是原数组的：payload 里只带 `itemIndex`，客户端是拿
 * `orderData.orderItems[itemIndex]` 取回那一行的。用过滤后的下标会
 * **取到错误的商品** —— 标签上印着别的菜名，而这种错没有任何报错。
 *
 * **套餐按子项摊开**：杯贴是贴在杯子上的，一份三杯的套餐要出三张、
 * 各自带自己的配方。原来套餐只出一张、印着套餐名，另外两个杯子没贴纸。
 *
 * 导出只为单测。
 */
export function labelLinesWithIndex<T extends { lineKind?: string; quantity: number }>(
  orderItems: T[],
): Array<LabelUnit<T>> {
  const units: Array<LabelUnit<T>> = [];
  orderItems.forEach((item, index) => {
    if (isSupplyLine(item)) return;
    const lineQty = Number(item.quantity) || 1;
    const children = comboChildrenOf(item);
    if (children.length === 0) {
      units.push({ item, index, quantity: lineQty });
      return;
    }
    children.forEach((child, comboChildIndex) => {
      units.push({
        item,
        index,
        comboChildIndex,
        quantity: (Number(child?.quantity) || 1) * lineQty,
      });
    });
  });
  return units;
}

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
    /** PRODUCT | SUPPLY。耗材（餐具/购物袋/打包费）不出标签、不上厨房单 */
    lineKind?: string;
    categoryId?: string | null;
    itemName: string;
    quantity: number;
    unitPrice: number;
    totalPrice: number;
    discountAmount: number;
    attributes: any;
    specialNotes: string | null;
    /**
     * 套餐子项快照（非套餐行为 null）。见 OrderItem.comboSelections。
     *
     * 出票要用它：收据列出套餐装了什么、厨房单印出各子项及其选项、
     * 杯贴**按子项一杯一张**（见 labelLinesWithIndex）。
     */
    comboId?: string | null;
    comboSelections?: any;
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
      /*
        全单总标签数。**只数真商品** —— 耗材（餐具/购物袋/打包费）以
        `lineKind='SUPPLY'` 存在同一张 order_items 里，不排除的话
        每个购物袋会各出一张标签，「第 X / 共 Y 杯」的分母也被撑大。

        `itemIndex` 仍然是**原数组的下标**：payload 里只带下标，
        客户端拿 `orderData.orderItems[itemIndex]` 取回那一行。
        改成过滤后的下标会取到错误的商品。
      */
      const labelIdx = labelLinesWithIndex(order.orderItems);
      // 用单位自己的 quantity，不是行的 —— 套餐行的 quantity 是「几份套餐」，
      // 一份里有几杯要看子项（见 labelLinesWithIndex）
      const totalLabels = labelIdx.reduce((sum, u) => sum + u.quantity, 0);
      let globalSeq = 0;

      for (const { index: i, comboChildIndex, quantity: unitQty } of labelIdx) {
        for (let q = 0; q < unitQty; q++) {
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
              // 套餐子项才有。客户端摊开 orderItems[i] 后按它取那一个子项
              ...(comboChildIndex != null ? { comboChildIndex } : {}),
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
      /*
        耗材不参与路由 —— 厨房不做打包费。
        （客户端渲染时也会再滤一次，两边都做是因为**任一端漏掉都会印出来**，
        而这一端滤掉还能少生成任务。）
      */
      /*
        拆分方式来自这张票的 config（Portal 上配的）。**拿不到就按 ORDER** ——
        那是升级前的行为；猜错顶多少拆几张，猜成 ITEM 则凭空多出一叠纸。
        POS 本机那条路用同一个默认值（见 printSettingService.getKitchenSplitMode）。
      */
      const splitMode: KitchenSplitMode =
        (setting.config as any)?.splitMode === 'ITEM' ? 'ITEM' : 'ORDER';

      /*
        ponytail: 套餐整份按**套餐自己的** categoryId 路由，子项不各自分站。
        一份「饮品 + 热食」套餐会整份进同一个站（子项在票面上都印出来了，
        客户端会摊开渲染，所以不会漏做，但可能印在错误的站）。
        升级路径：子项落成真正的子行（OrderItem.parentItemId 自关联），
        那样这里和 POS 的 localPrintTasks 都一个字不用改 —— 但要动钱和退款，
        见 schema-order.prisma 里 comboSelections 那段。
      */
      const groups = splitByItem(
        splitByStation(
          order.orderItems.filter((it) => !isSupplyLine(it)),
          routing?.stations || [],
          routing?.rules || [],
        ),
        splitMode,
      );
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
            // POS 端靠它把去重键按行区分（见 comboKeyOf）——
            // 不标的话每站 N 张单只有第一张能进队列
            ...(splitMode === 'ITEM' ? { perItem: true } : {}),
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
