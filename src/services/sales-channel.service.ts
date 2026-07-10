import { Decimal } from '@prisma/client/runtime/library';
import prisma from '../utils/prisma';
import { AppError } from '../middleware/errorHandler';
import logger from '../utils/logger';

export type BillingCycle = 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY';
export type DiscountType = 'PERCENTAGE' | 'FIXED';
export type CheckoutMode = 'NORMAL' | 'CREDIT_ACCOUNT';
export type ChannelAccessMode = 'PUBLIC' | 'MEMBER_ONLY';
export type DeliveryPlatform =
  | 'UBER_EATS'
  | 'DOORDASH'
  | 'SKIP_THE_DISHES'
  | 'GRUBHUB'
  | 'RITUAL'
  | 'FANTUAN'
  | 'OTHER_PLATFORM';

export interface CreditConfig {
  billingCycle: BillingCycle;
  cycleLimit: number; // 周期限额（分，避免浮点误差）
}

export interface OrderDiscountRule {
  enabled: boolean;
  type: DiscountType;
  value: number; // PERCENTAGE: 0-100；FIXED: 金额（分）
}

export interface CheckoutRules {
  orderDiscount?: OrderDiscountRule;
}

interface CreateSalesChannelRequest {
  channelCode: string;
  channelName: string;
  description?: string;
  isActive?: boolean;
  displayOrder?: number;
  accessMode?: ChannelAccessMode;
  checkoutMode?: CheckoutMode;
  creditConfig?: CreditConfig;
  checkoutRules?: CheckoutRules;
  commissionRate?: number; // 0.00~1.00
  platformType?: DeliveryPlatform;
}

interface UpdateSalesChannelRequest {
  channelName?: string;
  description?: string;
  isActive?: boolean;
  displayOrder?: number;
  accessMode?: ChannelAccessMode;
  checkoutMode?: CheckoutMode;
  creditConfig?: CreditConfig | null;
  checkoutRules?: CheckoutRules | null;
  commissionRate?: number | null;
}

// 系统预设外卖平台渠道定义
const SYSTEM_DELIVERY_CHANNELS = [
  {
    channelCode: 'UBER_EATS',
    channelName: 'Uber Eats',
    description: 'Uber Eats 外卖平台手动录单',
    platformType: 'UBER_EATS' as DeliveryPlatform,
    displayOrder: 10,
  },
  {
    channelCode: 'DOORDASH',
    channelName: 'DoorDash',
    description: 'DoorDash 外卖平台手动录单',
    platformType: 'DOORDASH' as DeliveryPlatform,
    displayOrder: 11,
  },
  {
    channelCode: 'SKIP_THE_DISHES',
    channelName: 'Skip The Dishes',
    description: 'Skip The Dishes 外卖平台手动录单',
    platformType: 'SKIP_THE_DISHES' as DeliveryPlatform,
    displayOrder: 12,
  },
  {
    channelCode: 'GRUBHUB',
    channelName: 'Grubhub',
    description: 'Grubhub 外卖平台手动录单',
    platformType: 'GRUBHUB' as DeliveryPlatform,
    displayOrder: 13,
  },
  {
    channelCode: 'RITUAL',
    channelName: 'Ritual',
    description: 'Ritual 外卖平台手动录单',
    platformType: 'RITUAL' as DeliveryPlatform,
    displayOrder: 14,
  },
  {
    channelCode: 'FANTUAN',
    channelName: '饭团',
    description: '饭团外卖平台手动录单',
    platformType: 'FANTUAN' as DeliveryPlatform,
    displayOrder: 15,
  },
];

export class SalesChannelService {
  async getSalesChannels(tenantId: string, isActive?: boolean) {
    const where: any = { tenantId };
    if (isActive !== undefined) where.isActive = isActive;

    return prisma.orderSourceConfig.findMany({
      where,
      orderBy: [{ displayOrder: 'asc' }, { createdAt: 'desc' }],
    });
  }

  async getSalesChannelById(channelId: string, tenantId: string) {
    const channel = await prisma.orderSourceConfig.findFirst({
      where: { id: channelId, tenantId },
    });

    if (!channel) {
      throw new AppError(404, 'CHANNEL_NOT_FOUND', '销售渠道不存在');
    }

    return channel;
  }

  async createSalesChannel(data: CreateSalesChannelRequest, tenantId: string) {
    const existing = await prisma.orderSourceConfig.findFirst({
      where: { tenantId, sourceType: data.channelCode },
    });

    if (existing) {
      throw new AppError(400, 'CHANNEL_CODE_EXISTS', `销售渠道 ${data.channelCode} 已存在`);
    }

    if (data.checkoutMode === 'CREDIT_ACCOUNT' && !data.creditConfig) {
      throw new AppError(400, 'CREDIT_CONFIG_REQUIRED', '记账模式必须提供记账配置');
    }

    if (data.commissionRate !== undefined) {
      if (data.commissionRate < 0 || data.commissionRate > 1) {
        throw new AppError(400, 'INVALID_COMMISSION_RATE', '佣金率必须在 0.00~1.00 之间');
      }
    }

    const lastChannel = await prisma.orderSourceConfig.findFirst({
      where: { tenantId },
      orderBy: { displayOrder: 'desc' },
    });
    const displayOrder = data.displayOrder ?? ((lastChannel?.displayOrder ?? 0) + 1);

    const channel = await prisma.orderSourceConfig.create({
      data: {
        tenantId,
        sourceType: data.channelCode.toUpperCase(),
        sourceName: data.channelName,
        description: data.description || null,
        isActive: data.isActive !== false,
        displayOrder,
        accessMode: data.accessMode ?? 'PUBLIC',
        checkoutMode: data.checkoutMode ?? 'NORMAL',
        creditConfig: (data.creditConfig ?? undefined) as any,
        checkoutRules: (data.checkoutRules ?? undefined) as any,
        commissionRate: data.commissionRate != null ? new Decimal(data.commissionRate) : null,
        platformType: data.platformType ?? null,
      },
    });

    logger.info(`Sales channel created: ${channel.id}`, {
      channelId: channel.id,
      channelCode: channel.sourceType,
      tenantId,
    });

    return channel;
  }

  async updateSalesChannel(
    channelId: string,
    data: UpdateSalesChannelRequest,
    tenantId: string
  ) {
    const channel = await this.getSalesChannelById(channelId, tenantId);

    // 系统渠道只允许更新配置项，不允许改名/排序（保持系统一致性）
    const targetMode = data.checkoutMode ?? (channel as any).checkoutMode;
    if (targetMode === 'CREDIT_ACCOUNT') {
      const hasCreditConfig =
        data.creditConfig !== undefined
          ? data.creditConfig !== null
          : (channel as any).creditConfig !== null;
      if (!hasCreditConfig) {
        throw new AppError(400, 'CREDIT_CONFIG_REQUIRED', '记账模式必须提供记账配置');
      }
    }

    if (data.commissionRate !== undefined && data.commissionRate !== null) {
      if (data.commissionRate < 0 || data.commissionRate > 1) {
        throw new AppError(400, 'INVALID_COMMISSION_RATE', '佣金率必须在 0.00~1.00 之间');
      }
    }

    const updateData: any = {};
    // 系统渠道不允许改 sourceName / displayOrder
    if (!channel.isSystemChannel) {
      if (data.channelName !== undefined) updateData.sourceName = data.channelName;
      if (data.displayOrder !== undefined) updateData.displayOrder = data.displayOrder;
    }
    if (data.description !== undefined) updateData.description = data.description;
    if (data.isActive !== undefined) updateData.isActive = data.isActive;
    if (data.accessMode !== undefined) updateData.accessMode = data.accessMode;
    if (data.checkoutMode !== undefined) updateData.checkoutMode = data.checkoutMode;
    if (data.creditConfig !== undefined) updateData.creditConfig = data.creditConfig;
    if (data.checkoutRules !== undefined) updateData.checkoutRules = data.checkoutRules;
    if (data.commissionRate !== undefined) {
      updateData.commissionRate = data.commissionRate != null
        ? new Decimal(data.commissionRate)
        : null;
    }

    const updated = await prisma.orderSourceConfig.update({
      where: { id: channelId },
      data: updateData,
    });

    logger.info(`Sales channel updated: ${channelId}`, { tenantId });

    return updated;
  }

  async deleteSalesChannel(channelId: string, tenantId: string) {
    const channel = await this.getSalesChannelById(channelId, tenantId);

    if (channel.isSystemChannel) {
      throw new AppError(400, 'CANNOT_DELETE_SYSTEM_CHANNEL', '无法删除系统预设的销售渠道');
    }

    await prisma.orderSourceConfig.delete({ where: { id: channelId } });

    logger.info(`Sales channel deleted: ${channelId}`, { tenantId });
  }

  /**
   * 初始化商家默认销售渠道（pos、online、delivery、kiosk）
   */
  async initializeDefaultChannels(tenantId: string) {
    const defaultChannels = [
      { channelCode: 'POS', channelName: '门店POS', description: '在POS机上下单', displayOrder: 1 },
      { channelCode: 'ONLINE', channelName: '在线订单', description: '通过在线渠道下单', displayOrder: 2 },
      { channelCode: 'DELIVERY', channelName: '外卖配送', description: '外卖配送订单', displayOrder: 3 },
      { channelCode: 'SELF_SERVICE', channelName: '自助点餐', description: '自助终端点餐', displayOrder: 4 },
    ];

    const created = [];

    // 创建商家基础销售渠道
    for (const ch of defaultChannels) {
      try {
        const existing = await prisma.orderSourceConfig.findFirst({
          where: { tenantId, sourceType: ch.channelCode },
        });
        if (!existing) {
          const newChannel = await prisma.orderSourceConfig.create({
            data: {
              tenantId,
              sourceType: ch.channelCode,
              sourceName: ch.channelName,
              description: ch.description,
              displayOrder: ch.displayOrder,
              isActive: true,
              isSystemChannel: false,
              accessMode: 'PUBLIC',
              checkoutMode: 'NORMAL',
            },
          });
          created.push(newChannel);
        }
      } catch (error) {
        logger.warn(`Failed to create default sales channel ${ch.channelCode}:`, error);
      }
    }

    // 创建系统预设外卖平台渠道（默认关闭，商家按需启用）
    for (const platform of SYSTEM_DELIVERY_CHANNELS) {
      try {
        const existing = await prisma.orderSourceConfig.findFirst({
          where: { tenantId, sourceType: platform.channelCode },
        });
        if (!existing) {
          const newChannel = await prisma.orderSourceConfig.create({
            data: {
              tenantId,
              sourceType: platform.channelCode,
              sourceName: platform.channelName,
              description: platform.description,
              displayOrder: platform.displayOrder,
              isActive: false, // 默认关闭，商家主动启用并配置佣金率
              isSystemChannel: true,
              platformType: platform.platformType,
              accessMode: 'PUBLIC',
              checkoutMode: 'NORMAL',
            },
          });
          created.push(newChannel);
        }
      } catch (error) {
        logger.warn(`Failed to create system delivery channel ${platform.channelCode}:`, error);
      }
    }

    logger.info(`Initialized sales channels for tenant: ${tenantId}`, {
      created: created.length,
    });

    return created;
  }

  // ── 渠道成员管理 ──────────────────────────────────────────────────────

  async getChannelMembers(channelId: string, tenantId: string) {
    return prisma.channelMember.findMany({
      where: { channelId, tenantId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async addChannelMember(channelId: string, tenantId: string, data: {
    phone: string;
    name?: string;
    note?: string;
  }) {
    const channel = await prisma.orderSourceConfig.findFirst({ where: { id: channelId, tenantId } });
    if (!channel) throw new Error('销售渠道不存在');

    return prisma.channelMember.upsert({
      where: { channelId_phone: { channelId, phone: data.phone } },
      create: { tenantId, channelId, phone: data.phone, name: data.name, note: data.note },
      update: { name: data.name, note: data.note, isActive: true },
    });
  }

  async batchAddChannelMembers(channelId: string, tenantId: string, members: { phone: string; name?: string; note?: string }[]) {
    const channel = await prisma.orderSourceConfig.findFirst({ where: { id: channelId, tenantId } });
    if (!channel) throw new Error('销售渠道不存在');

    const results = await Promise.allSettled(
      members.map(m => prisma.channelMember.upsert({
        where: { channelId_phone: { channelId, phone: m.phone } },
        create: { tenantId, channelId, phone: m.phone, name: m.name, note: m.note },
        update: { name: m.name, note: m.note, isActive: true },
      }))
    );

    const succeeded = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;
    return { succeeded, failed, total: members.length };
  }

  async updateChannelMember(memberId: string, tenantId: string, data: {
    name?: string;
    note?: string;
    isActive?: boolean;
  }) {
    return prisma.channelMember.update({
      where: { id: memberId, tenantId },
      data,
    });
  }

  async removeChannelMember(memberId: string, tenantId: string) {
    return prisma.channelMember.delete({ where: { id: memberId, tenantId } });
  }

  /** POS 录单时按手机号查询该租户下哪个销售渠道包含此号码 */
  async lookupChannelByPhone(tenantId: string, phone: string) {
    // 规范化：去除所有非数字字符后取最后10位，兼容 +16471234567 / 6471234567 两种格式
    const digits = phone.replace(/\D/g, '');
    const normalized = digits.slice(-10);
    const member = await prisma.channelMember.findFirst({
      where: {
        tenantId,
        isActive: true,
        OR: [
          { phone },
          { phone: digits },
          { phone: normalized },
        ],
      },
      include: {
        channel: {
          select: {
            id: true, sourceType: true, sourceName: true, checkoutMode: true,
            checkoutRules: true, creditConfig: true, accessMode: true,
          },
        },
      },
    });
    return member ?? null;
  }
}

export default new SalesChannelService();
