/**
 * 门店履约方式配置
 *
 * 「这单东西怎么交到顾客手上」：堂食、外带、配送、路边取餐、车道取餐。
 * 商家按门店逐个启用，顾客端只显示启用了的。
 *
 * 为什么不是 MerchantOnlineOrderConfig 上的布尔列：那套结构每加一种方式就要
 * 加一列，还要连带改 validator / DTO / 各端类型。这里一种方式一行，
 * 加 CURBSIDE 只是插一行数据。旧的三个 allow_* 列还在，本服务负责双写，
 * 等调用方全部切过来再删。
 */
import { PrismaClient, OrderType } from '.prisma/client-order';
import logger from '../utils/logger';

const prisma = new PrismaClient();

/**
 * 真正的履约方式。GIFT_CARD 虽然在 OrderType 里，但它是「订单性质」不是
 * 「怎么交付」，不该出现在门店配置界面上。
 */
export const FULFILLMENT_TYPES = [
  OrderType.DINE_IN,
  OrderType.TAKEOUT,
  OrderType.DELIVERY,
  OrderType.CURBSIDE,
  OrderType.DRIVE_THRU,
] as const;

export type FulfillmentType = (typeof FULFILLMENT_TYPES)[number];

export function isFulfillmentType(v: string): v is FulfillmentType {
  return (FULFILLMENT_TYPES as readonly string[]).includes(v);
}

/**
 * 没配过的门店按什么默认值渲染。
 *
 * 三种老方式默认开：它们本来就是 MerchantOnlineOrderConfig 的默认 true，
 * 突然关掉等于让现有商家的顾客端少几个选项。
 * 两种新方式默认关：商家没主动开就不该出现——路边取餐要有人跑出去送，
 * 默认打开会让不具备条件的门店收到没法履约的订单。
 */
const DEFAULT_ENABLED: Record<FulfillmentType, boolean> = {
  [OrderType.DINE_IN]: true,
  [OrderType.TAKEOUT]: true,
  [OrderType.DELIVERY]: true,
  [OrderType.CURBSIDE]: false,
  [OrderType.DRIVE_THRU]: false,
};

const DEFAULT_ORDER: Record<FulfillmentType, number> = {
  [OrderType.TAKEOUT]: 0,
  [OrderType.DINE_IN]: 1,
  [OrderType.DELIVERY]: 2,
  [OrderType.CURBSIDE]: 3,
  [OrderType.DRIVE_THRU]: 4,
};

export interface FulfillmentOptionDto {
  fulfillmentType: FulfillmentType;
  enabled: boolean;
  displayOrder: number;
  config: Record<string, any> | null;
}

/**
 * 列出一个门店的全部履约方式（含未配置过的，按默认值补齐）。
 *
 * 补齐而不是只返回已有行：Portal 的配置界面要能看到全部五种才能开启新的，
 * 顾客端也要一份完整清单才知道「没配 = 用默认」还是「配了 = 关闭」。
 */
export async function listOptions(merchantId: string): Promise<FulfillmentOptionDto[]> {
  const rows = await prisma.merchantFulfillmentOption.findMany({
    where: { merchantId },
  });
  const byType = new Map(rows.map(r => [r.fulfillmentType as FulfillmentType, r]));

  return FULFILLMENT_TYPES
    .map(type => {
      const row = byType.get(type);
      return {
        fulfillmentType: type,
        enabled: row ? row.enabled : DEFAULT_ENABLED[type],
        displayOrder: row ? row.displayOrder : DEFAULT_ORDER[type],
        config: (row?.config as Record<string, any>) ?? null,
      };
    })
    .sort((a, b) => a.displayOrder - b.displayOrder);
}

/** 顾客端用：只要启用了的，按展示顺序 */
export async function listEnabledTypes(merchantId: string): Promise<FulfillmentType[]> {
  const all = await listOptions(merchantId);
  return all.filter(o => o.enabled).map(o => o.fulfillmentType);
}

/**
 * POS 下单默认用哪种履约方式。
 *
 * 背景：POS 结账页一直硬编码 DINE_IN，所以库里的 DINE_IN 不代表真堂食 ——
 * 快餐店卖出去的外带咖啡也记成了堂食，报表里的堂食/外带比例是假的。
 *
 * 本来想按「有没有桌号」推断，但 POS 结账页压根不收集桌号（tableNumber 只在
 * 订单管理页展示），判断依据不存在。所以改成让商家配：正餐店配 DINE_IN，
 * 快餐店配 TAKEOUT，收银员不用多点一下，数据也不再是假的。
 *
 * 没配过就返回 DINE_IN —— 维持 POS 的历史行为，升级不改变任何存量门店的数据口径。
 */
export async function getPosDefaultType(merchantId: string): Promise<FulfillmentType> {
  const all = await listOptions(merchantId);
  const marked = all.find(o => o.enabled && (o.config as any)?.isPosDefault === true);
  if (marked) return marked.fulfillmentType;
  return OrderType.DINE_IN;
}

/**
 * 某个门店是否支持某种履约方式。下单时用它挡住「商家没开却硬提交」的请求。
 * GIFT_CARD 直接放行——它不受履约配置管辖。
 */
export async function isTypeAllowed(merchantId: string, type: string): Promise<boolean> {
  if (type === OrderType.GIFT_CARD) return true;
  if (!isFulfillmentType(type)) return false;
  const enabled = await listEnabledTypes(merchantId);
  return enabled.includes(type);
}

export interface UpsertOptionInput {
  fulfillmentType: string;
  enabled?: boolean;
  displayOrder?: number;
  config?: Record<string, any> | null;
}

/**
 * 批量保存（Portal 的配置界面整份提交）。
 *
 * 同时把三种老方式的开关回写 MerchantOnlineOrderConfig 的 allow_* 列 ——
 * POS 后台、旧版 API 还在读那三列，不双写会出现两处配置打架。
 * 等调用方全切过来，删掉这段和那三列。
 */
export async function saveOptions(merchantId: string, inputs: UpsertOptionInput[]): Promise<FulfillmentOptionDto[]> {
  const valid = inputs.filter(i => isFulfillmentType(i.fulfillmentType));
  if (valid.length !== inputs.length) {
    const bad = inputs.filter(i => !isFulfillmentType(i.fulfillmentType)).map(i => i.fulfillmentType);
    throw new Error(`不支持的履约方式: ${bad.join(', ')}`);
  }

  await prisma.$transaction(
    valid.map(i =>
      prisma.merchantFulfillmentOption.upsert({
        where: {
          merchantId_fulfillmentType: {
            merchantId,
            fulfillmentType: i.fulfillmentType as OrderType,
          },
        },
        create: {
          merchantId,
          fulfillmentType: i.fulfillmentType as OrderType,
          enabled: i.enabled ?? DEFAULT_ENABLED[i.fulfillmentType as FulfillmentType],
          displayOrder: i.displayOrder ?? DEFAULT_ORDER[i.fulfillmentType as FulfillmentType],
          config: i.config ?? undefined,
        },
        update: {
          ...(i.enabled !== undefined ? { enabled: i.enabled } : {}),
          ...(i.displayOrder !== undefined ? { displayOrder: i.displayOrder } : {}),
          ...(i.config !== undefined ? { config: i.config ?? undefined } : {}),
        },
      })
    )
  );

  await syncLegacyColumns(merchantId, valid);
  logger.info('履约方式配置已更新', { merchantId, count: valid.length });
  return listOptions(merchantId);
}

/** 把三种老方式的开关回写旧列，保持新旧两处一致 */
async function syncLegacyColumns(merchantId: string, inputs: UpsertOptionInput[]) {
  const legacy: Record<string, boolean> = {};
  for (const i of inputs) {
    if (i.enabled === undefined) continue;
    if (i.fulfillmentType === OrderType.TAKEOUT) legacy.allowPickup = i.enabled;
    if (i.fulfillmentType === OrderType.DINE_IN) legacy.allowDineIn = i.enabled;
    if (i.fulfillmentType === OrderType.DELIVERY) legacy.allowDelivery = i.enabled;
  }
  if (Object.keys(legacy).length === 0) return;

  // 配置行不存在就跳过：这张表的创建有自己的业务规则（要查 auth-service 拿
  // parentOrgId、分店启用前主店必须已启用），不能在这里顺手 create 一条绕过去
  const exists = await prisma.merchantOnlineOrderConfig.findUnique({
    where: { merchantId },
    select: { id: true },
  });
  if (!exists) return;

  await prisma.merchantOnlineOrderConfig.update({
    where: { merchantId },
    data: legacy,
  });
}
