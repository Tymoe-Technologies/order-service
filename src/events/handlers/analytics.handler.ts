/**
 * 分析数据 Handler
 * 订单创建后，异步创建 OrderAnalytics 和 OrderItemModifier 记录
 *
 * 幂等性：检查 OrderAnalytics 是否已存在该 orderId
 */

import type { IEventBus } from '../event-bus';
import type {
  OrderCreatedEvent,
  OrderCreatedFromSnapshotEvent,
  TemporaryOrderCreatedEvent,
} from '../types';
import prisma from '../../utils/prisma';
import logger from '../../utils/logger';
import organizationService from '../../services/organization.service';
import weatherService from '../../services/weather.service';
import geoService from '../../services/geo.service';
import { computeTimeDimensions } from '../../utils/time-dimensions';

// 检查幂等性
async function alreadyProcessed(orderId: string): Promise<boolean> {
  const existing = await prisma.orderAnalytics.findFirst({ where: { orderId } });
  return !!existing;
}

// 创建 OrderAnalytics 记录（系统维度：天气 + 本地时区时间）
// 任何外部依赖（组织/天气）失败都降级，不影响分析行的创建
async function createAnalytics(
  orderId: string,
  tenantId: string,
  createdAt: Date
): Promise<void> {
  // 1. 取门店坐标：优先 org 自带经纬度，缺失则按地址地理编码（均带缓存）
  let coords: { lat: number; lng: number } | null = null;
  try {
    const org = await organizationService.getOrganization(tenantId);
    if (org) {
      coords = await geoService.resolveCoordinates({
        latitude: org.latitude,
        longitude: org.longitude,
        city: org.city,
        province: org.province,
        country: org.country,
        location: org.location,
      });
    }
  } catch (err: any) {
    logger.warn('[AnalyticsHandler] 解析门店坐标失败，跳过天气', {
      tenantId,
      error: err.message,
    });
  }

  // 2. 取天气快照（含门店 IANA 时区，复用于时间维度）；失败为 null
  const weather = coords
    ? await weatherService.getWeather(coords.lat, coords.lng)
    : null;

  // 3. 按门店本地时区拆解时间维度（拿不到时区则回退 UTC）
  const t = computeTimeDimensions(createdAt, weather?.timezone);

  await prisma.orderAnalytics.create({
    data: {
      orderId,
      tenantId,
      // 时间维度
      localTime: t.localTime,
      timezone: t.timezone,
      year: t.year,
      month: t.month,
      day: t.day,
      dayOfWeek: t.dayOfWeek,
      hour: t.hour,
      weekOfYear: t.weekOfYear,
      isWeekend: t.isWeekend,
      dayPart: t.dayPart,
      // 天气维度（无则全部留空）
      weatherCondition: weather?.condition,
      weatherTemp: weather?.temp ?? undefined,
      weatherFeelsLike: weather?.feelsLike ?? undefined,
      weatherHumidity: weather?.humidity ?? undefined,
      weatherPrecipMm: weather?.precipMm ?? undefined,
      weatherWindKph: weather?.windKph ?? undefined,
      weatherCloudPct: weather?.cloudPct ?? undefined,
      isRaining: weather?.isRaining ?? undefined,
      weatherSource: weather?.source,
      weatherFetchedAt: weather?.fetchedAt,
      weatherRaw: weather?.raw ?? undefined,
    },
  });
}

// 从 POS/KIOSK 原始 items 创建 modifier 记录
async function createModifiersFromItems(
  orderItems: Array<{ id: string }>,
  items: any[]
): Promise<void> {
  const records: any[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const orderItem = orderItems[i];
    if (item.modifiers && item.modifiers.length > 0) {
      for (const mod of item.modifiers) {
        records.push({
          orderItemId: orderItem.id,
          modifierGroupId: mod.groupId,
          modifierOptionId: mod.optionId,
          groupName: mod.groupName || '',
          optionName: mod.optionName,
          unitPrice: Math.round(mod.unitPrice),
          quantity: mod.quantity,
        });
      }
    }
  }
  if (records.length > 0) {
    await prisma.orderItemModifier.createMany({ data: records });
  }
}

// 从快照的 verifiedModifiers 创建 modifier 记录
async function createModifiersFromSnapshot(
  orderItems: Array<{ id: string }>,
  snapshotItems: any[]
): Promise<void> {
  const records: any[] = [];
  for (let i = 0; i < snapshotItems.length; i++) {
    const item = snapshotItems[i];
    const orderItem = orderItems[i];
    const verifiedMods = item.verifiedModifiers;
    if (verifiedMods && Array.isArray(verifiedMods)) {
      for (const mod of verifiedMods) {
        records.push({
          orderItemId: orderItem.id,
          modifierGroupId: mod.groupId,
          modifierOptionId: mod.optionId,
          groupName: mod.groupName || '',
          optionName: mod.optionName || '',
          optionCode: mod.optionCode || mod.code || undefined,
          unitPrice: Math.round(mod.unitPrice || 0),
          quantity: mod.quantity || 1,
        });
      }
    }
  }
  if (records.length > 0) {
    await prisma.orderItemModifier.createMany({ data: records });
  }
}

export function registerAnalyticsHandler(bus: IEventBus): void {
  // POS/KIOSK 订单创建
  bus.on('ORDER_CREATED', async function analytics_ORDER_CREATED(event) {
    const e = event as OrderCreatedEvent;
    if (await alreadyProcessed(e.orderId)) return;

    await createModifiersFromItems(e.order.orderItems, e.items);
    await createAnalytics(e.orderId, e.tenantId, e.order.createdAt);
    logger.info('[AnalyticsHandler] 分析数据已创建 (ORDER_CREATED)', { orderId: e.orderId });
  });

  // 从快照创建订单（Webhook 路径）
  bus.on('ORDER_CREATED_FROM_SNAPSHOT', async function analytics_ORDER_CREATED_FROM_SNAPSHOT(event) {
    const e = event as OrderCreatedFromSnapshotEvent;
    if (await alreadyProcessed(e.orderId)) return;

    await createModifiersFromSnapshot(e.order.orderItems, e.snapshotItems);
    await createAnalytics(e.orderId, e.tenantId, e.order.createdAt);
    logger.info('[AnalyticsHandler] 分析数据已创建 (FROM_SNAPSHOT)', { orderId: e.orderId });
  });

  // 临时订单创建（skipModifiers 时只创建 analytics）
  bus.on('TEMPORARY_ORDER_CREATED', async function analytics_TEMPORARY_ORDER_CREATED(event) {
    const e = event as TemporaryOrderCreatedEvent;
    if (await alreadyProcessed(e.orderId)) return;

    if (!e.skipModifiers) {
      await createModifiersFromSnapshot(e.order.orderItems, e.snapshotItems);
    }
    await createAnalytics(e.orderId, e.tenantId, e.order.createdAt);
    logger.info('[AnalyticsHandler] 分析数据已创建 (TEMPORARY)', { orderId: e.orderId });
  });
}
