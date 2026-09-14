import prisma from '../utils/prisma';
import { AppError } from '../middleware/errorHandler';
import logger from '../utils/logger';
import organizationService from './organization.service';
import { mergeConfig, pickOverrides } from './print-setting-scope';

/**
 * 深度合并默认值：用默认配置补充现有配置中缺失的字段
 * 不覆盖用户已自定义的值，只填充缺失的 key
 */
function deepMergeDefaults(defaults: Record<string, any>, existing: Record<string, any>): Record<string, any> {
  const result = { ...existing };
  for (const key of Object.keys(defaults)) {
    if (result[key] === undefined) {
      // 现有配置中没有此字段，使用默认值
      result[key] = defaults[key];
    } else if (
      typeof defaults[key] === 'object' && defaults[key] !== null && !Array.isArray(defaults[key]) &&
      typeof result[key] === 'object' && result[key] !== null && !Array.isArray(result[key])
    ) {
      // 两边都是对象，递归合并
      result[key] = deepMergeDefaults(defaults[key], result[key]);
    }
    // 其他情况（用户已设置了值），保留用户的值
  }
  return result;
}

/*
  票据类型枚举。

  **DAILY_REPORT / SHIFT_REPORT 已下线**（2026-09-09）：它们的 config
  （showTopItems、topItemsCount 之类）**从来没有任何读取方** ——
  POS 的 `printSalesReport` 是固定版式，读的是 CUSTOMER_RECEIPT 的店铺信息、
  打到收据打印机上。所以后台那两页配置是配了不生效。

  Prisma 的 TicketType 枚举里仍然保留这两个值：`print_records.printType`
  用的是同一套枚举，而且存量租户已经有这两行（都是 disabled）。
  这里只是不再为新租户生成、也不再对外声明它们可配。
*/
type TicketType = 'CUSTOMER_RECEIPT' | 'KITCHEN_TICKET' | 'ITEM_LABEL';

// 票据类型元信息。initialize 和 /print-settings/meta 都由它驱动
const TICKET_TYPE_META: Record<TicketType, { name: string; protocol: string; defaultCopies: number; defaultEnabled: boolean }> = {
  CUSTOMER_RECEIPT: { name: '客户收据', protocol: 'ESCPOS', defaultCopies: 1, defaultEnabled: true },
  KITCHEN_TICKET: { name: '厨房菜品单', protocol: 'ESCPOS', defaultCopies: 1, defaultEnabled: false },
  ITEM_LABEL: { name: '标签贴纸', protocol: 'TSPL', defaultCopies: 1, defaultEnabled: false },
};

// 各票据类型的默认配置
function getDefaultConfig(ticketType: TicketType): object {
  switch (ticketType) {
    case 'CUSTOMER_RECEIPT':
      return {
        paperWidth: 80,
        language: 'zh-CN',
        sections: {
          storeInfo: { showName: true, showAddress: true, showPhone: true, showLogo: false, name: '', address: '', phone: '', logoUrl: '' },
          orderInfo: { showOrderNumber: true, showOrderType: true, showTableNumber: true, showTime: true, showCustomerName: false, showCustomerPhone: false, showCashier: false },
          items: { showAttributes: true, showModifiers: true, showItemNotes: true, showUnitPrice: true },
          amounts: { showSubtotal: true, showDiscount: true, showTax: true, showServiceFee: false, showDeliveryFee: false, showTip: false },
          payment: { showPaymentMethod: true, showPaymentTime: true, showTransactionId: false, showCashDetail: true },
          footer: { showQrCode: false, qrCodeUrl: '', customMessage: { 'zh-CN': '感谢惠顾', 'en': 'Thank you!', 'zh-TW': '感謝惠顧' }, showOrderNotes: true },
        },
      };

    case 'KITCHEN_TICKET':
      return {
        paperWidth: 80,
        language: 'zh-CN',
        sections: {
          header: { showOrderNumber: true, showOrderType: true, showTableNumber: true, showTime: true, showCustomerName: false },
          items: { showAttributes: true, showModifiers: true, showItemNotes: true, fontSize: 'large' },
          footer: { showOrderNotes: true },
        },
      };

    case 'ITEM_LABEL':
      return {
        // 纸张规格
        labelWidth: 40,          // mm，常见: 40/50/60
        labelHeight: 30,         // mm，常见: 30/40
        labelGap: 2,             // mm，标签间距
        language: 'zh-CN',

        // 内容显示开关
        sections: {
          showItemName: true,         // 商品名称（核心字段，建议始终开启）
          showAttributes: true,       // 商品属性（如"大杯"、"冷"）
          showModifiers: true,        // 修饰项（如"少糖"、"去冰"）
          showSpecialNotes: true,     // 特殊备注（itemSpecialNotes）
          showCupIndex: true,         // 第几杯 "1/3"（多杯时有用）
          showOrderNumber: true,      // 订单号
          showCustomerName: false,    // 顾客姓名
          showTableNumber: false,     // 桌号
          showTimestamp: false,       // 时间戳
          showQrCode: false,          // 二维码
        },

        // 样式配置
        style: {
          itemNameFontSize: 'large',   // small | medium | large
          modifierFontSize: 'small',
          bold: true,
          printDensity: 'normal',      // light | normal | dark（TSPL density 参数）
        },
      };

  }
}

export class PrintSettingService {
  /**
   * 获取所有打印设置
   */
  async getAllSettings(tenantId: string) {
    const settings = await prisma.printSetting.findMany({
      where: { tenantId },
      orderBy: { ticketType: 'asc' },
    });

    // 如果没有设置，返回空数组（需要先调用 initialize）
    return settings;
  }

  /**
   * 获取某种票据类型的设置 —— **返回的是品牌模板 + 本店覆盖的合并结果**。
   *
   * 票据样式由品牌规定（主店那条记录），分店只能改几项和设备/本地相关的
   * （语言、纸宽、页脚文案、店名地址电话，见 print-setting-scope）。
   * 主店自己调用时 main === tenantId，走的还是原来那条路。
   */
  async getSettingByType(tenantId: string, ticketType: string) {
    const mainOrgId = await organizationService.resolveMainOrgId(tenantId);
    const brand = await prisma.printSetting.findUnique({
      where: { tenantId_ticketType: { tenantId: mainOrgId, ticketType: ticketType as any } },
    });

    // 主店自己：它那条就是品牌模板
    if (mainOrgId === tenantId) {
      if (!brand) {
        throw new AppError(404, 'PRINT_SETTING_NOT_FOUND', `未找到 ${ticketType} 的打印设置，请先初始化`);
      }
      return brand;
    }

    const store = await prisma.printSetting.findUnique({
      where: { tenantId_ticketType: { tenantId, ticketType: ticketType as any } },
    });

    /*
      品牌没配过（老数据 / 还没初始化）就退回门店自己那条 ——
      分层是新加的，不能让已经在用的分店突然没设置可用。
    */
    if (!brand) {
      if (!store) {
        throw new AppError(404, 'PRINT_SETTING_NOT_FOUND', `未找到 ${ticketType} 的打印设置，请先初始化`);
      }
      return store;
    }

    return {
      ...brand,
      // 这两项按门店：没有标签机的店必须能关掉标签
      isEnabled: store?.isEnabled ?? brand.isEnabled,
      copies: store?.copies ?? brand.copies,
      config: mergeConfig(brand.config, store?.config),
    };
  }

  /**
   * 更新打印设置
   */
  async updateSetting(tenantId: string, ticketType: string, data: { isEnabled?: boolean; copies?: number; config?: object }, token?: string) {
    /*
      分店提交的 config 只取它有权改的那几项。

      后台 UI 现在发的是**整份** config（它还没分层），不过滤的话分店一保存
      就把品牌那套样式原样抄成自己的覆盖项，分层等于没有。
      过滤放在服务端，UI 改不改都不影响正确性。
    */
    const mainOrgId = await organizationService.resolveMainOrgId(tenantId);
    const isBranch = mainOrgId !== tenantId;
    if (isBranch && data.config !== undefined) {
      data = { ...data, config: pickOverrides(data.config) ?? undefined };
    }

    // 先检查是否存在
    let existing = await prisma.printSetting.findUnique({
      where: {
        tenantId_ticketType: { tenantId, ticketType: ticketType as any },
      },
    });

    /*
      分店第一次改：它可能根本没有自己那条记录（设置一直是从品牌继承的）。
      现建一条空的来装覆盖项，而不是报 404 让人去「初始化」——
      那会建出一份全量副本，正是分层要避免的。
    */
    if (!existing && isBranch) {
      // upsert 而不是 create：同一家分店两台机同时保存时不会撞唯一键
      existing = await prisma.printSetting.upsert({
        where: { tenantId_ticketType: { tenantId, ticketType: ticketType as any } },
        // as any：ticketType 在这个方法里是 string，而 Prisma 要枚举
        create: { tenantId, ticketType, isEnabled: true, config: {} } as any,
        update: {},
      });
    }

    if (!existing) {
      throw new AppError(404, 'PRINT_SETTING_NOT_FOUND', `未找到 ${ticketType} 的打印设置，请先初始化`);
    }

    const updateData: any = {
      version: existing.version + 1,
    };

    if (data.isEnabled !== undefined) updateData.isEnabled = data.isEnabled;
    if (data.copies !== undefined) updateData.copies = data.copies;

    // 如果更新 config 且是客户收据，自动从 Auth Service 获取店铺信息并填充
    if (data.config !== undefined) {
      let finalConfig = data.config as any;

      if (ticketType === 'CUSTOMER_RECEIPT' && finalConfig.sections?.storeInfo) {
        try {
          // 从 Auth Service 获取组织信息（使用用户的 JWT token）
          const orgInfo = await organizationService.getOrganization(tenantId, token);

          if (orgInfo) {
            // 填充店铺信息到 config 中（保留前端传递的 logoUrl 和显示开关）
            finalConfig.sections.storeInfo = {
              ...finalConfig.sections.storeInfo,
              name: orgInfo.orgName || '',
              address: orgInfo.location || '',
              phone: orgInfo.phone || '',
            };

            logger.info('已自动填充店铺信息到打印设置', {
              tenantId,
              orgName: orgInfo.orgName,
            });
          } else {
            logger.warn('无法获取组织信息，跳过自动填充', { tenantId });
          }
        } catch (error: any) {
          logger.error('获取组织信息失败，使用用户提供的配置', {
            tenantId,
            error: error.message,
          });
          // 如果获取失败，不影响保存，使用用户提供的配置
        }
      }

      updateData.config = finalConfig;
    }

    const updated = await prisma.printSetting.update({
      where: {
        tenantId_ticketType: { tenantId, ticketType: ticketType as any },
      },
      data: updateData,
    });

    logger.info('打印设置已更新', {
      tenantId,
      ticketType,
      version: updated.version,
    });

    return updated;
  }

  /**
   * 更新 CUSTOMER_RECEIPT 的 logoUrl（Logo 上传后调用）
   */
  async updateLogoUrl(tenantId: string, logoUrl: string) {
    const existing = await prisma.printSetting.findUnique({
      where: {
        tenantId_ticketType: { tenantId, ticketType: 'CUSTOMER_RECEIPT' },
      },
    });

    if (!existing) {
      logger.warn('CUSTOMER_RECEIPT 打印设置不存在，跳过 logoUrl 同步', { tenantId });
      return;
    }

    const config = (existing.config as any) || {};
    if (!config.sections) config.sections = {};
    if (!config.sections.storeInfo) config.sections.storeInfo = {};
    config.sections.storeInfo.logoUrl = logoUrl;

    await prisma.printSetting.update({
      where: {
        tenantId_ticketType: { tenantId, ticketType: 'CUSTOMER_RECEIPT' },
      },
      data: {
        config,
        version: existing.version + 1,
      },
    });

    logger.info('CUSTOMER_RECEIPT logoUrl 已更新', { tenantId, logoUrl });
  }

  /**
   * 启用/禁用票据类型
   */
  async toggleSetting(tenantId: string, ticketType: string) {
    const existing = await prisma.printSetting.findUnique({
      where: {
        tenantId_ticketType: { tenantId, ticketType: ticketType as any },
      },
    });

    if (!existing) {
      throw new AppError(404, 'PRINT_SETTING_NOT_FOUND', `未找到 ${ticketType} 的打印设置`);
    }

    const updated = await prisma.printSetting.update({
      where: {
        tenantId_ticketType: { tenantId, ticketType: ticketType as any },
      },
      data: {
        isEnabled: !existing.isEnabled,
        version: existing.version + 1,
      },
    });

    logger.info('打印设置启用状态已切换', {
      tenantId,
      ticketType,
      isEnabled: updated.isEnabled,
    });

    return updated;
  }

  /**
   * 检查版本号（POS 同步用）
   * @param versionsStr 格式：CUSTOMER_RECEIPT:3,KITCHEN_TICKET:2
   */
  async checkVersion(tenantId: string, versionsStr?: string) {
    const settings = await prisma.printSetting.findMany({
      where: { tenantId },
      select: { ticketType: true, version: true },
    });

    // 解析客户端版本号
    const clientVersions: Record<string, number> = {};
    if (versionsStr) {
      versionsStr.split(',').forEach(item => {
        const [type, ver] = item.trim().split(':');
        if (type && ver) {
          clientVersions[type] = parseInt(ver, 10);
        }
      });
    }

    // 比对版本
    const versions: Record<string, { version: number; needsUpdate: boolean }> = {};
    let hasUpdates = false;

    for (const setting of settings) {
      const clientVersion = clientVersions[setting.ticketType] ?? 0;
      const needsUpdate = setting.version > clientVersion;
      if (needsUpdate) hasUpdates = true;

      versions[setting.ticketType] = {
        version: setting.version,
        needsUpdate,
      };
    }

    return { hasUpdates, versions };
  }

  /**
   * 初始化所有票据类型的默认配置
   */
  async initialize(tenantId: string, userId: string, token?: string) {
    const ticketTypes = Object.keys(TICKET_TYPE_META) as TicketType[];
    const results = [];

    // 如果需要初始化客户收据，先从 Auth Service 获取组织信息
    let orgInfo = null;
    if (ticketTypes.includes('CUSTOMER_RECEIPT')) {
      try {
        orgInfo = await organizationService.getOrganization(tenantId, token);
        if (orgInfo) {
          logger.info('已获取组织信息用于初始化打印设置', {
            tenantId,
            orgName: orgInfo.orgName,
          });
        }
      } catch (error: any) {
        logger.warn('获取组织信息失败，使用默认配置初始化', {
          tenantId,
          error: error.message,
        });
      }
    }

    for (const ticketType of ticketTypes) {
      const meta = TICKET_TYPE_META[ticketType];
      let config = getDefaultConfig(ticketType);

      // 如果是客户收据且成功获取了组织信息，填充店铺信息
      if (ticketType === 'CUSTOMER_RECEIPT' && orgInfo) {
        const configObj = config as any;
        if (configObj.sections?.storeInfo) {
          configObj.sections.storeInfo.name = orgInfo.orgName || '';
          configObj.sections.storeInfo.address = orgInfo.location || '';
          configObj.sections.storeInfo.phone = orgInfo.phone || '';
        }
        config = configObj;
      }

      // 查找已有记录
      const existing = await prisma.printSetting.findUnique({
        where: {
          tenantId_ticketType: { tenantId, ticketType },
        },
      });

      let mergedConfig = config;
      if (existing) {
        // 已存在：将默认配置中缺失的字段补充到现有配置中（不覆盖用户已自定义的值）
        mergedConfig = deepMergeDefaults(config, existing.config as Record<string, any>);
      }

      const setting = await prisma.printSetting.upsert({
        where: {
          tenantId_ticketType: { tenantId, ticketType },
        },
        create: {
          tenantId,
          ticketType,
          isEnabled: meta.defaultEnabled,
          copies: meta.defaultCopies,
          config: mergedConfig,
          createdBy: userId,
        },
        update: {
          config: mergedConfig,
        },
      });

      results.push(setting);
    }

    logger.info('打印设置已初始化', {
      tenantId,
      count: results.length,
    });

    return results;
  }

  /**
   * 获取票据类型元信息（前端展示用）
   */
  getTicketTypeMeta() {
    return Object.entries(TICKET_TYPE_META).map(([type, meta]) => ({
      ticketType: type,
      ...meta,
    }));
  }
}

export default new PrintSettingService();

// ─── 取餐号配置（全渠道共享计数器 + 可自定义渠道前缀）─────────────────────────

// 内置默认前缀，未自定义时使用
const DEFAULT_CHANNEL_PREFIX: Record<string, string> = {
  POS: 'P',
  WEB: 'W',
  KIOSK: 'K',
};

export interface PickupNumberConfigData {
  startAt: number;
  showPrefix: boolean;
  channelPrefixes: Record<string, string>;
  queueDisplayEnabled: boolean;
}

export class PickupNumberConfigService {
  /**
   * 获取租户取餐号配置（未配置时返回默认值）
   */
  async getConfig(tenantId: string): Promise<PickupNumberConfigData> {
    const row = await prisma.pickupNumberConfig.findUnique({
      where: { tenantId },
    });
    return {
      startAt: row?.startAt ?? 1,
      showPrefix: row?.showPrefix ?? true,
      channelPrefixes: (row?.channelPrefixes as Record<string, string>) ?? {},
      queueDisplayEnabled: row?.queueDisplayEnabled ?? false,
    };
  }

  /**
   * 更新（或创建）取餐号配置
   */
  async upsertConfig(
    tenantId: string,
    data: { startAt?: number; showPrefix?: boolean; channelPrefixes?: Record<string, string>; queueDisplayEnabled?: boolean },
  ): Promise<PickupNumberConfigData> {
    const { startAt, showPrefix, channelPrefixes, queueDisplayEnabled } = data;

    if (startAt !== undefined && (!Number.isInteger(startAt) || startAt < 1 || startAt > 99999)) {
      throw new AppError(400, 'INVALID_START_AT', '起始取餐号必须为 1-99999 之间的整数');
    }

    if (channelPrefixes !== undefined) {
      for (const [source, prefix] of Object.entries(channelPrefixes)) {
        if (typeof prefix !== 'string' || prefix.length > 5) {
          throw new AppError(400, 'INVALID_PREFIX', `渠道 ${source} 的前缀最长 5 个字符`);
        }
      }
    }

    const updateData: Record<string, unknown> = {};
    if (startAt !== undefined) updateData.startAt = startAt;
    if (showPrefix !== undefined) updateData.showPrefix = showPrefix;
    if (channelPrefixes !== undefined) updateData.channelPrefixes = channelPrefixes;
    if (queueDisplayEnabled !== undefined) updateData.queueDisplayEnabled = queueDisplayEnabled;

    await prisma.pickupNumberConfig.upsert({
      where: { tenantId },
      create: {
        tenantId,
        startAt: startAt ?? 1,
        showPrefix: showPrefix ?? true,
        channelPrefixes: channelPrefixes ?? {},
        queueDisplayEnabled: queueDisplayEnabled ?? false,
      },
      update: updateData,
    });

    logger.info('更新取餐号配置', { tenantId, ...data });
    return this.getConfig(tenantId);
  }

  /**
   * 原子获取下一个取餐号（全渠道共享计数器）
   * INSERT ON CONFLICT 保证并发安全，每天自动重置
   */
  async nextPickupNumber(tenantId: string, startAt: number, forDate?: Date): Promise<number> {
    const d = forDate ?? new Date();
    const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

    const result = await prisma.$queryRaw<[{ counter: number }]>`
      INSERT INTO pickup_counters (tenant_id, date, counter)
      VALUES (${tenantId}::uuid, ${dateStr}::date, ${startAt})
      ON CONFLICT (tenant_id, date)
      DO UPDATE SET counter = pickup_counters.counter + 1
      RETURNING counter
    `;

    return Number(result[0].counter);
  }

  /**
   * 格式化取餐号显示，优先用自定义前缀，其次用内置默认值
   *
   * ⚠️ channelPrefixes **必传**，不给默认值是故意的：
   * 之前它默认 `{}`，order.service 建单时漏传编译器不报错，
   * 结果小票走内置默认前缀、叫号屏走商家自定义前缀，同一单两个号。
   * 调用方一律传 `getConfig()` 拿到的 config.channelPrefixes。
   */
  formatPickupDisplay(
    pickupNumber: number,
    orderSource: string,
    showPrefix: boolean,
    channelPrefixes: Record<string, string>,
  ): string {
    if (!showPrefix) return String(pickupNumber);
    const prefix = channelPrefixes[orderSource] ?? DEFAULT_CHANNEL_PREFIX[orderSource] ?? '';
    return prefix ? `${prefix}-${pickupNumber}` : String(pickupNumber);
  }
}

export const pickupNumberConfigService = new PickupNumberConfigService();
