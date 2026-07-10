import { PrismaClient } from '.prisma/client-order';
import organizationService from './organization.service';
import logger from '../utils/logger';

const prisma = new PrismaClient();

export interface BusinessHours {
  monday: { open: string; close: string; closed: boolean };
  tuesday: { open: string; close: string; closed: boolean };
  wednesday: { open: string; close: string; closed: boolean };
  thursday: { open: string; close: string; closed: boolean };
  friday: { open: string; close: string; closed: boolean };
  saturday: { open: string; close: string; closed: boolean };
  sunday: { open: string; close: string; closed: boolean };
}

// 商家点单配置入参；品牌身份字段 (subdomain/customDomain/themeSettings) 全部归 auth-service
export interface MerchantConfigData {
  merchantId: string;
  enabled?: boolean;
  allowPickup?: boolean;
  allowDineIn?: boolean;
  allowDelivery?: boolean;
  // businessHours 已迁移到 auth-service Organization.businessHours，本服务不再接受写入
  minOrderAmount?: number;
  deliveryFee?: number;
  deliveryRadius?: number;
  // 自取预约配置
  allowPickupSchedule?: boolean;
  pickupLeadMinutes?: number;
  pickupSlotInterval?: number;
  pickupAdvanceDays?: number;
}

// 单条点单配置 → 公开 DTO（只输出本服务负责的业务字段）
function toStoreDto(c: any) {
  return {
    storeId: c.merchantId,
    parentMerchantId: c.parentMerchantId,
    enabled: c.enabled,
    allowPickup: c.allowPickup,
    allowDineIn: c.allowDineIn,
    allowDelivery: c.allowDelivery,
    minOrderAmount: c.minOrderAmount,
    deliveryFee: c.deliveryFee,
    deliveryRadius: c.deliveryRadius ? Number(c.deliveryRadius) : null,
    allowPickupSchedule: c.allowPickupSchedule ?? true,
    pickupLeadMinutes: c.pickupLeadMinutes ?? 15,
    pickupSlotInterval: c.pickupSlotInterval ?? 30,
    pickupAdvanceDays: c.pickupAdvanceDays ?? 0,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

/**
 * 获取商家的所有门店点单配置（主店 + 所有分店）
 * 不再过滤 enabled —— 由调用方/前端按 enabled 渲染"暂不接受在线点单"
 * 入参只接受 UUID merchantId（subdomain 解析在 auth-service）
 *
 * @param mainMerchantId 主店 UUID
 * @returns 门店点单配置数组（含主店）；找不到主店或入参不是主店时返回空数组
 */
export async function getMerchantStores(mainMerchantId: string) {
  try {
    const mainStoreConfig = await prisma.merchantOnlineOrderConfig.findUnique({
      where: { merchantId: mainMerchantId },
    });

    if (!mainStoreConfig) {
      logger.warn('Main store config not found', { mainMerchantId });
      return [];
    }
    if (mainStoreConfig.parentMerchantId !== null) {
      logger.warn('getMerchantStores called with branch id, expected main store id', {
        mainMerchantId,
        actualParent: mainStoreConfig.parentMerchantId,
      });
      return [];
    }

    const branchStores = await prisma.merchantOnlineOrderConfig.findMany({
      where: { parentMerchantId: mainMerchantId },
      orderBy: { createdAt: 'asc' },
    });

    const stores = [toStoreDto(mainStoreConfig), ...branchStores.map(toStoreDto)];

    logger.info('Found stores for merchant', {
      mainMerchantId,
      totalStores: stores.length,
      mainStoreEnabled: mainStoreConfig.enabled,
      branchStoresCount: branchStores.length,
    });

    return stores;
  } catch (error) {
    logger.error('Error getting merchant stores', { mainMerchantId, error });
    throw error;
  }
}

/**
 * 根据商家 ID 获取点单配置
 */
export async function getConfigByMerchantId(merchantId: string) {
  try {
    const config = await prisma.merchantOnlineOrderConfig.findUnique({
      where: { merchantId },
    });

    if (!config) {
      return null;
    }

    return {
      id: config.id,
      merchantId: config.merchantId,
      parentMerchantId: config.parentMerchantId,
      enabled: config.enabled,
      allowPickup: config.allowPickup,
      allowDineIn: config.allowDineIn,
      allowDelivery: config.allowDelivery,
      minOrderAmount: config.minOrderAmount,
      deliveryFee: config.deliveryFee,
      deliveryRadius: config.deliveryRadius ? Number(config.deliveryRadius) : null,
      allowPickupSchedule: (config as any).allowPickupSchedule ?? true,
      pickupLeadMinutes: (config as any).pickupLeadMinutes ?? 15,
      pickupSlotInterval: (config as any).pickupSlotInterval ?? 30,
      pickupAdvanceDays: (config as any).pickupAdvanceDays ?? 0,
      createdAt: config.createdAt,
      updatedAt: config.updatedAt,
    };
  } catch (error) {
    logger.error('Error getting config by merchant ID:', error);
    throw error;
  }
}

/**
 * 创建商家点单配置
 * 主店/分店关系由 auth-service 决定：内部调 auth.resolveBySlug(merchantId) 拿 parentOrgId 自动填充
 * 业务规则：分店启用前，主店必须已启用（enabled=true）
 */
export async function createConfig(data: MerchantConfigData) {
  try {
    const existing = await prisma.merchantOnlineOrderConfig.findUnique({
      where: { merchantId: data.merchantId },
    });
    if (existing) {
      throw new Error('Merchant already has a configuration');
    }

    // 通过 auth-service 解析主店/分店关系
    const org = await organizationService.resolveBySlug(data.merchantId);
    if (!org) {
      throw new Error('Organization not found in auth-service');
    }
    const parentMerchantId = org.parentOrgId ?? null;
    const requestedEnabled = data.enabled ?? true;

    // 主店/子店 enabled 级联校验：子店要启用，主店必须先启用
    if (parentMerchantId && requestedEnabled) {
      const parentConfig = await prisma.merchantOnlineOrderConfig.findUnique({
        where: { merchantId: parentMerchantId },
      });
      if (!parentConfig || !parentConfig.enabled) {
        throw new Error('Parent merchant has not enabled online ordering');
      }
    }

    const config = await prisma.merchantOnlineOrderConfig.create({
      data: {
        merchantId: data.merchantId,
        parentMerchantId,
        enabled: requestedEnabled,
        allowPickup: data.allowPickup ?? true,
        allowDineIn: data.allowDineIn ?? true,
        allowDelivery: data.allowDelivery ?? true,
        minOrderAmount: data.minOrderAmount,
        deliveryFee: data.deliveryFee,
        deliveryRadius: data.deliveryRadius,
        allowPickupSchedule: data.allowPickupSchedule ?? true,
        pickupLeadMinutes: data.pickupLeadMinutes ?? 15,
        pickupSlotInterval: data.pickupSlotInterval ?? 30,
        pickupAdvanceDays: data.pickupAdvanceDays ?? 0,
      } as any,
    });

    logger.info('Merchant config created', { merchantId: data.merchantId, parentMerchantId });
    return config;
  } catch (error) {
    logger.error('Error creating merchant config:', error);
    throw error;
  }
}

/**
 * 更新商家点单配置（只允许修改点单业务字段）
 * 业务规则：
 *  - 子店启用前主店必须已启用
 *  - 主店从启用改为禁用：所有子店会"被动禁用"（不主动级联写库，由 onlionshop 前端按主店 enabled 渲染会员中心模式）
 */
export async function updateConfig(merchantId: string, data: Partial<MerchantConfigData>) {
  try {
    const current = await prisma.merchantOnlineOrderConfig.findUnique({
      where: { merchantId },
    });
    if (!current) {
      throw new Error('Merchant config not found');
    }

    // 级联校验：子店尝试启用时，主店必须已启用
    if (data.enabled === true && current.parentMerchantId) {
      const parentConfig = await prisma.merchantOnlineOrderConfig.findUnique({
        where: { merchantId: current.parentMerchantId },
      });
      if (!parentConfig || !parentConfig.enabled) {
        throw new Error('Parent merchant has not enabled online ordering');
      }
    }

    const updateData: any = {};
    if (data.enabled !== undefined) updateData.enabled = data.enabled;
    if (data.allowPickup !== undefined) updateData.allowPickup = data.allowPickup;
    if (data.allowDineIn !== undefined) updateData.allowDineIn = data.allowDineIn;
    if (data.allowDelivery !== undefined) updateData.allowDelivery = data.allowDelivery;
    // businessHours 已迁移到 auth-service，不再写入本服务
    if (data.minOrderAmount !== undefined) updateData.minOrderAmount = data.minOrderAmount;
    if (data.deliveryFee !== undefined) updateData.deliveryFee = data.deliveryFee;
    if (data.deliveryRadius !== undefined) updateData.deliveryRadius = data.deliveryRadius;
    if (data.allowPickupSchedule !== undefined) updateData.allowPickupSchedule = data.allowPickupSchedule;
    if (data.pickupLeadMinutes !== undefined) updateData.pickupLeadMinutes = data.pickupLeadMinutes;
    if (data.pickupSlotInterval !== undefined) updateData.pickupSlotInterval = data.pickupSlotInterval;
    if (data.pickupAdvanceDays !== undefined) updateData.pickupAdvanceDays = data.pickupAdvanceDays;

    const config = await prisma.merchantOnlineOrderConfig.update({
      where: { merchantId },
      data: updateData,
    });

    logger.info('Merchant config updated', { merchantId });
    return config;
  } catch (error) {
    logger.error('Error updating merchant config:', error);
    throw error;
  }
}

/**
 * 删除商家配置
 */
export async function deleteConfig(merchantId: string) {
  try {
    await prisma.merchantOnlineOrderConfig.delete({
      where: { merchantId },
    });

    logger.info('Merchant config deleted:', { merchantId });
  } catch (error) {
    logger.error('Error deleting merchant config:', error);
    throw error;
  }
}

/**
 * 获取所有配置列表(管理员)
 */
export async function getAllConfigs(page: number = 1, limit: number = 20) {
  try {
    const skip = (page - 1) * limit;

    const [configs, total] = await Promise.all([
      prisma.merchantOnlineOrderConfig.findMany({
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.merchantOnlineOrderConfig.count(),
    ]);

    return {
      items: configs,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  } catch (error) {
    logger.error('Error getting all configs:', error);
    throw error;
  }
}
