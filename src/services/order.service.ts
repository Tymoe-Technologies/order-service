import prisma from '../utils/prisma';
import { pickupNumberConfigService } from './print-setting.service';
import { AppError } from '../middleware/errorHandler';
import logger from '../utils/logger';
import { assertCreditAvailable } from './credit.service';
import { v4 as uuidv4, v7 as uuidv7 } from 'uuid';
import { eventBus } from '../events';
import { getMemberIdByConsumerId, validateGrantedRewardForMember } from '../utils/member-client';
import { broadcastOrderStatusChanged } from '../websocket/print-task-dispatcher';
import organizationService from './organization.service';
import { getRefundsByOrderId } from './refund.service';

const FINANCE_SERVICE_URL = process.env.FINANCE_SERVICE_URL || 'http://localhost:7007';
const INTERNAL_SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY || '';

/** 通知 finance-service 记录积分兑换折扣账本分录（非致命，失败只记日志） */
async function notifyLoyaltyDiscount(params: {
  tenantId: string;
  orderId: string;
  discountAmount: number;
  currency?: string;
  grantedRewardId?: string;
}): Promise<void> {
  if (!INTERNAL_SERVICE_KEY || params.discountAmount <= 0) return;
  try {
    const res = await fetch(`${FINANCE_SERVICE_URL}/internal/ledger/loyalty-discount`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-service-api-key': INTERNAL_SERVICE_KEY },
      body: JSON.stringify({
        tenantId: params.tenantId,
        orderId: params.orderId,
        discountAmount: params.discountAmount,
        currency: params.currency ?? 'CAD',
        grantedRewardId: params.grantedRewardId,
      }),
    });
    if (!res.ok) {
      logger.warn('[OrderService] finance-service 积分折扣分录失败', { orderId: params.orderId, status: res.status });
    }
  } catch (err: any) {
    logger.warn('[OrderService] finance-service 积分折扣分录异常（非致命）', { orderId: params.orderId, err: err.message });
  }
}

/** 通知 finance-service 记录 PLATFORM / ACCOUNT 订单的财务分录（非致命） */
async function notifyOrderPaid(params: {
  paymentMethod: string;
  tenantId: string;
  orderId: string;
  orderNumber: string;
  totalAmount: number;
  subtotal?: number;
  channelDiscountAmount?: number;
  taxAmount?: number;
  channelId?: string | null;
  channelName?: string | null;
  platformType?: string | null;
  commissionRate?: string | null;
  currency?: string;
}): Promise<void> {
  if (!INTERNAL_SERVICE_KEY) return;
  try {
    const res = await fetch(`${FINANCE_SERVICE_URL}/internal/ledger/order-paid`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-service-api-key': INTERNAL_SERVICE_KEY },
      body: JSON.stringify({ ...params, currency: params.currency ?? 'CAD' }),
    });
    if (!res.ok) {
      logger.warn('[OrderService] finance-service order-paid 分录失败', { orderId: params.orderId, status: res.status });
    }
  } catch (err: any) {
    logger.warn('[OrderService] finance-service order-paid 分录异常（非致命）', { orderId: params.orderId, err: err.message });
  }
}

/** 通知 finance-service 记录员工手动折扣 / Comp 账本分录(非致命) */
async function notifyManualDiscount(params: {
  tenantId: string;
  orderId: string;
  discountAmount: number;
  currency?: string;
  reason?: string;
}): Promise<void> {
  if (!INTERNAL_SERVICE_KEY || params.discountAmount <= 0) return;
  try {
    const res = await fetch(`${FINANCE_SERVICE_URL}/internal/ledger/manual-discount`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-service-api-key': INTERNAL_SERVICE_KEY },
      body: JSON.stringify({
        tenantId: params.tenantId,
        orderId: params.orderId,
        discountAmount: params.discountAmount,
        currency: params.currency ?? 'CAD',
        reason: params.reason,
      }),
    });
    if (!res.ok) {
      logger.warn('[OrderService] finance-service 手动折扣分录失败', { orderId: params.orderId, status: res.status });
    }
  } catch (err: any) {
    logger.warn('[OrderService] finance-service 手动折扣分录异常（非致命）', { orderId: params.orderId, err: err.message });
  }
}

interface CreateOrderItem {
  itemId: string;
  itemName: string;
  quantity: number;
  unitPrice: number;  // 含 modifiers，不含折扣
  
  // 商品级别折扣
  discountAmount?: number;
  discountType?: 'PERCENTAGE' | 'FIXED';
  discountValue?: number;
  discountReason?: string;
  
  attributes?: any;
  modifiers?: Array<{
    groupId?: string;     // 修饰符组 ID（新版必填，旧版兼容可选）
    optionId: string;
    groupName?: string;   // 修饰符组名快照
    optionName: string;
    unitPrice: number;
    quantity: number;
  }>;
  specialNotes?: string;
}

interface CreateOrderData {
  orderType: 'DINE_IN' | 'TAKEOUT' | 'DELIVERY';
  clientOrigin?: 'POS' | 'WEB' | 'KIOSK';
  tableNumber?: string;
  customerName?: string;
  customerPhone?: string;
  memberId?: string;  // 会员 ID（可选，匿名订单不设置）
  items: CreateOrderItem[];
  notes?: string;

  // 预约自取
  isScheduled?: boolean;    // 是否为预约订单
  scheduledAt?: string;     // 预约取餐时间（ISO 8601）

  // 费用相关
  taxAmount?: number;
  discountAmount?: number;
  serviceFee?: number;
  deliveryFee?: number;
  platformFee?: number;
  tipAmount?: number;

  // 折扣明细
  discountType?: string;    // COUPON, PROMOTION, MEMBER, MANUAL
  discountCode?: string;    // 优惠券/促销代码
  discountReason?: string;  // 折扣原因

  // 支付信息
  paymentMethod?: string;   // CASH, CARD, ALIPAY, WECHAT, ACCOUNT 等
  transactionId?: string;   // 支付平台交易ID

  // 收银员信息快照（可选，POS 下单时由客户端带上）
  cashierName?: string;
  cashierEmployeeNumber?: string;

  // 销售渠道（可选，选择了自定义渠道时传入）
  salesChannelId?: string; // SalesChannelConfig.id
}

interface OrderQuery {
  status?: string;
  orderType?: string;
  clientOrigin?: string;
  startDate?: string;
  endDate?: string;
  page?: number;
  limit?: number;
  search?: string;  // 支持 pickupNumber（数字）或 orderNumber（字符串）模糊匹配
}

export class OrderService {
  // 可信任的客户端入口（不需要验证价格）
  private trustedOrigins = (process.env.TRUSTED_ORDER_SOURCES || 'POS,KIOSK').split(',');

  /**
   * 判断客户端入口是否需要验证价格
   * POS/KIOSK 是可信环境，不需要验证
   * WEB 等不可信入口需要调用 Item 服务验证价格
   */
  private needsPriceValidation(clientOrigin: string): boolean {
    return !this.trustedOrigins.includes(clientOrigin);
  }

  // 订单号前缀码：按客户端入口区分，不在号码中暴露入口全名
  private static readonly ORIGIN_PREFIX_CODE: Record<string, string> = {
    POS: 'P',
    WEB: 'W',
    KIOSK: 'K',
    UBER_EATS: 'U',
  };

  // 随机字符集：去掉 I/O 避免与 1/0 混淆，共 34 种字符（34^4 ≈ 130 万种组合）
  private static readonly SUFFIX_CHARS = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ';

  private generateRandomSuffix(length = 4): string {
    const chars = OrderService.SUFFIX_CHARS;
    let result = '';
    for (let i = 0; i < length; i++) {
      result += chars[Math.floor(Math.random() * chars.length)];
    }
    return result;
  }

  // 生成订单号前缀（门店码 + MMDD + 入口码），不含随机后缀
  private buildOrderPrefix(tenantId: string, clientOrigin: string): string {
    const storeCode = tenantId.replace(/-/g, '').substring(0, 4).toUpperCase();
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const originCode = OrderService.ORIGIN_PREFIX_CODE[clientOrigin] ?? 'X';
    return `${storeCode}${now.getFullYear() % 100}${month}${day}${originCode}`;
  }

  // 生成一个候选订单号（前缀 + 随机4位），不保证唯一性，由 DB @unique 约束最终保障
  buildCandidateOrderNumber(tenantId: string, clientOrigin: string): string {
    return `${this.buildOrderPrefix(tenantId, clientOrigin)}${this.generateRandomSuffix(4)}`;
  }

  async generateOrderNumber(tenantId: string, clientOrigin: string): Promise<{ orderNumber: string }> {
    const orderNumber = this.buildCandidateOrderNumber(tenantId, clientOrigin);
    return { orderNumber };
  }

  /**
   * 生成取餐号（原子自增，在支付成功时调用）
   * 全渠道共享计数器，每天自动重置，无空洞
   */
  async generatePickupNumber(tenantId: string, clientOrigin: string, forDate?: Date): Promise<{ pickupNumber: number; pickupDisplay: string }> {
    const config = await pickupNumberConfigService.getConfig(tenantId);
    const pickupNumber = await pickupNumberConfigService.nextPickupNumber(tenantId, config.startAt, forDate);
    const pickupDisplay = pickupNumberConfigService.formatPickupDisplay(pickupNumber, clientOrigin, config.showPrefix);
    return { pickupNumber, pickupDisplay };
  }

  // 判断 Prisma 错误是否为订单号唯一约束冲突（P2002）
  private isOrderNumberConflict(e: unknown): boolean {
    if (typeof e !== 'object' || e === null) return false;
    const err = e as Record<string, unknown>;
    return (
      err['code'] === 'P2002' &&
      Array.isArray(err['meta'] && (err['meta'] as Record<string, unknown>)['target']) &&
      ((err['meta'] as Record<string, unknown>)['target'] as string[]).some(f => f.includes('order_number'))
    );
  }

  async createOrder(data: CreateOrderData, userId: string, tenantId: string, token?: string, messageId?: string) {
    try {
      const clientOrigin = data.clientOrigin || 'POS';

      // 验证数据
      if (!data.items || data.items.length === 0) {
        throw new AppError(400, 'INVALID_ITEMS', '订单必须包含至少一个商品');
      }

      // ── 会员券防双花关卡 ───────────────────────────────────────
      // POS 同步路径把券 ID 通过 discountReason='GrantedReward:<id>' 带过来。
      // 创单前先调 member-service 校验:不是 ACTIVE 就拒绝,避免同张券被两个端各下一单都享折扣。
      // 注:这里只是把窗口缩到 [validate→/use] 之间。完全原子化要把校验+落 USED 合成一次原子操作,
      // 当前的"小窗"对单店多终端足够,跨端比赛过来 /use 端点的状态机仍是最终关卡(idempotent)。
      const _dr: string | undefined = data.discountReason;
      if (_dr && _dr.startsWith('GrantedReward:') && data.memberId) {
        const _grId = _dr.slice('GrantedReward:'.length);
        const check = await validateGrantedRewardForMember(_grId, data.memberId);
        if (!check.valid) {
          throw new AppError(400, 'COUPON_NOT_VALID', `优惠券不可用: ${check.reason ?? 'unknown'}`);
        }
      }

      // 注意：不使用消息中的 orderId，由数据库自动生成 UUID
      // 消息中的 orderId 仅用于幂等性检查，不作为数据库记录 ID

      let subtotal = 0;
      let orderItems;
      
      // 根据客户端入口决定是否需要验证价格
      if (this.needsPriceValidation(clientOrigin)) {
        // 不可信入口（如 WEB）：需要调用 Item 服务验证价格
        logger.info(`Validating prices for untrusted origin: ${clientOrigin}`);

        if (!token) {
          throw new AppError(400, 'TOKEN_REQUIRED', '不可信入口需要提供认证令牌');
        }

        const validated = await this.validateAndCalculateOrderPrices(
          data.items,
          clientOrigin,
          token
        );
        orderItems = validated.items;
        subtotal = validated.subtotal;
      } else {
        // 可信入口（POS/KIOSK）：直接使用前端计算的价格
        logger.info(`Accepting prices from trusted origin: ${clientOrigin}`);
        
        orderItems = data.items.map((item) => {
          // POS/KIOSK 是可信来源，直接使用前端计算的价格
          // unitPrice 包含修饰符价格，不包含折扣
          // 后端只负责保存数据，不重新计算
          const itemTotal = item.quantity * item.unitPrice;

          // 商品级别折扣金额（前端已计算）
          const itemDiscountAmount = item.discountAmount || 0;

          // 商品总价 = 单价×数量 - 商品折扣
          const totalPrice = itemTotal - itemDiscountAmount;
          subtotal += totalPrice;

          return {
            itemId: item.itemId,
            itemName: item.itemName,
            quantity: item.quantity,
            unitPrice: Math.round(item.unitPrice),  // 确保是整数（分）
            totalPrice: Math.round(totalPrice),  // 确保是整数（分）

            // 商品折扣信息（分）
            discountAmount: item.discountAmount ? Math.round(item.discountAmount) : 0,
            discountType: item.discountType || null,
            discountValue: item.discountValue || null,
            discountReason: item.discountReason || null,

            attributes: item.attributes || null,
            modifiers: null,  // 不再写 JSON，改用 OrderItemModifier 关系表
            specialNotes: item.specialNotes || null,
          };
        });
      }

      // 提取费用字段（POS/KIOSK 可信来源，使用前端传来的值）
      const taxAmount = data.taxAmount || 0;
      const serviceFee = data.serviceFee || 0;
      const deliveryFee = data.deliveryFee || 0;
      const platformFee = data.platformFee || 0;
      const tipAmount = data.tipAmount || 0;
      
      // 计算所有商品的折扣总额
      const itemDiscountTotal = data.items.reduce((sum, item) => sum + (item.discountAmount || 0), 0);
      
      // 订单级别的 discountAmount
      // 前端可能传的是：商品折扣总额 + 整单折扣
      // 后端需要提取出整单折扣 = discountAmount - 商品折扣总额
      const orderDiscountAmount = data.discountAmount || 0;
      const orderLevelDiscount = Math.max(0, orderDiscountAmount - itemDiscountTotal);
      
      // ── 渠道折扣计算 ────────────────────────────────────────────
      // 如果传入了 salesChannelId，服务端从渠道配置中读取折扣规则，
      // 独立于前端传入的 discountAmount，防止篡改
      let channelDiscountAmount = 0;
      let channelConfig: Awaited<ReturnType<typeof prisma.orderSourceConfig.findFirst>> | null = null;

      if (data.salesChannelId) {
        channelConfig = await prisma.orderSourceConfig.findFirst({
          where: { id: data.salesChannelId, tenantId, isActive: true },
        });

        if (!channelConfig) {
          throw new AppError(400, 'CHANNEL_NOT_FOUND', '指定的渠道不存在或已停用');
        }

        const rules = channelConfig.checkoutRules as any;
        const discount = rules?.orderDiscount;
        if (discount?.enabled) {
          if (discount.type === 'PERCENTAGE') {
            // value 为 0-100 的百分比
            channelDiscountAmount = Math.round(subtotal * (discount.value / 100));
          } else if (discount.type === 'FIXED') {
            // value 单位为分
            channelDiscountAmount = Math.min(discount.value, subtotal);
          }
        }

        // 记账模式：支付方式强制覆盖为 ACCOUNT
        if (channelConfig.checkoutMode === 'CREDIT_ACCOUNT') {
          data.paymentMethod = 'ACCOUNT';
        }
      }

      // 计算总金额: 小计（已扣商品折扣）+ 各项费用 - 整单折扣 - 渠道折扣
      const totalAmount = Math.max(
        0,
        subtotal + taxAmount + serviceFee + deliveryFee + platformFee + tipAmount
          - orderLevelDiscount - channelDiscountAmount
      );

      // 记账渠道：在建单前校验授信额度，不足则拒绝（与 Web snapshot 路径一致）
      if (channelConfig?.checkoutMode === 'CREDIT_ACCOUNT') {
        await assertCreditAvailable(tenantId, channelConfig.id, totalAmount);
      }

      logger.info('Discount calculation', {
        itemDiscountTotal,
        orderDiscountAmount,
        orderLevelDiscount,
        channelDiscountAmount,
        subtotal,
        totalAmount,
      });

      // 只生成订单号，不生成取餐号
      // 取餐号在支付成功（PAID）时原子生成，避免取消订单造成号码空洞
      let { orderNumber } = await this.generateOrderNumber(tenantId, clientOrigin);

      // 记账模式直接标为 PAID（无需即时收款，finance-service 后续追踪账期）
      // 其他模式统一 UNPAID，支付完成由 Finance Service 回调更新
      // ACCOUNT = 渠道记账；PLATFORM = 外卖平台已代收；两者均直接标为 PAID
      const isAccountPayment = data.paymentMethod === 'ACCOUNT'
        || channelConfig?.checkoutMode === 'CREDIT_ACCOUNT';
      const isPlatformCollect = data.paymentMethod === 'PLATFORM'
        || (channelConfig?.platformType != null && channelConfig.platformType !== '');
      const paymentStatus = (isAccountPayment || isPlatformCollect) ? 'PAID' : 'UNPAID';
      const paidAt: Date | null = (isAccountPayment || isPlatformCollect) ? new Date() : null;


      // POS 订单在建单时就生成取餐号，无需等待 Finance 回调
      // 取餐号不是稀缺资源，少量废单不影响运营
      let posPickupNumber: number | null = null;
      let posPickupDisplay: string | null = null;
      if (clientOrigin === 'POS') {
        const pickup = await this.generatePickupNumber(tenantId, clientOrigin);
        posPickupNumber = pickup.pickupNumber;
        posPickupDisplay = pickup.pickupDisplay;
      }

      // 用 DB @unique 约束作为最终保障，碰撞时重新生成后缀重试（极小概率）
      let order: Awaited<ReturnType<typeof prisma.order.create>>;
      for (let attempt = 0; ; attempt++) {
        try {
          order = await prisma.order.create({
            data: {
              // 订单主键用 UUID v7（时间有序），改善高频写入时的索引局部性；
              // 仍是标准 128-bit UUID，与 @db.Uuid 列和现有 v4 老数据完全兼容
              id: uuidv7(),
              tenantId,
              orderNumber,
              // POS 订单建单时就分配取餐号；其他来源在支付成功时生成
              pickupNumber: posPickupNumber,
              messageId: messageId || null,  // 保存 messageId 用于幂等性检查
              orderType: data.orderType,
              orderSource: clientOrigin,
              tableNumber: data.tableNumber || null,
              customerName: data.customerName || null,
              customerPhone: data.customerPhone || null,
              memberId: data.memberId || null,
              channelConfigId: data.salesChannelId || null,
              channelName: channelConfig?.sourceName || null,

              // 金额明细（分，整数）
              subtotal: Math.round(subtotal),
              taxAmount: Math.round(taxAmount),
              // 订单总折扣 = 商品折扣合计 + 整单折扣
              discountAmount: Math.round(itemDiscountTotal + orderLevelDiscount),
              channelDiscountAmount: Math.round(channelDiscountAmount),
              serviceFee: Math.round(serviceFee),
              deliveryFee: Math.round(deliveryFee),
              platformFee: Math.round(platformFee),
              tipAmount: Math.round(tipAmount),
              totalAmount: Math.round(totalAmount),

              // 折扣明细
              discountType: data.discountType || null,
              discountCode: data.discountCode || null,
              discountReason: data.discountReason || null,

              // 支付信息
              paymentStatus: paymentStatus,
              paymentMethod: data.paymentMethod || null,
              transactionId: data.transactionId || null,
              paidAt: paidAt,

              cashierId: userId,  // 收银员就是创建订单的用户
              cashierName: data.cashierName || null,                       // 收银员姓名快照
              cashierEmployeeNumber: data.cashierEmployeeNumber || null,   // 收银员工号快照

              // 预约自取
              isScheduled: data.isScheduled || false,
              scheduledAt: data.isScheduled && data.scheduledAt ? new Date(data.scheduledAt) : null,
              // 预约订单初始状态为 SCHEDULED，普通订单为 PENDING
              status: data.isScheduled ? 'SCHEDULED' : 'PENDING',

              notes: data.notes || null,
              createdBy: userId,
              orderItems: {
                create: orderItems,
              },
            },
            include: {
              orderItems: { include: { orderItemModifiers: true } },
            },
          });
          break;
        } catch (e) {
          if (attempt < 4 && this.isOrderNumberConflict(e)) {
            // 订单号碰撞（极小概率），重新生成后缀
            logger.warn('订单号碰撞，重新生成后缀', { attempt, orderNumber });
            orderNumber = this.buildCandidateOrderNumber(tenantId, clientOrigin);
            continue;
          }
          throw e;
        }
      }

      logger.info(`Order created: ${order.orderNumber}`, {
        orderId: order.id,
        orderNumber: order.orderNumber,
        messageId: messageId || null,
        clientOrigin,
        priceValidated: this.needsPriceValidation(clientOrigin),
        subtotal,
        totalAmount
      });

      // 发出事件：打印、分析等副作用由 handler 处理
      eventBus.emit({
        type: 'ORDER_CREATED',
        eventId: uuidv4(),
        timestamp: new Date(),
        tenantId,
        orderId: order.id,
        orderNumber: order.orderNumber,
        clientOrigin,
        orderType: data.orderType,
        paymentStatus,
        items: data.items,
        order,
      });

      // PLATFORM / ACCOUNT 订单：通知 finance-service 写财务分录（非阻塞）
      if (isAccountPayment || isPlatformCollect) {
        const pm = isPlatformCollect ? 'PLATFORM' : 'ACCOUNT';
        notifyOrderPaid({
          paymentMethod: pm,
          tenantId,
          orderId: order.id,
          orderNumber: order.orderNumber,
          totalAmount: order.totalAmount,
          subtotal: order.subtotal,
          channelDiscountAmount: order.channelDiscountAmount,
          taxAmount: order.taxAmount,
          channelId: channelConfig?.id ?? null,
          channelName: channelConfig?.sourceName ?? null,
          platformType: (channelConfig as any)?.platformType ?? null,
          commissionRate: (channelConfig as any)?.commissionRate?.toString() ?? null,
        }).catch(() => {}); // 非致命
      }

      return {
        id: order.id,
        orderNumber: order.orderNumber,
        pickupNumber: posPickupNumber ?? order.pickupNumber ?? null,
        pickupDisplay: posPickupDisplay,   // POS 建单时已生成；其他来源为 null
        status: order.status,
        totalAmount: order.totalAmount,
        paymentStatus: order.paymentStatus,
        paymentMethod: order.paymentMethod,
        memberId: order.memberId,
        createdAt: order.createdAt,
      };
    } catch (error) {
      logger.error('Error creating order:', error);
      throw error;
    }
  }
  
  /**
   * 验证并计算订单价格（仅用于不可信来源，如 Web）
   * 
   * 当前为存根实现，未来支持 Web 端时需要：
   * 1. 调用 Item 服务的 /pricing/calculate API
   * 2. 验证前端传来的价格是否正确
   * 3. 返回验证后的商品列表和小计
   * 
   * @throws AppError 当价格验证失败或 Item 服务不可用时
   */
  private async validateAndCalculateOrderPrices(
    items: CreateOrderItem[],
    clientOrigin: string,
    token: string
  ): Promise<{ items: any[]; subtotal: number }> {
    // TODO: 未来实现 Web 端时，调用 Item 服务验证价格
    // 
    // 实现步骤：
    // 1. 安装 axios: npm install axios
    // 2. 配置 ITEM_SERVICE_URL 环境变量
    // 3. 为每个商品调用 POST /pricing/calculate
    // 4. 比对前端价格和后端计算的价格
    // 5. 返回验证后的商品列表
    //
    // 示例代码：
    // const itemServiceUrl = process.env.ITEM_SERVICE_URL;
    // const response = await axios.post(`${itemServiceUrl}/pricing/calculate`, {
    //   itemId: item.itemId,
    //   sourceCode: clientOrigin,
    //   modifiers: item.addons
    // }, {
    //   headers: { Authorization: token }
    // });
    
    logger.warn('Price validation not implemented for origin:', clientOrigin);
    throw new AppError(
      501,
      'PRICE_VALIDATION_NOT_IMPLEMENTED',
      `客户端入口 ${clientOrigin} 需要价格验证，但该功能尚未实现。当前仅支持 POS 和 KIOSK。`
    );
  }

  async getOrders(query: OrderQuery, tenantId: string) {
    const page = query.page || 1;
    const limit = query.limit || 20;
    const skip = (page - 1) * limit;

    const where: any = { tenantId };

    if (query.status) {
      where.status = query.status;
    }

    if (query.orderType) {
      where.orderType = query.orderType;
    }

    if (query.clientOrigin) {
      where.orderSource = query.clientOrigin;
    }

    if (query.startDate || query.endDate) {
      where.createdAt = {};
      if (query.startDate) {
        where.createdAt.gte = new Date(query.startDate);
      }
      if (query.endDate) {
        where.createdAt.lte = new Date(query.endDate);
      }
    }

    if (query.search) {
      const asNumber = parseInt(query.search);
      if (!isNaN(asNumber)) {
        // 纯数字：优先按取餐号精确匹配，也支持 orderNumber 模糊匹配
        where.OR = [
          { pickupNumber: asNumber },
          { orderNumber: { contains: query.search, mode: 'insensitive' } },
        ];
      } else {
        // 含字母：按 orderNumber 模糊匹配
        where.orderNumber = { contains: query.search, mode: 'insensitive' };
      }
    }

    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          orderItems: { include: { orderItemModifiers: true } },
        },
      }),
      prisma.order.count({ where }),
    ]);

    // 读时解析门店时区：同租户一次查询，附加到每个订单（null 时客户端回退本地时区）
    const storeTimezone = await organizationService.getStoreTimezone(tenantId);
    const ordersWithTz = orders.map((o) => ({ ...o, storeTimezone }));

    return {
      orders: ordersWithTz,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getOrderById(orderId: string, tenantId: string) {
    const order = await prisma.order.findFirst({
      where: { id: orderId, tenantId },
      include: {
        orderItems: { include: { orderItemModifiers: true } },
        orderNotes: {
          orderBy: { createdAt: 'desc' },
        },
        analytics: true,
      },
    });

    if (!order) {
      throw new AppError(404, 'ORDER_NOT_FOUND', '订单不存在');
    }

    // 读时解析门店时区（null 时客户端回退本地时区）
    const storeTimezone = await organizationService.getStoreTimezone(tenantId);
    return { ...order, storeTimezone };
  }

  /**
   * 平台内部：不绑租户、按订单 id 或订单号查订单（供 admin-bff 上帝视角"业务视图"下钻用）。
   * 与 getOrderById 的区别：跨租户（平台方可查任意商户订单），且 UUID / 人类订单号都能查。
   * 仅经 internalAuth（x-service-api-key）的内部接口调用，不对外暴露。
   */
  async getOrderByIdInternal(idOrNumber: string) {
    // id 是 Postgres UUID 列，直接拿非 UUID 字符串按 id 查会导致数据库报错，
    // 所以只有输入是合法 UUID 时才按 id 匹配，否则只按订单号匹配
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrNumber);
    const where = isUuid
      ? { OR: [{ id: idOrNumber }, { orderNumber: idOrNumber }] }
      : { orderNumber: idOrNumber };
    const order = await prisma.order.findFirst({
      where,
      include: {
        orderItems: { include: { orderItemModifiers: true } },
        orderNotes: { orderBy: { createdAt: 'desc' } },
        analytics: true,
      },
    });

    if (!order) {
      throw new AppError(404, 'ORDER_NOT_FOUND', '订单不存在');
    }

    const storeTimezone = await organizationService.getStoreTimezone(order.tenantId);
    return { ...order, storeTimezone };
  }

  /**
   * 预约订单状态机：合法的状态流转路径
   * SCHEDULED 表示预约等待中，到时间后自动/手动释放为 PENDING
   */
  private static readonly VALID_TRANSITIONS: Record<string, string[]> = {
    SCHEDULED:        ['PENDING', 'CONFIRMED', 'CANCELLED'], // 预约中 → 释放/自动确认/取消
    PENDING:          ['CONFIRMED', 'CANCELLED'],          // 待确认 → 确认/取消
    CONFIRMED:        ['PREPARING', 'READY', 'COMPLETED', 'CANCELLED'], // 已确认 → 制作/直接叫号(现做现取)/完成/取消
    PREPARING:        ['READY', 'CANCELLED'],              // 制作中 → 完成/取消
    READY:            ['PICKED_UP', 'COMPLETED', 'CANCELLED'], // 待取 → 已取/完成/取消
    PICKED_UP:        ['COMPLETED'],                       // 已取 → 完成
    OUT_FOR_DELIVERY: ['DELIVERED', 'CANCELLED'],          // 配送中 → 送达/取消
    DELIVERED:        ['COMPLETED'],                       // 已送达 → 完成
    COMPLETED:        [],                                  // 终态
    CANCELLED:        [],                                  // 终态
  };

  async updateOrderStatus(orderId: string, newStatus: string, tenantId: string, reason?: string, changedBy?: string) {
    const order = await prisma.order.findFirst({
      where: { id: orderId, tenantId },
    });

    if (!order) {
      throw new AppError(404, 'ORDER_NOT_FOUND', '订单不存在');
    }

    const fromStatus = order.status as string;

    // 检查状态流转是否合法
    const allowed = OrderService.VALID_TRANSITIONS[fromStatus] ?? [];
    if (!allowed.includes(newStatus)) {
      throw new AppError(
        400,
        'INVALID_STATUS_TRANSITION',
        `订单状态不能从 ${fromStatus} 变更为 ${newStatus}`
      );
    }

    // Uber Direct 配送单（WEB 来源的 DELIVERY 订单）不允许通过这个通用状态接口离开 PENDING——
    // 必须先经 delivery-confirmation.service.ts 的 confirmDeliveryOrder 真正建好 Uber 配送单，
    // 状态和 deliveryConfirmedAt 才会一起联动改成 CONFIRMED。否则会出现订单状态显示"已接单"
    // 但实际从未建过配送单的脱节（uber-service/uber 平台侧完全不知道这笔订单）
    if (
      fromStatus === 'PENDING' &&
      order.orderType === 'DELIVERY' &&
      order.orderSource === 'WEB' &&
      !order.deliveryConfirmedAt
    ) {
      throw new AppError(
        400,
        'DELIVERY_NOT_CONFIRMED',
        '该配送订单尚未创建 Uber Direct 配送单，请使用"接单"操作而不是直接改状态'
      );
    }

    const now = new Date();

    // 根据目标状态设置对应的时间戳
    const timestamps: Record<string, any> = {};
    if (newStatus === 'PENDING' && fromStatus === 'SCHEDULED') {
      timestamps.releasedAt = now;
      timestamps.scheduledConfirmedAt = now;
    }
    if (newStatus === 'CONFIRMED')        timestamps.confirmedAt = now;
    if (newStatus === 'PREPARING')        timestamps.preparingAt = now;
    if (newStatus === 'READY')            timestamps.readyAt = now;
    if (newStatus === 'COMPLETED')        timestamps.completedAt = now;
    if (newStatus === 'CANCELLED')        timestamps.cancelledAt = now;

    const [updatedOrder] = await prisma.$transaction([
      prisma.order.update({
        where: { id: orderId },
        data: { status: newStatus as any, ...timestamps },
      }),
      prisma.orderStatusHistory.create({
        data: {
          orderId,
          fromStatus: fromStatus as any,
          toStatus: newStatus as any,
          reason: reason || null,
          changedBy: changedBy || null,
          changedAt: now,
        },
      }),
    ]);

    // 直接完成订单时，若商家开启了 item_completion_enabled，同步将所有 item 标为 READY
    if (newStatus === 'COMPLETED') {
      const config = await (prisma.merchantOnlineOrderConfig as any).findUnique({
        where: { merchantId: tenantId },
        select: { itemCompletionEnabled: true },
      });
      if ((config as any)?.itemCompletionEnabled) {
        const { markAllItemsReady } = await import('./order-item.service');
        await markAllItemsReady(orderId);
      }
    }

    logger.info(`Order status updated: ${orderId} ${fromStatus} -> ${newStatus}`);

    return {
      id: updatedOrder.id,
      status: updatedOrder.status,
      updatedAt: updatedOrder.updatedAt,
    };
  }

  /**
   * 释放到期的预约订单（SCHEDULED → CONFIRMED）
   * 由定时任务每分钟调用，提前 leadMinutes 分钟释放（默认 30 分钟）
   * 释放后自动打印 + 广播状态变更，不需要商家手动接单
   * 返回实际释放的订单数量
   */
  async releaseScheduledOrders(leadMinutes = 30): Promise<number> {
    const releaseThreshold = new Date(Date.now() + leadMinutes * 60 * 1000);

    // 找出所有 scheduledAt <= now + leadMinutes 且状态还是 SCHEDULED 的订单
    const due = await prisma.order.findMany({
      where: {
        status: 'SCHEDULED',
        isScheduled: true,
        scheduledAt: { lte: releaseThreshold },
      },
      include: {
        orderItems: { include: { orderItemModifiers: true } },
      },
    });

    if (due.length === 0) return 0;

    const now = new Date();

    // 预约配送单（Uber Direct）不能直接跳到 CONFIRMED——必须先真正建好配送单才行，
    // 释放到 PENDING，走跟非预约配送单一样的接单流程（弹窗/订单中心/自动接单 job）；
    // 其余类型（自取/堂食）维持原逻辑，直接跳到 CONFIRMED，无需商家接单
    const deliveryDue = due.filter(o => o.orderType === 'DELIVERY');
    const otherDue = due.filter(o => o.orderType !== 'DELIVERY');
    const AUTO_CONFIRM_DEADLINE_MINUTES = Number(process.env.AUTO_CONFIRM_DEADLINE_MINUTES) || 15;
    const deliveryDeadline = new Date(now.getTime() + AUTO_CONFIRM_DEADLINE_MINUTES * 60 * 1000);

    await prisma.$transaction([
      ...(otherDue.length > 0 ? [
        prisma.order.updateMany({
          where: { id: { in: otherDue.map(o => o.id) } },
          data: {
            status: 'CONFIRMED',
            releasedAt: now,
            scheduledConfirmedAt: now,
          },
        }),
      ] : []),
      ...(deliveryDue.length > 0 ? [
        prisma.order.updateMany({
          where: { id: { in: deliveryDue.map(o => o.id) } },
          data: {
            status: 'PENDING',
            releasedAt: now,
            deliveryConfirmDeadlineAt: deliveryDeadline,
          },
        }),
      ] : []),
      ...otherDue.map(o =>
        prisma.orderStatusHistory.create({
          data: {
            orderId: o.id,
            fromStatus: 'SCHEDULED',
            toStatus: 'CONFIRMED',
            reason: '系统自动释放：预约时间临近，自动确认',
            changedAt: now,
          },
        })
      ),
      ...deliveryDue.map(o =>
        prisma.orderStatusHistory.create({
          data: {
            orderId: o.id,
            fromStatus: 'SCHEDULED',
            toStatus: 'PENDING',
            reason: '系统自动释放：预约时间临近，等待接单（需先创建 Uber 配送单）',
            changedAt: now,
          },
        })
      ),
    ]);

    logger.info(`[ScheduledOrders] Released ${otherDue.length} → CONFIRMED, ${deliveryDue.length} delivery → PENDING`);

    // 为每个释放的订单触发打印 + 广播状态变更
    const { generatePrintTasksForOrder } = await import('../websocket/print-task-generator');
    const { dispatchPrintTasks } = await import('../websocket/print-task-dispatcher');
    const { broadcastDeliveryOrder } = await import('../websocket/print-task-dispatcher');

    for (const order of otherDue) {
      try {
        // 触发打印
        const tasks = await generatePrintTasksForOrder(
          { ...order, status: 'CONFIRMED' },
          order.tenantId,
          'WEB',
        );
        if (tasks.length > 0) {
          await dispatchPrintTasks(tasks, order.tenantId);
          logger.info(`[ScheduledOrders] 打印任务已分发`, { orderId: order.id });
        }
      } catch (err) {
        logger.warn(`[ScheduledOrders] 打印失败，不影响状态更新`, { orderId: order.id, err });
      }

      // 广播状态变更给 POS
      broadcastOrderStatusChanged(order.tenantId, {
        orderId: order.id,
        orderNumber: order.orderNumber,
        status: 'CONFIRMED',
        previousStatus: 'SCHEDULED',
        tenantId: order.tenantId,
      });
    }

    // 预约配送单释放到 PENDING：推一次接单弹窗通知（跟非预约配送单支付成功时的推送同一形状），
    // 不打印（配送单备餐完成才打印，不是接单这一步）
    for (const order of deliveryDue) {
      const deliveryAddress = order.deliveryAddress as any;
      if (!deliveryAddress) {
        logger.warn('[ScheduledOrders] 预约配送单缺少配送地址，跳过接单通知', { orderId: order.id });
        continue;
      }
      const items = (order.orderItems || []).map((item: any) => ({
        name: item.itemName,
        quantity: item.quantity,
      }));
      broadcastDeliveryOrder(order.tenantId, {
        orderId: order.id,
        orderNumber: order.orderNumber,
        tenantId: order.tenantId,
        customerName: order.customerName || '',
        customerPhone: order.customerPhone || '',
        dropoffAddress: deliveryAddress.fullAddress,
        items,
        createdAt: now.toISOString(),
        pickupNumber: order.pickupNumber ?? undefined,
      });
    }

    return due.length;
  }

  /**
   * 自动完成超时的预约订单
   * 取餐时间过后 graceMinutes 分钟（默认 10），仍处于非终态的预约单自动标记 COMPLETED。
   * 由定时任务每分钟调用（与 releaseScheduledOrders 共用同一个 tick）。
   */
  async autoCompleteOverdueScheduled(graceMinutes = 10): Promise<number> {
    const overdueThreshold = new Date(Date.now() - graceMinutes * 60 * 1000);

    const overdue = await prisma.order.findMany({
      where: {
        isScheduled: true,
        scheduledAt: { lte: overdueThreshold },
        status: { in: ['CONFIRMED', 'PREPARING', 'READY'] },
      },
    });

    if (overdue.length === 0) return 0;

    const now = new Date();

    await prisma.$transaction([
      ...overdue.flatMap(o => [
        prisma.order.update({
          where: { id: o.id },
          data: { status: 'COMPLETED', completedAt: now },
        }),
        prisma.orderStatusHistory.create({
          data: {
            orderId: o.id,
            fromStatus: o.status,
            toStatus: 'COMPLETED',
            reason: `系统自动完成：取餐时间已过 ${graceMinutes} 分钟`,
            changedAt: now,
          },
        }),
      ]),
    ]);

    logger.info(`[ScheduledOrders] Auto-completed ${overdue.length} overdue scheduled orders`);

    for (const order of overdue) {
      broadcastOrderStatusChanged(order.tenantId, {
        orderId: order.id,
        orderNumber: order.orderNumber,
        status: 'COMPLETED',
        previousStatus: order.status,
        tenantId: order.tenantId,
      });
    }

    return overdue.length;
  }

  /**
   * 自动完成超时的待取餐（READY）自取单
   * 叫号取餐场景：订单 READY 超过 graceMinutes 分钟（默认 5）仍未被店员标记完成的，
   * 自动标记 COMPLETED，避免订单永久卡在 READY。
   * 仅针对自取/堂食单（配送单 READY 要等骑手取，不能自动完成）。
   */
  async autoCompleteOverdueReady(graceMinutes = 5): Promise<number> {
    const threshold = new Date(Date.now() - graceMinutes * 60 * 1000);

    const overdue = await prisma.order.findMany({
      where: {
        status: 'READY',
        readyAt: { lte: threshold },
        orderType: { not: 'DELIVERY' },
        orderSource: { not: 'UBER_EATS' },
      },
    });

    if (overdue.length === 0) return 0;

    const now = new Date();

    await prisma.$transaction([
      ...overdue.flatMap(o => [
        prisma.order.update({
          where: { id: o.id },
          data: { status: 'COMPLETED', completedAt: now },
        }),
        prisma.orderStatusHistory.create({
          data: {
            orderId: o.id,
            fromStatus: o.status,
            toStatus: 'COMPLETED',
            reason: `系统自动完成：待取餐已过 ${graceMinutes} 分钟`,
            changedAt: now,
          },
        }),
      ]),
    ]);

    logger.info(`[AutoComplete] 自动完成 ${overdue.length} 个超时待取餐订单`);

    for (const order of overdue) {
      broadcastOrderStatusChanged(order.tenantId, {
        orderId: order.id,
        orderNumber: order.orderNumber,
        status: 'COMPLETED',
        previousStatus: 'READY',
        tenantId: order.tenantId,
      });
    }

    return overdue.length;
  }

  /**
   * 查询预约订单列表（供 POS/厨房展示当日预约单）
   */
  async getScheduledOrders(tenantId: string, date?: string) {
    // 按门店时区切天（回退 UTC）：先拿 IANA 时区 → 用 Intl 得到当天本地日期 → 转 UTC 边界
    const tz = await organizationService.getStoreTimezone(tenantId);
    let dayStart: Date;
    let dayEnd: Date;
    if (tz) {
      // 取门店当地"今天"的 YYYY-MM-DD（或用传入的 date）
      const localDate = date || new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
      // 用 Intl 把门店本地 00:00 和 23:59:59.999 转成 UTC（node 18+ 支持 timeZone 在 Date 解析不可靠，用偏移量计算）
      const refLocal = new Date(`${localDate}T12:00:00`); // 本地正午作为参考
      const utcStr = refLocal.toLocaleString('en-US', { timeZone: tz });
      const utcRef = new Date(utcStr);
      const offsetMs = refLocal.getTime() - utcRef.getTime(); // 本地 → UTC 偏移
      dayStart = new Date(new Date(`${localDate}T00:00:00`).getTime() + offsetMs);
      dayEnd = new Date(new Date(`${localDate}T23:59:59.999`).getTime() + offsetMs);
    } else {
      // 无门店时区，回退 UTC
      const targetDate = date ? new Date(date) : new Date();
      dayStart = new Date(targetDate);
      dayStart.setUTCHours(0, 0, 0, 0);
      dayEnd = new Date(targetDate);
      dayEnd.setUTCHours(23, 59, 59, 999);
    }

    return prisma.order.findMany({
      where: {
        tenantId,
        isScheduled: true,
        scheduledAt: { gte: dayStart, lte: dayEnd },
        status: { notIn: ['CANCELLED'] },
      },
      include: {
        orderItems: { include: { orderItemModifiers: true } },
      },
      orderBy: { scheduledAt: 'asc' },
    });
  }

  async cancelOrder(orderId: string, reason: string, tenantId: string) {
    const order = await prisma.order.findFirst({
      where: { id: orderId, tenantId },
    });

    if (!order) {
      throw new AppError(404, 'ORDER_NOT_FOUND', '订单不存在');
    }

    if (order.status === 'CANCELLED') {
      throw new AppError(400, 'ALREADY_CANCELLED', '订单已经被取消');
    }

    if (order.status === 'COMPLETED') {
      throw new AppError(400, 'CANNOT_CANCEL_COMPLETED', '已完成的订单无法取消');
    }

    const validReasons = ['MERCHANT_REQUEST', 'CUSTOMER_REQUEST', 'OUT_OF_STOCK', 'DUPLICATE_ORDER', 'PAYMENT_FAILED', 'SYSTEM_CANCEL'];
    const cancellationReason = validReasons.includes(reason) ? reason as any : 'MERCHANT_REQUEST';

    await prisma.order.update({
      where: { id: orderId },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancellationReason,
      },
    });

    logger.info(`Order cancelled: ${orderId}`, { cancellationReason });
  }

  /**
   * 根据 messageId 查找订单（用于幂等性检查）
   * 这个方法确保即使消息重复到达，也能识别并返回现有订单
   */
  async findOrderByMessageId(messageId: string, tenantId: string): Promise<any> {
    try {
      const order = await prisma.order.findFirst({
        where: {
          messageId: messageId,
          tenantId: tenantId,
        },
        include: {
          orderItems: { include: { orderItemModifiers: true } },
        },
      });

      if (order) {
        logger.info('✅ 幂等性命中：找到现有订单', {
          orderId: order.id,
          messageId,
          tenantId,
        });
      }

      return order;
    } catch (error) {
      logger.warn('⚠️ 查询 messageId 失败', {
        messageId,
        tenantId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return null;
    }
  }

  async getStatistics(startDate: string, endDate: string, tenantId: string) {
    const where: any = {
      tenantId,
      createdAt: {
        gte: new Date(startDate),
        lte: new Date(endDate),
      },
    };
    // 营收类指标剔除已取消订单，避免虚增营收
    const revenueWhere = { ...where, status: { not: 'CANCELLED' } };

    const [revenueAgg, ordersByStatus, ordersByType, ordersBySource, storeTimezone] =
      await Promise.all([
        prisma.order.aggregate({
          where: revenueWhere,
          _count: true,
          _sum: { totalAmount: true },
          _avg: { totalAmount: true },
        }),
        prisma.order.groupBy({
          by: ['status'],
          where,
          _count: true,
        }),
        prisma.order.groupBy({
          by: ['orderType'],
          where,
          _count: true,
        }),
        prisma.order.groupBy({
          by: ['orderSource'],
          where,
          _count: true,
        }),
        organizationService.getStoreTimezone(tenantId),
      ]);

    const totalOrders = revenueAgg._count;
    // totalAmount 单位为分，统一换算为元
    const totalRevenue = (revenueAgg._sum.totalAmount ?? 0) / 100;
    const averageOrderValue = (revenueAgg._avg.totalAmount ?? 0) / 100;

    const statusMap: Record<string, number> = {};
    ordersByStatus.forEach((item: any) => {
      statusMap[item.status] = item._count;
    });

    const typeMap: Record<string, number> = {};
    ordersByType.forEach((item: any) => {
      typeMap[item.orderType] = item._count;
    });

    const sourceMap: Record<string, number> = {};
    ordersBySource.forEach((item: any) => {
      sourceMap[item.orderSource] = item._count;
    });

    return {
      totalOrders,
      totalRevenue: parseFloat(totalRevenue.toFixed(2)),
      averageOrderValue: parseFloat(averageOrderValue.toFixed(2)),
      ordersByStatus: statusMap,
      ordersByType: typeMap,
      ordersBySource: sourceMap,
      storeTimezone,
    };
  }

  async getRevenueStatistics(
    startDate: string,
    endDate: string,
    tenantId: string,
    groupBy: 'day' | 'hour' | 'source' | 'type' | 'channel' = 'day'
  ) {
    const start = new Date(startDate);
    const end = new Date(endDate);
    const storeTimezone = await organizationService.getStoreTimezone(tenantId);

    const sumFields =
      'subtotal, tax_amount AS "taxAmount", discount_amount AS "discountAmount", ' +
      'service_fee AS "serviceFee", delivery_fee AS "deliveryFee", tip_amount AS "tipAmount", ' +
      'total_amount AS "totalAmount"';

    if (groupBy === 'hour') {
      // 按门店时区取"一天中第几小时"聚合（跨天累加），揭示营业高峰时段；无时区配置时按 UTC 兜底
      const tz = storeTimezone ?? 'UTC';
      const rows = await prisma.$queryRaw<any[]>`
        SELECT EXTRACT(HOUR FROM (created_at AT TIME ZONE 'UTC' AT TIME ZONE ${tz}))::int AS "hour",
          COUNT(*)::int AS "orderCount",
          SUM(subtotal)::int AS "subtotal",
          SUM(tax_amount)::int AS "taxAmount",
          SUM(discount_amount)::int AS "discountAmount",
          SUM(service_fee)::int AS "serviceFee",
          SUM(delivery_fee)::int AS "deliveryFee",
          SUM(tip_amount)::int AS "tipAmount",
          SUM(total_amount)::int AS "totalAmount"
        FROM orders
        WHERE tenant_id = ${tenantId}::uuid
          AND created_at >= ${start}
          AND created_at <= ${end}
          AND status != 'CANCELLED'
        GROUP BY 1
        ORDER BY 1
      `;
      return {
        storeTimezone,
        groupBy,
        rows: rows.map((r) => this.centsRowToYuan(r, ['hour', 'orderCount'])),
      };
    }

    if (groupBy === 'day') {
      const rows = await prisma.$queryRaw<any[]>`
        SELECT date_trunc('day', created_at) AS "bucket",
          COUNT(*)::int AS "orderCount",
          SUM(subtotal)::int AS "subtotal",
          SUM(tax_amount)::int AS "taxAmount",
          SUM(discount_amount)::int AS "discountAmount",
          SUM(service_fee)::int AS "serviceFee",
          SUM(delivery_fee)::int AS "deliveryFee",
          SUM(tip_amount)::int AS "tipAmount",
          SUM(total_amount)::int AS "totalAmount"
        FROM orders
        WHERE tenant_id = ${tenantId}::uuid
          AND created_at >= ${start}
          AND created_at <= ${end}
          AND status != 'CANCELLED'
        GROUP BY 1
        ORDER BY 1
      `;
      return {
        storeTimezone,
        groupBy,
        rows: rows.map((r) => this.centsRowToYuan(r, ['bucket', 'orderCount'])),
      };
    }

    const byField = groupBy === 'source' ? 'orderSource' : groupBy === 'type' ? 'orderType' : 'channelName';
    const grouped = await prisma.order.groupBy({
      by: [byField as any],
      where: {
        tenantId,
        createdAt: { gte: start, lte: end },
        status: { not: 'CANCELLED' },
      },
      _count: true,
      _sum: {
        subtotal: true,
        taxAmount: true,
        discountAmount: true,
        serviceFee: true,
        deliveryFee: true,
        tipAmount: true,
        totalAmount: true,
      },
    });

    return {
      storeTimezone,
      groupBy,
      rows: grouped.map((g: any) => ({
        key: g[byField] ?? 'UNKNOWN',
        orderCount: g._count,
        subtotal: (g._sum.subtotal ?? 0) / 100,
        taxAmount: (g._sum.taxAmount ?? 0) / 100,
        discountAmount: (g._sum.discountAmount ?? 0) / 100,
        serviceFee: (g._sum.serviceFee ?? 0) / 100,
        deliveryFee: (g._sum.deliveryFee ?? 0) / 100,
        tipAmount: (g._sum.tipAmount ?? 0) / 100,
        totalAmount: (g._sum.totalAmount ?? 0) / 100,
      })),
    };
  }

  async getItemStatistics(
    startDate: string,
    endDate: string,
    tenantId: string,
    page = 1,
    pageSize = 20
  ) {
    const start = new Date(startDate);
    const end = new Date(endDate);
    const offset = (page - 1) * pageSize;

    const rows = await prisma.$queryRaw<any[]>`
      SELECT oi.item_id AS "itemId", oi.item_name AS "itemName",
        SUM(oi.quantity)::int AS "quantity",
        SUM(oi.total_price)::int AS "totalPrice",
        SUM(oi.discount_amount)::int AS "discountAmount"
      FROM order_items oi
      INNER JOIN orders o ON o.id = oi.order_id
      WHERE o.tenant_id = ${tenantId}::uuid
        AND o.created_at >= ${start}
        AND o.created_at <= ${end}
        AND o.status != 'CANCELLED'
      GROUP BY oi.item_id, oi.item_name
      ORDER BY "totalPrice" DESC
      LIMIT ${pageSize} OFFSET ${offset}
    `;

    const totalRow = await prisma.$queryRaw<any[]>`
      SELECT COUNT(DISTINCT oi.item_id)::int AS "total"
      FROM order_items oi
      INNER JOIN orders o ON o.id = oi.order_id
      WHERE o.tenant_id = ${tenantId}::uuid
        AND o.created_at >= ${start}
        AND o.created_at <= ${end}
        AND o.status != 'CANCELLED'
    `;

    return {
      page,
      pageSize,
      total: totalRow[0]?.total ?? 0,
      rows: rows.map((r) => ({
        itemId: r.itemId,
        itemName: r.itemName,
        quantity: r.quantity,
        totalPrice: r.totalPrice / 100,
        discountAmount: r.discountAmount / 100,
      })),
    };
  }

  async getTaxStatistics(
    startDate: string,
    endDate: string,
    tenantId: string,
    groupBy: 'day' | 'source' | 'channel' = 'day'
  ) {
    const start = new Date(startDate);
    const end = new Date(endDate);
    const storeTimezone = await organizationService.getStoreTimezone(tenantId);
    const note =
      '税额为下单时按商品税率计算后写入订单的汇总值（Order.taxAmount），不含分税率明细拆分；已剔除已取消订单。';

    if (groupBy === 'day') {
      const rows = await prisma.$queryRaw<any[]>`
        SELECT date_trunc('day', created_at) AS "bucket",
          COUNT(*)::int AS "orderCount",
          SUM(subtotal)::int AS "taxableSales",
          SUM(tax_amount)::int AS "taxCollected"
        FROM orders
        WHERE tenant_id = ${tenantId}::uuid
          AND created_at >= ${start}
          AND created_at <= ${end}
          AND status != 'CANCELLED'
        GROUP BY 1
        ORDER BY 1
      `;
      return {
        storeTimezone,
        groupBy,
        note,
        rows: rows.map((r) => ({
          bucket: r.bucket,
          orderCount: r.orderCount,
          taxableSales: r.taxableSales / 100,
          taxCollected: r.taxCollected / 100,
        })),
      };
    }

    const byField = groupBy === 'source' ? 'orderSource' : 'channelName';
    const grouped = await prisma.order.groupBy({
      by: [byField as any],
      where: {
        tenantId,
        createdAt: { gte: start, lte: end },
        status: { not: 'CANCELLED' },
      },
      _count: true,
      _sum: { subtotal: true, taxAmount: true },
    });

    return {
      storeTimezone,
      groupBy,
      note,
      rows: grouped.map((g: any) => ({
        key: g[byField] ?? 'UNKNOWN',
        orderCount: g._count,
        taxableSales: (g._sum.subtotal ?? 0) / 100,
        taxCollected: (g._sum.taxAmount ?? 0) / 100,
      })),
    };
  }

  async getReconciliationStatistics(startDate: string, endDate: string, tenantId: string) {
    const start = new Date(startDate);
    const end = new Date(endDate);
    const storeTimezone = await organizationService.getStoreTimezone(tenantId);

    const grouped = await prisma.order.groupBy({
      by: ['paymentMethod', 'paymentStatus', 'settlementStatus'],
      where: {
        tenantId,
        createdAt: { gte: start, lte: end },
      },
      _count: true,
      _sum: { totalAmount: true, tipAmount: true },
    });

    return {
      storeTimezone,
      note:
        '本报表基于订单自身的支付/结算字段汇总（尚未对接 finance-service 的第三方支付平台结算记录），已取消订单单独列出而非剔除，用于核对取消/退款对营收的影响。',
      rows: grouped.map((g: any) => ({
        paymentMethod: g.paymentMethod ?? 'UNKNOWN',
        paymentStatus: g.paymentStatus,
        settlementStatus: g.settlementStatus ?? 'PENDING',
        orderCount: g._count,
        totalAmount: (g._sum.totalAmount ?? 0) / 100,
        tipAmount: (g._sum.tipAmount ?? 0) / 100,
      })),
    };
  }

  private centsRowToYuan(row: Record<string, any>, skipKeys: string[]) {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(row)) {
      out[k] = !skipKeys.includes(k) && typeof v === 'number' ? v / 100 : v;
    }
    return out;
  }

  /**
   * 通过 paymentIntentId 查询订单
   */
  async getOrderByPaymentIntent(paymentIntentId: string, merchantId: string) {
    const order = await prisma.order.findFirst({
      where: {
        paymentIntentId,
        tenantId: merchantId,
      },
      include: {
        orderItems: { include: { orderItemModifiers: true } },
      },
    });
    if (!order) return order;
    // 读时解析门店时区（null 时客户端回退本地时区）
    const storeTimezone = await organizationService.getStoreTimezone(merchantId);
    return { ...order, storeTimezone };
  }

  /**
   * 前端直接创建订单（备用路径，带支付验证）
   */
  // 从 snapshot 创建临时订单（用于支付前获取 orderId 和 orderNumber）
  async createTemporaryOrderFromSnapshot(data: {
    snapshotId: string;
    merchantId: string;
  }) {
    // 1. 获取 snapshot
    const snapshot = await prisma.checkoutSnapshot.findUnique({
      where: { id: data.snapshotId },
    });

    if (!snapshot) {
      throw new AppError('Snapshot not found', 404);
    }

    if (snapshot.status === 'USED' || snapshot.status === 'EXPIRED') {
      throw new AppError('Snapshot is no longer valid', 400);
    }

    // 2. 如果是记账渠道，提前校验授信额度（在创建订单前，失败不留脏数据）
    const snapshotPricing = snapshot.pricing as any;
    if (snapshotPricing?.channelConfigId) {
      await assertCreditAvailable(snapshot.merchantId, snapshotPricing.channelConfigId, snapshotPricing.total);
    }

    // 3. 生成订单号和取餐号（Web 订单支付已完成，直接分配）
    // 预约单按取餐日期分配取餐码，避免和取餐当天的其他订单序号冲突
    const scheduledAtDate = (snapshot as any).scheduledAt ? new Date((snapshot as any).scheduledAt) : undefined;
    let { orderNumber } = await this.generateOrderNumber(snapshot.merchantId, 'WEB');
    let { pickupNumber } = await this.generatePickupNumber(snapshot.merchantId, 'WEB', scheduledAtDate);

    // 查询会员 ID（有 consumerId 时才查询）
    const snapshotConsumerId = (snapshot as any).consumerId as string | undefined;
    const memberId = snapshotConsumerId ? await getMemberIdByConsumerId(snapshotConsumerId) : null;

    // 3. 创建临时订单（等待支付）
    // 预约单初始状态 SCHEDULED，普通单 PENDING
    const pricing = snapshot.pricing as any;
    const items = snapshot.items as any;
    const isScheduled = !!(snapshot as any).scheduledAt;
    const initialStatus = isScheduled ? 'SCHEDULED' : 'PENDING';

    // 系统UUID（用于自动创建的订单）
    const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';

    // 用 DB @unique 约束作为最终保障，碰撞时重新生成后缀重试
    let order: Awaited<ReturnType<typeof prisma.order.create>>;
    for (let attempt = 0; ; attempt++) {
      try {
        order = await prisma.order.create({
          data: {
            tenantId: snapshot.merchantId,
            orderNumber,
            pickupNumber,
            status: initialStatus,
            paymentStatus: 'UNPAID',
            isScheduled,
            scheduledAt: (snapshot as any).scheduledAt ?? null,
            orderType: snapshot.orderType as any,
            consumerId: (snapshot as any).consumerId || undefined,
            memberId: memberId || undefined,
            customerName: snapshot.customerName,
            customerPhone: snapshot.customerPhone,
            customerEmail: (snapshot as any).customerEmail || undefined,
            subtotal: pricing.subtotal,
            taxAmount: pricing.taxAmount,
            deliveryFee: pricing.deliveryFee || 0,
            uberDeliveryFee: pricing.uberDeliveryFee || 0,
            platformFee: pricing.platformFee,
            tipAmount: pricing.tipAmount,
            totalAmount: pricing.total,
            discountAmount: pricing.discountAmount || 0,
            discountType: pricing.grantedRewardId ? 'LOYALTY_REDEMPTION' : undefined,
            discountReason: pricing.grantedRewardId ? `GrantedReward:${pricing.grantedRewardId}` : undefined,
            channelDiscountAmount: pricing.channelDiscountAmount || 0,
            channelConfigId: pricing.channelConfigId || null,
            channelName: pricing.channelName || null,
            notes: snapshot.notes || undefined,
            customLabelData: (snapshot as any).customLabelData ?? undefined,
            deliveryAddress: (snapshot as any).deliveryAddress ?? undefined,
            orderSource: 'WEB',
            createdBy: SYSTEM_USER_ID,
            // 不设置 paymentIntentId，因为还没支付
            orderItems: {
              create: items.map((item: any) => {
                // 从快照中提取已验证的修饰符
                const modifierRecords: any[] = (item.verifiedModifiers || []).map((mod: any) => ({
                  groupName: mod.groupName,
                  optionName: mod.optionName,
                  optionCode: mod.optionCode || mod.code || undefined, // 提取打印代码
                  unitPrice: mod.unitPrice,
                  quantity: mod.quantity,
                  modifierGroupId: mod.groupId,
                  modifierOptionId: mod.optionId,
                }));

                return {
                  itemId: item.itemId,
                  itemName: item.itemName,
                  quantity: item.quantity,
                  unitPrice: parseInt(item.unitPrice, 10),
                  totalPrice: parseInt(item.unitPrice, 10) * item.quantity,
                  modifiers: null,  // 不再写 JSON，改用关系表
                  // 套餐行：comboId 标记这行是套餐，comboSelections 快照当时选中的子项（供收据/厨房显示）
                  ...(item.isCombo && {
                    comboId: item.comboId,
                    comboSelections: item.comboSelections ?? null,
                  }),
                  ...(modifierRecords.length > 0 && {
                    orderItemModifiers: {
                      create: modifierRecords,
                    },
                  }),
                };
              }),
            },
          },
          include: {
            orderItems: { include: { orderItemModifiers: true } },
          },
        });
        break;
      } catch (e) {
        if (attempt < 4 && this.isOrderNumberConflict(e)) {
          logger.warn('createTemporaryOrderFromSnapshot 订单号碰撞，重新生成后缀', { attempt, orderNumber });
          orderNumber = this.buildCandidateOrderNumber(snapshot.merchantId, 'WEB');
          continue;
        }
        throw e;
      }
    }

    // 将 orderId 写回快照，建立关联（支付完成后用于标记 USED）
    await prisma.checkoutSnapshot.update({
      where: { id: data.snapshotId },
      data: {
        orderId: order.id,
      },
    });

    // 发出事件：分析等副作用由 handler 处理
    eventBus.emit({
      type: 'TEMPORARY_ORDER_CREATED',
      eventId: uuidv4(),
      timestamp: new Date(),
      tenantId: snapshot.merchantId,
      orderId: order.id,
      orderNumber: order.orderNumber,
      snapshotId: data.snapshotId,
      snapshotItems: items,
      order,
      skipModifiers: true,
    });

    return {
      id: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
    };
  }

  /**
   * 更新订单支付状态（服务间调用，来自 Finance Service）
   * PATCH /api/order/v1/orders/:orderId/payment-status
   */
  async updatePaymentStatus(data: {
    orderId: string;
    tenantId: string;
    paymentStatus: 'PAID' | 'UNPAID' | 'PARTIALLY_PAID' | 'REFUNDED' | 'FAILED';
    paymentIntentId?: string;
    paymentMethod?: string;
    /** Finance Service 的支付记录 ID */
    paymentId?: string;
    /** 外部支付 ID（Stripe paymentIntentId / Clover externalPaymentId / CASH-xxx） */
    externalPaymentId?: string;
    /** 小费金额（分） */
    tipAmount?: number;
    /** 实际支付总金额（分，含 tip） */
    totalAmount?: number;
    /** 支付提供商 */
    provider?: string;
  }) {
    const result = await prisma.$transaction(async (tx) => {
      // 1. 查询订单（验证存在性和权限）
      const order = await tx.order.findFirst({
        where: { id: data.orderId, tenantId: data.tenantId },
      });

      if (!order) {
        throw new AppError(404, 'ORDER_NOT_FOUND', '订单不存在或无权限');
      }

      // 2. 幂等性检查：如果已经是目标状态，直接返回
      if (order.paymentStatus === data.paymentStatus) {
        logger.info(`[UpdatePaymentStatus] 订单已处于目标状态，跳过更新`, {
          orderId: data.orderId,
          currentStatus: order.paymentStatus,
        });
        return {
          id: order.id,
          orderNumber: order.orderNumber,
          paymentStatus: order.paymentStatus,
          message: '订单支付状态已是目标状态',
        };
      }

      // 3. 验证状态转换合法性
      const allowedTransitions: Record<string, string[]> = {
        UNPAID: ['PAID', 'PARTIALLY_PAID', 'FAILED'],
        PARTIALLY_PAID: ['PAID', 'REFUNDED'],
        PAID: ['REFUNDED'],  // 已支付只能退款，不能降级
        FAILED: ['PAID', 'UNPAID'],
        REFUNDED: [],
      };

      const allowed = allowedTransitions[order.paymentStatus] || [];
      if (!allowed.includes(data.paymentStatus)) {
        throw new AppError(
          400,
          'INVALID_STATUS_TRANSITION',
          `不允许从 ${order.paymentStatus} 转换为 ${data.paymentStatus}`
        );
      }

      // 4. 准备更新数据
      const updateData: any = { paymentStatus: data.paymentStatus };

      // 如果状态变为 REFUNDED，同步将订单状态改为 CANCELLED
      if (data.paymentStatus === 'REFUNDED') {
        updateData.status = 'CANCELLED';
        updateData.cancelledAt = new Date();
        updateData.cancellationReason = 'MERCHANT_REQUEST' as any;
      }

      // 如果状态变为 PAID，设置相关字段
      if (data.paymentStatus === 'PAID') {
        updateData.paidAt = order.paidAt || new Date();
        if (data.paymentIntentId && !order.paymentIntentId) {
          updateData.paymentIntentId = data.paymentIntentId;
        }
        /*
          支付方式以 finance 传来的为准，**覆盖**建单时那个值。

          原来是 `&& !order.paymentMethod`（只在为空时写），而 POS 建 PENDING 订单
          时必须先给一个值才能拿到 orderId —— 那时候还没收钱，只能猜：
          礼品卡那条路径直接写死 CASH，主路径是「非现金一律 CARD」。
          于是这个字段永远停在占位值上：礼品卡单显示成现金、自定义方式显示成刷卡、
          组合支付显示成其中某一种。

          标 PAID 这一刻 finance 才知道整单实际是怎么付的（POS 会把订单级方式
          一路传过来），此时它比建单时的猜测更可信，应当覆盖。
          注意只在 PAID 分支里覆盖 —— 别的状态变更不带这个信息。
        */
        if (data.paymentMethod) {
          updateData.paymentMethod = data.paymentMethod;
        }
        // 记录 Finance Service 的支付 ID（存入 transactionId 字段）
        if (data.externalPaymentId && !order.transactionId) {
          updateData.transactionId = data.externalPaymentId;
        }
        // 补写小费并同步进 totalAmount，统一口径为「含 tip 的实付总额」
        // POS(Clover) 场景：tip 在下单后于设备上输入，建单时 order.tipAmount=0 且 totalAmount 不含 tip，
        // 此处把 tip 补进 totalAmount，使其与 finance payment.amount(含tip) 及 Web 口径一致。
        // Web 订单建单即含 tip(order.tipAmount>0)，跳过避免重复累加。
        if (data.tipAmount !== undefined && data.tipAmount > 0 && (order.tipAmount ?? 0) === 0) {
          const tipCents = Math.round(data.tipAmount);
          updateData.tipAmount = tipCents;
          updateData.totalAmount = order.totalAmount + tipCents;
        }
        // 从快照补写折扣字段（临时订单创建时可能未写入）
        if (!order.discountAmount || order.discountAmount === 0) {
          const snap = await tx.checkoutSnapshot.findFirst({
            where: { orderId: data.orderId },
            select: { pricing: true },
          });
          const snapPricing = snap?.pricing as any;
          if (snapPricing?.discountAmount > 0) {
            updateData.discountAmount = snapPricing.discountAmount;
            updateData.discountType = snapPricing.grantedRewardId ? 'LOYALTY_REDEMPTION' : undefined;
            updateData.discountReason = snapPricing.grantedRewardId
              ? `GrantedReward:${snapPricing.grantedRewardId}`
              : undefined;
          }
        }
        // 订单状态自动转换
        if (order.status === 'PENDING') {
          // 检查叫号屏模式
          const pickupConfig = await tx.pickupNumberConfig.findUnique({ where: { tenantId: order.tenantId } });
          const queueDisplayOn = pickupConfig?.queueDisplayEnabled ?? false;

          // POS 订单 & Web 非配送非预约订单：支付即完成（叫号屏未开启时）
          const autoComplete =
            !queueDisplayOn && (
              order.orderSource === 'POS' ||
              (order.orderSource === 'WEB' && order.orderType !== 'DELIVERY' && !order.isScheduled)
            );

          // Uber Direct 配送单：支付成功后必须停在 PENDING 等接单，
          // 不能在这里自动推到 CONFIRMED——CONFIRMED 只能由 confirmDeliveryOrder 在
          // 真正建好 Uber 配送单后联动写入（否则 POS 界面会显示"备餐中"但实际没人接过单，
          // 接单按钮也因为状态不是 PENDING 而消失，订单卡死）
          const isUberDelivery = order.orderSource === 'WEB' && order.orderType === 'DELIVERY';

          if (autoComplete) {
            updateData.status = 'COMPLETED';
            updateData.completedAt = new Date();
          } else if (!isUberDelivery) {
            updateData.status = 'CONFIRMED';
          }
          // isUberDelivery: 不改 status，保持 PENDING
        }
        // 生成取餐号（仅在首次标 PAID 且尚未分配时）
        if (!order.pickupNumber) {
          const { pickupNumber, pickupDisplay } = await this.generatePickupNumber(order.tenantId, order.orderSource);
          updateData.pickupNumber = pickupNumber;
          // pickupDisplay 由 formatPickupDisplay 实时计算，不存数据库，通过事件传递
          (updateData as any)._pickupDisplay = pickupDisplay; // 临时附加，事务后使用
        }
      }

      // 5. 执行更新（从 updateData 中提取临时字段，避免传入 Prisma）
      const { _pickupDisplay: pickupDisplayTemp, ...prismaUpdateData } = updateData as any;
      const updatedOrder = await tx.order.update({
        where: { id: data.orderId },
        data: prismaUpdateData,
      });

      // 6. 查询关联快照（事务内查询保证一致性，供事务外事件使用）
      let snapshot: any = null;
      if (data.paymentStatus === 'PAID') {
        snapshot = await tx.checkoutSnapshot.findFirst({
          where: { orderId: data.orderId },
        });
      }

      logger.info(`[UpdatePaymentStatus] 订单支付状态已更新`, {
        orderId: data.orderId,
        orderNumber: order.orderNumber,
        oldStatus: order.paymentStatus,
        newStatus: data.paymentStatus,
      });

      return {
        id: updatedOrder.id,
        orderNumber: updatedOrder.orderNumber,
        pickupNumber: updatedOrder.pickupNumber,
        pickupDisplay: pickupDisplayTemp ?? null,
        paymentStatus: updatedOrder.paymentStatus,
        status: updatedOrder.status,
        paidAt: updatedOrder.paidAt,
        message: '订单支付状态已成功更新',
        // 事务内数据，传递给事务外事件
        _meta: {
          previousStatus: order.status,
          orderSource: order.orderSource,
          orderType: order.orderType,
          snapshot,
          memberId: updatedOrder.memberId ?? null,
          subtotal: updatedOrder.subtotal,
          totalAmount: updatedOrder.totalAmount,
          pickupDisplay: pickupDisplayTemp ?? null,
          discountReason: updatedOrder.discountReason ?? null,
          discountType: updatedOrder.discountType ?? null,
          discountAmount: updatedOrder.discountAmount ?? 0,
          channelDiscountAmount: updatedOrder.channelDiscountAmount ?? 0,
          paymentMethod: updatedOrder.paymentMethod ?? null,
        },
      };
    });

    // 事务成功后处理副作用
    // 退款完成：广播订单状态变更给 POS（CANCELLED）
    if (data.paymentStatus === 'REFUNDED') {
      broadcastOrderStatusChanged(data.tenantId, {
        orderId: data.orderId,
        orderNumber: result.orderNumber,
        status: 'CANCELLED',
        previousStatus: (result as any)._meta?.previousStatus,
        tenantId: data.tenantId,
      });
    }

    // 支付成功：发出 ORDER_PAID 事件（snapshot 标记、打印、配送等由 handler 处理）
    if (data.paymentStatus === 'PAID') {
      // grantedRewardId / discountAmount 优先从快照 pricing 读(Web 流程),
      // 没快照时(POS 同步流程) fallback 从 order 自身 discountReason / discountAmount 解析,
      // 否则 POS 订单的积分折扣不会进 finance 的账本。
      const snapshotPricing = (result as any)._meta.snapshot?.pricing as any;
      const _dr: string | null = (result as any)._meta.discountReason;
      const grantedRewardId = snapshotPricing?.grantedRewardId
        || (_dr && _dr.startsWith('GrantedReward:') ? _dr.slice('GrantedReward:'.length) : null);

      eventBus.emit({
        type: 'ORDER_PAID',
        eventId: uuidv4(),
        timestamp: new Date(),
        tenantId: data.tenantId,
        orderId: data.orderId,
        orderNumber: result.orderNumber,
        clientOrigin: (result as any)._meta.orderSource,
        orderSource: (result as any)._meta.orderSource,
        orderType: (result as any)._meta.orderType,
        previousStatus: (result as any)._meta.previousStatus,
        paymentIntentId: data.paymentIntentId,
        snapshot: (result as any)._meta.snapshot,
        memberId: (result as any)._meta.memberId,
        subtotal: (result as any)._meta.subtotal,
        discountAmount: (result as any)._meta.discountAmount,
        channelDiscountAmount: (result as any)._meta.channelDiscountAmount,
        totalAmount: (result as any)._meta.totalAmount,
        paymentMethod: (result as any)._meta.paymentMethod,
        grantedRewardId,
      });

      // 自动完成的订单(POS / Web 非配送非预约)同步 emit ORDER_COMPLETED。
      // 此路径绕过了 status.service.onOrderCompleted，否则 POS 订单永远不会触发
      // member.handler 的 ORDER_COMPLETED 监听 → 会员积分入账丢失。
      if (result.status === 'COMPLETED') {
        // 从 discountReason 解析 grantedRewardId(POS / 同步流程不走 snapshot,
        // 会员券 ID 是用 'GrantedReward:<id>' 这种 reason 字符串带过来的)
        const _dr: string | null = (result as any)._meta.discountReason;
        const _grId = _dr && _dr.startsWith('GrantedReward:') ? _dr.slice('GrantedReward:'.length) : null;
        eventBus.emit({
          type: 'ORDER_COMPLETED',
          eventId: uuidv4(),
          timestamp: new Date(),
          tenantId: data.tenantId,
          orderId: data.orderId,
          orderNumber: result.orderNumber,
          memberId: (result as any)._meta.memberId,
          subtotal: (result as any)._meta.subtotal,
          discountAmount: (result as any)._meta.discountAmount,
          channelDiscountAmount: (result as any)._meta.channelDiscountAmount,
          totalAmount: (result as any)._meta.totalAmount,
          clientOrigin: (result as any)._meta.orderSource,
          paymentStatus: 'PAID',
          paymentMethod: (result as any)._meta.paymentMethod,
          grantedRewardId: _grId,
        });
      }

      // 统一折扣账本分录路由:不管是会员券折扣、员工手动整单/单品折扣还是 comp,
      // 只要 discountAmount > 0 就要进账本(分别走 6300 LoyaltyDiscount / 6310 ManualDiscount 科目)。
      const discountAmount = snapshotPricing?.discountAmount
        || (result as any)._meta.discountAmount
        || 0;
      const discountType: string | null = (result as any)._meta.discountType ?? null;
      const discountReason: string | null = (result as any)._meta.discountReason ?? null;
      if (discountAmount > 0) {
        if (discountType === 'LOYALTY_REDEMPTION' || grantedRewardId) {
          notifyLoyaltyDiscount({
            tenantId: data.tenantId,
            orderId: data.orderId,
            discountAmount,
            grantedRewardId: grantedRewardId ?? undefined,
          }).catch(() => {});
        } else {
          // MANUAL / null / 其它类型 → 都归到员工手动折扣
          notifyManualDiscount({
            tenantId: data.tenantId,
            orderId: data.orderId,
            discountAmount,
            reason: discountReason ?? undefined,
          }).catch(() => {});
        }
      }
    }

    return {
      id: result.id,
      orderNumber: result.orderNumber,
      pickupNumber: result.pickupNumber,
      pickupDisplay: result.pickupDisplay,
      paymentStatus: result.paymentStatus,
      status: result.status,
      paidAt: result.paidAt,
      message: result.message,
    };
  }

  /**
   * 免支付确认订单（total = 0 的订单，如全额兑换 reward）
   * POST /web/confirm-free-order
   * 统一走 updatePaymentStatus 路径，避免重复逻辑
   */
  /**
   * 渠道记账下单：无需在线支付，直接标记为 ACCOUNT 应收账款
   */
  async confirmAccountOrder(data: {
    orderId: string;
    merchantId: string;
    channelId?: string;    // OrderSourceConfig.id
    channelName?: string;
  }) {
    const order = await prisma.order.findFirst({
      where: { id: data.orderId, tenantId: data.merchantId },
    });

    if (!order) {
      throw new AppError('Order not found', 404);
    }

    const updated = await prisma.order.update({
      where: { id: data.orderId },
      data: {
        paymentMethod: 'ACCOUNT',
        paymentStatus: 'PAID',
        status: 'CONFIRMED',
        paidAt: new Date(),
        // 记录渠道信息，用于额度追踪和结算报表
        channelConfigId: data.channelId ?? undefined,
        channelName: data.channelName ?? undefined,
      },
    });

    // 通知财务服务记应收账款（non-blocking）
    notifyOrderPaid({
      paymentMethod: 'ACCOUNT',
      tenantId: data.merchantId,
      orderId: data.orderId,
      orderNumber: updated.orderNumber,
      totalAmount: updated.totalAmount,
      subtotal: updated.subtotal,
      channelDiscountAmount: updated.channelDiscountAmount,
      taxAmount: updated.taxAmount,
      channelId: data.channelId ?? null,
      channelName: data.channelName ?? null,
    }).catch(() => {});

    return updated;
  }

  async confirmFreeOrder(data: {
    orderId: string;
    merchantId: string;
  }) {
    // 验证订单总金额确实为 0
    const order = await prisma.order.findFirst({
      where: { id: data.orderId, tenantId: data.merchantId },
    });

    if (!order) {
      throw new AppError('Order not found', 404);
    }

    if (order.totalAmount !== 0) {
      throw new AppError('Order total is not zero, payment required', 400);
    }

    // 不覆盖 paymentMethod —— 保留收银员实际点的(可能是 CASH/CARD,POS UI 强制选)。
    // 区分"免单"与"现金"靠 totalAmount === 0 + discountReason 这两个字段,不靠 paymentMethod。
    return this.updatePaymentStatus({
      orderId: data.orderId,
      tenantId: data.merchantId,
      paymentStatus: 'PAID',
    });
  }

  /**
   * 查询消费者自己的订单历史（Consumer JWT 认证）
   * GET /consumer/orders
   */
  async getConsumerOrders(consumerId: string, options: { page?: number; limit?: number }) {
    const page = options.page || 1;
    const limit = Math.min(options.limit || 10, 50);
    const skip = (page - 1) * limit;

    const [orders, total] = await prisma.$transaction([
      prisma.order.findMany({
        where: { consumerId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          tenantId: true,
          orderNumber: true,
          pickupNumber: true,
          orderType: true,
          orderSource: true,
          status: true,
          paymentStatus: true,
          totalAmount: true,
          subtotal: true,
          taxAmount: true,
          tipAmount: true,
          customerName: true,
          customerPhone: true,
          notes: true,
          isScheduled: true,
          scheduledAt: true,
          createdAt: true,
          confirmedAt: true,
          completedAt: true,
          cancelledAt: true,
          orderItems: {
            select: {
              id: true,
              itemId: true,
              itemName: true,
              quantity: true,
              unitPrice: true,
              totalPrice: true,
            },
          },
        },
      }),
      prisma.order.count({ where: { consumerId } }),
    ]);

    // 读时解析门店时区：顾客订单可能跨多个门店，按租户去重后逐一解析（org.service 内部缓存）
    const tenantIds = [...new Set(orders.map((o) => o.tenantId))];
    const tzEntries = await Promise.all(
      tenantIds.map(async (tid) => [tid, await organizationService.getStoreTimezone(tid)] as const),
    );
    const tzMap = new Map(tzEntries);
    const ordersWithTz = orders.map((o) => ({ ...o, storeTimezone: tzMap.get(o.tenantId) ?? null }));

    return {
      data: ordersWithTz,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * 消费者查询单个订单详情（Consumer JWT 认证）
   * 校验订单归属，附带商品规格/加料明细 + 退款记录
   */
  async getConsumerOrderDetail(orderId: string, consumerId: string) {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        tenantId: true,
        consumerId: true,
        orderNumber: true,
        pickupNumber: true,
        orderType: true,
        orderSource: true,
        status: true,
        subtotal: true,
        taxAmount: true,
        discountAmount: true,
        serviceFee: true,
        deliveryFee: true,
        platformFee: true,
        tipAmount: true,
        totalAmount: true,
        discountType: true,
        discountReason: true,
        paymentStatus: true,
        paymentMethod: true,
        paidAt: true,
        customerName: true,
        customerPhone: true,
        notes: true,
        isScheduled: true,
        scheduledAt: true,
        createdAt: true,
        confirmedAt: true,
        completedAt: true,
        cancelledAt: true,
        deliveryAddress: true,
        orderItems: {
          select: {
            id: true,
            itemId: true,
            itemName: true,
            quantity: true,
            unitPrice: true,
            totalPrice: true,
            discountAmount: true,
            discountReason: true,
            specialNotes: true,
            orderItemModifiers: {
              select: {
                id: true,
                groupName: true,
                optionName: true,
                unitPrice: true,
                quantity: true,
              },
            },
          },
        },
      },
    });

    if (!order) {
      throw new AppError('订单不存在', 404);
    }
    if (order.consumerId !== consumerId) {
      // 不透露"订单存在但不属于你"，统一按不存在处理
      throw new AppError('订单不存在', 404);
    }

    const [storeTimezone, refunds] = await Promise.all([
      organizationService.getStoreTimezone(order.tenantId),
      getRefundsByOrderId(order.id),
    ]);

    return { ...order, storeTimezone, refunds };
  }

}

export default new OrderService();
