import prisma from '../utils/prisma';
import { pickupNumberConfigService } from './print-setting.service';
import { IN_STORE_PICKUP_TYPES } from './fulfillment-option.service';
import { AppError } from '../middleware/errorHandler';
import { runWithIdempotency, fingerprintOf } from './idempotency.service';
import { toE164 } from '../utils/phone';
import { sanitizeTaxLines, sanitizeItemTaxLines } from './tax-lines';
import { calcChannelDiscount } from './channel-discount';
import { sumSupplySubtotal } from './supply-line';
import { getConsumerIdByMemberId } from '../utils/member-client';
import { enqueueEvent } from './outbox.service';
import logger from '../utils/logger';
import { assertCreditAvailable } from './credit.service';
import { v4 as uuidv4, v7 as uuidv7 } from 'uuid';
import { eventBus } from '../events';
import { getMemberIdByConsumerId, validateGrantedRewardForMember, parseGrantedRewardId } from '../utils/member-client';
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
  /**
   * 税额按税种拆开的明细：`[{ name, rate, amount }]`（amount 单位分）。
   *
   * POS 一直算得出（utils/taxCalculation 的 taxBreakdown），原来没发上来 ——
   * 于是日结单只能印一个税额合计，而加拿大申报要按税种分别填。
   * 不传就是没有，报表退回只印合计那一行（存量订单都是这样）。
   */
  taxLines?: Array<{ name: string; rate: number; amount: number }>;
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
  /// 分类快照，厨房单的分类级路由用（见 OrderItem.categoryId）
  categoryId?: string | null;
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

  /**
   * 这一行自己的税种明细 `[{ name, rate, amount }]`（分）。
   * 落 order_items.tax_lines，用于事后核账和按行退税（见那一列的说明）。
   * 全部行的和必须等于整单 taxAmount，否则整单丢掉（sanitizeItemTaxLines）。
   */
  taxLines?: Array<{ name: string; rate: number; amount: number }>;

  /*
    耗材行（餐具 / 购物袋 / 打包费）。itemId 存的是 catalog_supplies.id，
    落库时写 lineKind=SUPPLY —— 报表的「按商品」正是按这个过滤的，
    不写的话打包袋会混进热销榜。

    Web 端走 createTemporaryOrderFromSnapshot 时早就有这两个字段了，
    POS 这条路径一直没有：商家配的 AUTO 规则（如每单收 $0.25 袋子费）
    Web 单收得到、POS 单一分收不到。
  */
  isSupply?: boolean;
  /** auto = 按商家规则自动加的，selected = 员工手动加的 */
  supplyOrigin?: 'auto' | 'selected';
}

interface CreateOrderData {
  orderType: 'DINE_IN' | 'TAKEOUT' | 'DELIVERY' | 'CURBSIDE' | 'DRIVE_THRU';
  /**
   * 谁负责配送。**只在 orderType=DELIVERY 时有意义**，别的类型传了会被忽略。
   *
   * 不传时按 MERCHANT 落库 —— 本店自有渠道（Web / POS）下的配送单默认是
   * 本店安排骑手（Uber Direct）。平台代收的单必须**显式**传 PLATFORM，
   * 否则会被 watchdog / 自动接单当成自配送单捞走。
   */
  deliveryProvider?: 'MERCHANT' | 'PLATFORM';
  clientOrigin?: 'POS' | 'WEB' | 'KIOSK';
  /** 开这一单的 POS 设备码。决定某张票是本地打还是转交给别的设备 */
  deviceId?: string;
  tableNumber?: string;
  customerName?: string;
  customerPhone?: string;
  /** 离线补传：这单的小票已经印出去了且没有取餐号，别再补发一个 */
  skipPickupNumber?: boolean;
  memberId?: string;  // 会员 ID（可选，匿名订单不设置）
  items: CreateOrderItem[];
  notes?: string;

  // 预约自取
  isScheduled?: boolean;    // 是否为预约订单
  scheduledAt?: string;     // 预约取餐时间（ISO 8601）

  // 费用相关
  taxAmount?: number;
  /**
   * 税额按税种拆开的明细：`[{ name, rate, amount }]`（amount 单位分）。
   *
   * POS 一直算得出（utils/taxCalculation 的 taxBreakdown），原来没发上来 ——
   * 于是日结单只能印一个税额合计，而加拿大申报要按税种分别填。
   * 不传就是没有，报表退回只印合计那一行（存量订单都是这样）。
   */
  taxLines?: Array<{ name: string; rate: number; amount: number }>;
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

  /**
   * 客户端生成的订单主键（UUIDv7）。传了就用它，不传服务端自己生成。
   *
   * 为什么允许客户端定主键：POS 是**先收钱后建单**的，收钱那一刻订单在后端
   * 还不存在。有了客户端 id，这一单在收款之前就有了稳定身份 ——
   *   · finance 可以立刻挂账，不必干等 order-service 恢复
   *   · 接联机卡支付时能把它写进 PaymentIntent 的 metadata，
   *     POS 中途崩溃后靠它反查那笔到底成没成
   *   · 补传重发天然幂等（见下面的重放检查），不会像以前那样重复建单
   * UUID 本身不需要任何协调，所以这件事没有代价。
   */
  id?: string;

  /**
   * 客户端生成的订单号。不传则服务端按老规则发（前缀 + 4 位随机）。
   *
   * POS 本地发号的格式是 `门店码+营业日+渠道码+设备码+本机当日序号`，
   * 唯一性靠**设备码做号段隔离**（设备码由 auth-service 激活时分配，门店内唯一），
   * 不靠随机 —— 服务端那套 4 位随机在 1000 单/天 的门店撞号概率 31%，
   * 服务端撞了能重摇，本地撞了不能（小票已打）。
   *
   * 服务端这边只做两件事：格式校验 + 唯一性兜底（DB 的 @unique）。
   * **不校验设备码归属** —— order-service 看不到设备清单（那在 auth-service），
   * 硬要校验就得跨服务查询，为一个已经由号段结构保证的东西加一次网络往返不划算。
   */
  orderNumber?: string;

  /**
   * 客户端记录的**下单时间**（ISO 8601），只有离线补传才需要传。
   *
   * 不传 = 实时下单，createdAt 用服务端 now()。
   * 传了 = 这单是离线时收的，用它作为业务时间（报表/对账口径），
   * 服务端另把收到的时刻记进 receivedAt。
   * 会做时钟校验，见 resolvePlacedAt。
   */
  clientCreatedAt?: string;
}

/** 客户端时间最多允许早于现在多少天 —— 超过就当作时钟错乱，不采信 */
const CLIENT_TIME_MAX_AGE_DAYS = 7;
/** 允许的未来偏差：设备时钟快几分钟是常态，超过就不采信 */
const CLIENT_TIME_MAX_SKEW_MS = 5 * 60 * 1000;

/**
 * 决定这一单的业务时间（createdAt）和落库时间（receivedAt）。
 *
 * 设备时钟不可信：能被人改，也会自己漂。一台时钟错乱的收银机如果能随意指定
 * 下单时间，就能把销售额记到任意一天，报表和对账都会被污染。
 * 所以客户端的值要过两道闸 —— 不能是未来（允许 5 分钟时钟快），
 * 不能早于 7 天（离线再久也不该超过这个量级，超了多半是时钟坏了）。
 *
 * 不采信时**不丢弃**，原样记进 claimedCreatedAt：出了争议要查得到它当时报了什么。
 */
function resolvePlacedAt(clientCreatedAt: string | undefined, now: Date): {
  createdAt?: Date;
  receivedAt: Date | null;
  claimedCreatedAt: Date | null;
} {
  if (!clientCreatedAt) {
    // 实时下单：createdAt 交给数据库默认值，receivedAt 留空（两者本来就相等，没必要冗余）
    return { createdAt: undefined, receivedAt: null, claimedCreatedAt: null };
  }

  const claimed = new Date(clientCreatedAt);
  const valid =
    !Number.isNaN(claimed.getTime()) &&
    claimed.getTime() <= now.getTime() + CLIENT_TIME_MAX_SKEW_MS &&
    claimed.getTime() >= now.getTime() - CLIENT_TIME_MAX_AGE_DAYS * 24 * 3600 * 1000;

  if (!valid) {
    logger.warn('[Order] 客户端下单时间未通过校验，退回服务端时间', {
      clientCreatedAt, now: now.toISOString(),
    });
    return {
      createdAt: undefined,
      receivedAt: now,
      claimedCreatedAt: Number.isNaN(claimed.getTime()) ? null : claimed,
    };
  }

  return { createdAt: claimed, receivedAt: now, claimedCreatedAt: null };
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

export /**
 * 建单请求的指纹。
 *
 * 只取**影响结果**的字段，且和数组顺序无关。
 *
 * ⚠️ 绝不能对整个请求体做 hash。补传每一轮带的 `clientCreatedAt` 是同一个值，
 * 但将来只要有任何一个「每次都不同」的字段混进来（重试次数、时间戳、
 * 设备当前状态…），每一次正常重发都会变成「指纹不符」→ 被当成撞键拒绝，
 * 而那一单的钱**已经收了**。所以这里是白名单，不是黑名单。
 *
 * 取的这几项和它替代的那套判据同源（明细、金额、订单类型），只是更精确：
 * 原来只比条数和总额，两个不同的单凑巧同额同数就会被判成同一单。
 */
const createOrderFingerprint = (data: CreateOrderData): string =>
  fingerprintOf({
    orderType: data.orderType ?? null,
    clientOrigin: data.clientOrigin ?? null,
    // 排序后再进指纹：同一批商品换个顺序传，仍然是同一单
    items: (data.items ?? [])
      .map((it: any) => [
        String(it.itemId ?? ''),
        Number(it.quantity ?? 1),
        Math.round(Number(it.unitPrice ?? 0)),   // 和落库时同样取整，避免浮点尾数
      ].join(':'))
      .sort(),
  });

class OrderService {
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

  /**
   * 订单号里的渠道码：只给人扫一眼看出单从哪来，**不参与唯一性**
   * （唯一性靠设备码做号段隔离）。
   *
   * ⚠️ 这张表在**两个仓库**里各有一份，加客户端类型时必须一起改，否则
   * 同一种客户端会出现两个码（POS 发 `M01`、这边发 `X00`），
   * 订单号从此不一致而且没人报错 —— 兜底值是 'X'，静默降级。
   *
   * 要一起改的三处：
   *   1. 这里
   *   2. POS `src/services/localOrderNumber.ts` 的 ORIGIN_CODE
   *   3. POS 探针 `scripts/touch-probe/local-order-number.mjs` 的格式正则（写死了 [PWKUX]）
   *
   * 本文件 validators/order.validator.ts 里的正则用的是 `[A-Z]`，不用动。
   *
   * 注意：这和店家可配置的「销售渠道」（OrderSourceConfig / salesChannelId）
   * 是两回事 —— 那个后台随时能加，这个是写死的客户端类型枚举。
   */
  private static readonly ORIGIN_PREFIX_CODE: Record<string, string> = {
    POS: 'P',
    WEB: 'W',
    KIOSK: 'K',
    UBER_EATS: 'U',
  };

  /**
   * base34 字符集：去掉 I/O 避免与 1/0 混淆。
   * 和 POS 的 localOrderNumber.ts 必须**保持一致** —— 两边发的号进同一列。
   *
   * 注：老的「4 位随机后缀」发号方式已停用（那套靠概率，实测 1000 单/天
   * 撞号 31%、2000 单/天 78%）。现在这个字符集只用于把当日秒数编成 base34。
   */
  private static readonly SUFFIX_CHARS = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ';

  /**
   * 服务端的设备码。POS/Kiosk 的码由 auth-service 分配（门店内唯一），
   * `00` 保留给**服务端自己建的单**（Web 预约、外卖平台）—— 它们不属于任何一台设备，
   * 但也要占一个不与设备冲突的号段。
   */
  private static readonly SERVER_DEVICE_CODE = '00';

  /** 数字 → 定长 base34。34⁴ = 1,336,336，装 86400 秒绰绰有余 */
  private toBase34(n: number, width = 4): string {
    const chars = OrderService.SUFFIX_CHARS;
    let out = '';
    let v = n;
    for (let i = 0; i < width; i++) {
      out = chars[v % chars.length] + out;
      v = Math.floor(v / chars.length);
    }
    return out;
  }



  /**
   * 生成一个订单号。**和 POS 本地发号同一套格式**：
   *
   *     260817-W00-2F7Q
   *     ──────  ─ ──  ────
   *     营业日  渠道 设备 当日秒数(base34)
   *
   * 服务端是 Web/外卖单的唯一写入方，设备码固定 `00`。
   * 同一秒内多单靠 `+1 借下一秒`（和 POS 同构），撞了还有 DB 唯一约束兜底。
   *
   * 老格式（`门店码+日期+渠道+4位随机`，15 位）已停用 —— 那套靠概率，
   * 实测 1000 单/天 撞号概率 31%，所以才有下面那段重摇逻辑。新格式靠结构。
   */
  private lastSlot: { date: string; slot: number } | null = null;

  buildCandidateOrderNumber(_tenantId: string, clientOrigin: string): string {
    const now = new Date();
    const yymmdd = `${now.getFullYear() % 100}`.padStart(2, '0')
      + `${now.getMonth() + 1}`.padStart(2, '0')
      + `${now.getDate()}`.padStart(2, '0');
    const secondOfDay = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();

    // 同秒借下一秒（进程内即可：重启后时钟已经往前走了）
    if (!this.lastSlot || this.lastSlot.date !== yymmdd) {
      this.lastSlot = { date: yymmdd, slot: secondOfDay };
    } else {
      this.lastSlot.slot = secondOfDay > this.lastSlot.slot ? secondOfDay : this.lastSlot.slot + 1;
    }

    const originCode = OrderService.ORIGIN_PREFIX_CODE[clientOrigin] ?? 'X';
    return `${yymmdd}-${originCode}${OrderService.SERVER_DEVICE_CODE}-${this.toBase34(this.lastSlot.slot)}`;
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
    const pickupDisplay = pickupNumberConfigService.formatPickupDisplay(
      pickupNumber, clientOrigin, config.showPrefix, config.channelPrefixes,
    );
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

  /**
   * 建单。带 `id` 时走幂等保护（见 idempotency.service）。
   *
   * 幂等键就是客户端生成的 `orders.id` —— POS 在收钱之前就有它，
   * 补传每一轮都用同一个，所以它天然是这次建单的唯一身份。
   *
   * 不带 id 的（WEB / UberEats）行为不变：那些渠道不会重发同一单。
   */
  async createOrder(data: CreateOrderData, userId: string, tenantId: string, token?: string, messageId?: string) {
    if (!data.id) {
      return this.createOrderInner(data, userId, tenantId, token, messageId);
    }
    const { result } = await runWithIdempotency(
      tenantId,
      'orders.create',
      data.id,
      createOrderFingerprint(data),
      () => this.createOrderInner(data, userId, tenantId, token, messageId),
    );
    return result;
  }

  private async createOrderInner(data: CreateOrderData, userId: string, tenantId: string, token?: string, messageId?: string) {
    try {
      const clientOrigin = data.clientOrigin || 'POS';

      // 验证数据
      if (!data.items || data.items.length === 0) {
        throw new AppError(400, 'INVALID_ITEMS', '订单必须包含至少一个商品');
      }

      /*
        ★ 兜底的重放检查。**正常路径已经不会走到这里** —— 幂等键表在更外层
        就把重发挡掉并回放了原始响应（见 createOrder / idempotency.service）。

        留着它是为了两种键记录不在的情况：
          · 幂等记录过了 TTL（24 小时）才收到重发
          · 老数据：这套上线之前建的单
        这两种下面这段仍然是对的 —— 因为今天订单建好就不会变。
        **等以后支持加菜时，这段必须删掉**：那时它会把正常重发误判成撞车。
        届时 TTL 内的重发由幂等表处理，超出 TTL 的应当直接按主键冲突拒绝。

        POS 的补传是「发出去 → 没收到回应 → 下一轮再发」，而"没收到回应"
        和"对方没收到"是两回事：请求可能已经落库了，只是响应在路上丢了。
        没有这道检查的话，那一单会被建**两次** —— 而且两次都是有效订单，
        事后极难分辨哪个是重复的（这个坑之前踩过，当时靠修快照覆盖的 bug
        缓解了，但只要再有一次重发就会复现）。

        直接返回已有的那单，调用方拿到的响应和第一次成功时**完全一样**，
        所以它不需要知道自己是不是在重放。这就是幂等的意义。
      */
      if (data.id) {
        const replay = await prisma.order.findUnique({
          where: { id: data.id },
          // 要比对内容，所以连明细一起取。只在重放时才走到这里，代价可忽略
          include: { orderItems: { select: { quantity: true, unitPrice: true } } },
        });
        if (replay) {
          if (replay.tenantId !== tenantId) {
            // 同一个 id 出现在别的租户名下：不是重放，是撞了或者越权，必须拒
            throw new AppError(409, 'ORDER_ID_CONFLICT', '订单 ID 已被占用');
          }

          /*
            ★ 区分「重发」和「id 撞车」。

            真正的重发内容必然**一模一样**（同一单发第二次）；
            id 撞车则必然不一样（不同顾客、不同商品、不同金额）。
            不比对的话，撞车会**静默返回别人的订单** —— 第二单凭空消失、
            它的钱记到第一单头上、第一单变成 OVERPAID，而调用方以为成功了。
            那比直接报错糟得多。

            这就是 Stripe 幂等键的做法：
            "compares incoming parameters to those of the original request
             and errors if they're not the same to prevent accidental misuse"

            比对项挑的是「不同的单几乎不可能全部相同」又「重发必然相同」的几项：
            明细条数、各项金额之和、订单类型。不做全量比对是因为
            服务端会重算价格、补默认值，全量比反而会把正常重发误判成撞车。
          */
          const incomingGross = (data.items ?? []).reduce(
            (sum, it: any) => sum + (it.unitPrice ?? 0) * (it.quantity ?? 1), 0);
          const existingGross = replay.orderItems.reduce(
            (sum, it) => sum + it.unitPrice * it.quantity, 0);
          const looksLikeSameOrder =
            replay.orderItems.length === (data.items?.length ?? 0)
            && existingGross === incomingGross
            && replay.orderType === data.orderType;

          if (!looksLikeSameOrder) {
            logger.error('[Order] 订单 ID 撞车：内容与已有订单不符，拒绝并要求换 ID 重试', {
              orderId: data.id,
              已有: { 条数: replay.orderItems.length, 金额: existingGross, 类型: replay.orderType },
              本次: { 条数: data.items?.length ?? 0, 金额: incomingGross, 类型: data.orderType },
            });
            throw new AppError(409, 'ORDER_ID_COLLISION',
              '订单 ID 与另一笔订单冲突，请用新 ID 重试');
          }

          logger.info('[Order] 重放建单请求，返回已有订单', {
            orderId: replay.id, orderNumber: replay.orderNumber,
          });
          return {
            id: replay.id,
            orderNumber: replay.orderNumber,
            pickupNumber: replay.pickupNumber ?? null,
            pickupDisplay: replay.pickupNumber != null ? String(replay.pickupNumber) : null,
            status: replay.status,
            totalAmount: replay.totalAmount,
            paymentStatus: replay.paymentStatus,
            paymentMethod: replay.paymentMethod,
            memberId: replay.memberId,
            createdAt: replay.createdAt,
          };
        }
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
      /** 耗材（餐具/购物袋/打包费）小计。它不参与任何折扣，要从折扣基数里扣掉 */
      let supplySubtotal = 0;
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
          // 耗材不参与任何折扣，单独记一份供渠道折扣扣除（见 calcChannelDiscount 的调用）
          if (item.isSupply) supplySubtotal += totalPrice;

          return {
            itemId: item.itemId,
            itemName: item.itemName,
            categoryId: item.categoryId ?? null,   // 分类快照，厨房单路由用
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
            // 行级税种明细。**先原样带着**，下面按整单税额统一校验后再定去留
            taxLines: item.taxLines ?? null,

            /*
              耗材行：itemId 是 catalog_supplies.id 而不是 catalog_items.id，
              靠 lineKind 区分（默认 PRODUCT）。和 Web 那条路径
              （createTemporaryOrderFromSnapshot）写的是同一组字段。
            */
            ...(item.isSupply && {
              lineKind: 'SUPPLY' as const,
              supplyOrigin: item.supplyOrigin ?? null,
            }),
          };
        });
      }

      // 提取费用字段（POS/KIOSK 可信来源，使用前端传来的值）
      const taxAmount = data.taxAmount || 0;

      /*
        行级税种明细统一校验：所有行加起来必须等于整单税额，否则**整单**丢掉。
        留半份最危险 —— 拿它做部分退款时剩下的行看着是齐的，税却少一块。
        校验放在这里而不是构造每行时：判据是整单的和，得先把行都算完。
      */
      if (orderItems) {
        const verified = sanitizeItemTaxLines(
          orderItems.map((it: any) => it.taxLines),
          Math.round(taxAmount),
        );
        orderItems.forEach((it: any, i: number) => { it.taxLines = verified[i] ?? null; });
      }
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
        /*
          基数 = 小计 − 耗材 − 整单折扣，且必须和 POS 算出同一个数。
          耗材是按份收的成本转嫁，不拿来做促销 —— 三种折扣一律不碰它
          （POS 侧同规则，见 CheckoutScreen 的 discountableSubtotal）。
        */
        channelDiscountAmount = calcChannelDiscount(
          rules?.orderDiscount,
          Math.max(0, subtotal - supplySubtotal),
          orderLevelDiscount,
        );

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
      /*
        订单号：客户端给了就用它（POS 本地发号，见 CreateOrderData.orderNumber），
        没给才服务端生成。

        下面那段 catch(P2002) 重摇后缀的重试**只对服务端生成的号有意义** ——
        客户端的号已经印在小票上了，重摇等于让顾客手里那张作废。
        所以客户端号撞了要直接报错，让上层知道，而不是偷偷换一个。
      */
      const clientProvidedNumber = !!data.orderNumber;
      let orderNumber = data.orderNumber
        || (await this.generateOrderNumber(tenantId, clientOrigin)).orderNumber;
      /** 客户端声称的号没能用上时留在这里（撞号降级），便于顾客拿小票来查 */
      let claimedOrderNumber: string | null = null;

      // 记账模式直接标为 PAID（无需即时收款，finance-service 后续追踪账期）
      // 其他模式统一 UNPAID，支付完成由 Finance Service 回调更新
      // ACCOUNT = 渠道记账；PLATFORM = 外卖平台已代收；两者均直接标为 PAID
      const isAccountPayment = data.paymentMethod === 'ACCOUNT'
        || channelConfig?.checkoutMode === 'CREDIT_ACCOUNT';
      const isPlatformCollect = data.paymentMethod === 'PLATFORM'
        || (channelConfig?.platformType != null && channelConfig.platformType !== '');
      const paymentStatus = (isAccountPayment || isPlatformCollect) ? 'PAID' : 'UNPAID';
      const paidAt: Date | null = (isAccountPayment || isPlatformCollect) ? new Date() : null;

      /*
        建单状态。**建单即 PAID 的两类单，状态必须在这里定死**——
        它们的钱不经过我们的收单通道，finance 里没有对应 payment，
        于是永远等不到支付回调（updatePaymentStatus），而 PENDING → CONFIRMED/
        COMPLETED 的自动推进全寄生在那个回调里。

        平台代收单（isPlatformCollect）之前已经修过，落 COMPLETED。
        **记账单（isAccountPayment）当时漏了**，一直卡在「待确认」——
        它同样建单即 PAID、同样等不到回调，只是没人发现。

        记账单不能照抄 COMPLETED：平台单是骑手取走就完了，而记账单是顾客
        在店里挂账消费，**餐还要做**。所以走和「现金单支付成功」一样的判断：
        叫号屏开着就进队列等叫号（CONFIRMED），关着就支付即完成（COMPLETED）。
        这段判断和 updatePaymentStatus 里的 autoComplete 是同一套语义，
        改一边记得改另一边。
      */
      let initialStatus: 'SCHEDULED' | 'COMPLETED' | 'CONFIRMED' | 'PENDING';
      if (data.isScheduled) {
        initialStatus = 'SCHEDULED';
      } else if (isPlatformCollect) {
        initialStatus = 'COMPLETED';
      } else if (isAccountPayment) {
        const pickupCfg = await pickupNumberConfigService.getConfig(tenantId);
        initialStatus = pickupCfg.queueDisplayEnabled ? 'CONFIRMED' : 'COMPLETED';
      } else {
        initialStatus = 'PENDING';
      }

      // 业务时间 / 落库时间。离线补传单会带 clientCreatedAt，实时下单不带
      const placedAt = resolvePlacedAt(data.clientCreatedAt, new Date());


      // POS 订单在建单时就生成取餐号，无需等待 Finance 回调
      // 取餐号不是稀缺资源，少量废单不影响运营
      let posPickupNumber: number | null = null;
      let posPickupDisplay: string | null = null;
      /*
        ★ 离线补传的单不发取餐号。

        小票是**离线那一刻**打的，上面没有号（本地发不出来：取餐号要原子自增、
        不能有空洞）。补传时如果照常发一个，就成了「顾客手里那张没号、系统里有号」——
        店员照着叫，叫的是顾客不知道的号。和上面 orderNumber 那段是同一个形状的坑。

        字段可空、消费方（叫号屏、配送 handler、小票模板）都做了空处理，
        所以「没有号」本来就是合法状态，不需要任何兜底。
      */
      if (clientOrigin === 'POS' && !data.skipPickupNumber) {
        const pickup = await this.generatePickupNumber(tenantId, clientOrigin);
        posPickupNumber = pickup.pickupNumber;
        posPickupDisplay = pickup.pickupDisplay;
      }

      /*
        建单前解析会员绑定的 consumer。放在事务**外面** ——
        网络调用不该占着数据库连接。失败返回 null，不影响建单。
      */
      const resolvedConsumerId = data.memberId
        ? await getConsumerIdByMemberId(data.memberId)
        : null;

      // 用 DB @unique 约束作为最终保障，碰撞时重新生成后缀重试（极小概率）
      let order: Awaited<ReturnType<typeof prisma.order.create>>;
      for (let attempt = 0; ; attempt++) {
        try {
          /*
            ★ 订单和「要发的通知」写在同一个事务里。

            原来是 create 提交之后再 eventBus.emit —— 进程在这中间挂掉，
            订单在库里、打印/统计/叫号屏一个都没收到，而且之后再也不会重试。
            这道缝没法靠"重试几次"补上：改库和发通知是两个系统，
            唯一的办法是让通知本身变成同一笔数据库写入的一部分。
          */
          order = await prisma.$transaction(async (tx) => {
          const created = await tx.order.create({
            data: {
              // 订单主键用 UUID v7（时间有序），改善高频写入时的索引局部性；
              // 仍是标准 128-bit UUID，与 @db.Uuid 列和现有 v4 老数据完全兼容
              // 客户端给了就用它（上面已确认这个 id 还没被占用）
              id: data.id || uuidv7(),
              tenantId,
              orderNumber,
              // POS 订单建单时就分配取餐号；其他来源在支付成功时生成
              pickupNumber: posPickupNumber,
              messageId: messageId || null,  // 保存 messageId 用于幂等性检查
              orderType: data.orderType,
              /*
                只有配送单才有「谁来送」。不传按 MERCHANT —— 本店渠道下的
                配送单默认自己安排骑手；平台代收的单要显式传 PLATFORM，
                否则会被 watchdog / 自动接单当成自配送单捞走。
              */
              deliveryProvider: data.orderType === 'DELIVERY'
                ? (data.deliveryProvider ?? 'MERCHANT')
                : null,
              orderSource: clientOrigin,
              /*
                开这一单的 POS 设备码。用来判断「这单的某张票，下单那台机
                自己能不能打」—— 见 print-task-ownership.ts。
                只有 POS 会传；老版本不传，服务端按旧行为处理。
              */
              deviceId: data.deviceId || null,
              tableNumber: data.tableNumber || null,
              customerName: data.customerName || null,
              // 统一成 E.164 存；解析不出就原样保留（见 utils/phone）
              customerPhone: toE164(data.customerPhone),
              memberId: data.memberId || null,
              /*
                会员绑定的 consumer 账号。POS 只给 memberId，这里反查一次补上 ——
                consumer app 的订单列表按 consumer_id 查，不落这一列，
                这笔单在顾客自己的订单记录里就永远看不到。
                拿不到（服务不可达 / 纯线下会员没绑账号）就留空，读取侧会自愈。
              */
              consumerId: resolvedConsumerId,
              channelConfigId: data.salesChannelId || null,
              channelName: channelConfig?.sourceName || null,

              // 金额明细（分，整数）
              subtotal: Math.round(subtotal),
              taxAmount: Math.round(taxAmount),
              /*
                税种明细。**校验后才存** —— 各行加起来必须等于 taxAmount，
                对不上就当没有（宁可日结单退回只印合计，也不能印一组
                自己加不平的税额，那比没有更糟：店主会拿它去申报）。
              */
              /* `?? undefined` 而不是留 null：Prisma 的 Json 字段不接受
                 JS 的 null（要 Prisma.JsonNull），而「不写这个字段」
                 和「写 DB NULL」在这里是同一个意思 —— 都表示没有明细 */
              /* as any：Prisma 的 InputJsonValue 不接受具名接口数组（索引签名不匹配），
                 值本身已经被 sanitizeTaxLines 验过形状和加总 */
              taxLines: (sanitizeTaxLines(data.taxLines, Math.round(taxAmount)) ?? undefined) as any,
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

              /*
                时间三件套。实时下单时 createdAt 走数据库默认值（undefined 即不写），
                另两列为 null；离线补传时 createdAt = 客户端的下单时间，
                receivedAt = 服务端收到的时刻。见 resolvePlacedAt。
              */
              ...(placedAt.createdAt ? { createdAt: placedAt.createdAt } : {}),
              receivedAt: placedAt.receivedAt,
              claimedCreatedAt: placedAt.claimedCreatedAt,
              claimedOrderNumber,

              cashierId: userId,  // 收银员就是创建订单的用户
              cashierName: data.cashierName || null,                       // 收银员姓名快照
              cashierEmployeeNumber: data.cashierEmployeeNumber || null,   // 收银员工号快照

              // 预约自取
              isScheduled: data.isScheduled || false,
              scheduledAt: data.isScheduled && data.scheduledAt ? new Date(data.scheduledAt) : null,
              /*
                预约订单初始状态为 SCHEDULED，普通订单为 PENDING。

                ★ 平台代收渠道（内置外卖 UBER_EATS / DOORDASH / ... 见 sales-channel.service）
                是**手工记账入口** —— 我们还没接这些平台的 API，商家在 POS 上补录一笔
                平台那边已经收完钱、也已经在做的单，只为留个记录和对账，店里不走备餐流程。

                这类单建单即 PAID（见上面 isPlatformCollect），钱不经过我们的收单通道，
                finance 里没有对应 payment，于是**永远等不到支付回调**；
                而 PENDING → CONFIRMED/COMPLETED 的自动推进全寄生在那个回调里
                （updatePaymentStatus），结果订单永远卡在「待确认」。所以这里直接落 COMPLETED。

                挂账（checkoutMode=CREDIT_ACCOUNT）**也在此列**。这里原来写着
                「它有独立的结算接口会写 CONFIRMED，不在此列」—— 那个机制不存在：
                markOrdersCreditSettled 只写 creditSettledAt，全仓没有任何地方
                把记账单推出 PENDING。于是记账单和平台单一样永久卡在「待确认」，
                只是没人发现。现在它按叫号屏配置落 CONFIRMED / COMPLETED，
                见上面 initialStatus 那段。
              */
              status: initialStatus,
              completedAt: initialStatus === 'COMPLETED' ? new Date() : null,

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

          /*
            ★ 会员券核销，走**发件箱**。

            挂账 / 平台单建单即 PAID（见 isAccountPayment 那段），从不走
            updatePaymentStatus —— ORDER_PAID 对这类单从来不发，
            member.handler 里那两支核销都轮不到它们。

            为什么不在事务外直接 fetch：那是 fire-and-forget，
            member-service 那一刻不可达就永久丢了，而券漏核销意味着
            同一张券能被反复使用，每次都真金白银少收一笔。
            写进发件箱就和订单同生共死，投递失败由 relay 退避重试。

            为什么不补发一个 ORDER_PAID：那会顺带唤醒打印、配送、finance
            一串 handler，它们在建单流程里已经各自做过了。

            只对**建单即已付**的单发。UNPAID 的单等收款时走 ORDER_PAID 那支。
          */
          if (paymentStatus === 'PAID' && created.memberId) {
            const _useGrId = parseGrantedRewardId(data.discountReason);
            if (_useGrId) {
              await enqueueEvent(tx, {
                type: 'COUPON_USE_REQUESTED',
                eventId: uuidv4(),
                timestamp: new Date(),
                tenantId,
                orderId: created.id,
                orderNumber: created.orderNumber,
                grantedRewardId: _useGrId,
              });
            }
          }

          // 和上面的 create 同一个事务：要么订单和通知都在，要么都不在
          await enqueueEvent(tx, {
            type: 'ORDER_CREATED',
            eventId: uuidv4(),
            timestamp: new Date(),
            tenantId,
            orderId: created.id,
            orderNumber: created.orderNumber,
            clientOrigin,
            orderType: data.orderType,
            paymentStatus,
            items: data.items,
            order: created,
          } as any);

          /*
            建单即完成的（平台代收记账单）要补一个 ORDER_COMPLETED。

            和支付回调里那段是同一个坑：member.handler 的积分入账挂在
            ORDER_COMPLETED 上，只发 ORDER_CREATED 的话这类单的会员积分永远不入账。
            走 enqueueEvent 而不是 eventBus.emit —— 和订单同事务，投递交给 outbox relay，
            比支付回调那边的同步 emit 更稳（见本文件上方「别在这里补一次 emit」那段注释）。
          */
          if (created.status === 'COMPLETED') {
            // 会员券 ID 是用 'GrantedReward:<id>' 这种 reason 字符串带过来的（POS 同步流程不走 snapshot）
            const dr = data.discountReason;
            const grantedRewardId = dr && dr.startsWith('GrantedReward:')
              ? dr.slice('GrantedReward:'.length)
              : null;
            await enqueueEvent(tx, {
              type: 'ORDER_COMPLETED',
              eventId: uuidv4(),
              timestamp: new Date(),
              tenantId,
              orderId: created.id,
              orderNumber: created.orderNumber,
              memberId: created.memberId,
              subtotal: created.subtotal,
              // 耗材不计积分，用建单时已经算好的那份，不用再查一次
              supplySubtotal,
              discountAmount: created.discountAmount,
              channelDiscountAmount: created.channelDiscountAmount,
              totalAmount: created.totalAmount,
              clientOrigin,
              paymentStatus: created.paymentStatus,
              // 钱是平台代收的，不是店里收的 —— 和下面 notifyOrderPaid 的 pm 同一个口径。
              // created.paymentMethod 是 POS 建单时猜的（可能是 CASH/CARD），不可信
              paymentMethod: 'PLATFORM',
              grantedRewardId,
            } as any);
          }

          return created;
          });
          break;
        } catch (e) {
          if (this.isOrderNumberConflict(e) && clientProvidedNumber && attempt < 4) {
            /*
              客户端给的号撞了 → **服务端自己发一个，照常建单**，把客户端声称的号
              记进 claimedOrderNumber 留痕。

              ⚠️ 这里曾经写的是抛 409，那是错的：补传每一轮都会撞上同一个号，
              于是这单**永远建不成** —— 钱收了却没有订单，finance 也记不了账
              （拿不到 orderId）。为了"号好看"把问题升级成了"钱悬空"。

              和 clientCreatedAt 同一条通则：**收银台上凡是客户端提供的可疑数据，
              一律降级 + 留痕，绝不用拒绝请求来处理** —— 钱已经收了，拒绝只会让钱悬空。
              代价是小票上的号和系统不一致，但那是极罕见的双重故障
              （号段隔离 + 时钟守卫都失效）下的可接受降级，而且有 claimedOrderNumber 可查。
            */
            logger.error('客户端订单号已存在，改用服务端发号并留痕', { orderNumber, tenantId });
            claimedOrderNumber = orderNumber;
            orderNumber = this.buildCandidateOrderNumber(tenantId, clientOrigin);
            continue;
          }
          if (attempt < 4 && this.isOrderNumberConflict(e)) {
            // 服务端自己生成的号撞了（4 位随机，概率不低）：重摇后缀
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

      /*
        这里原来有一次 eventBus.emit('ORDER_CREATED')。已经挪进上面建单的事务里
        （enqueueEvent），由 relay 负责投递 —— 见 outbox.service。
        **别在这里补一次 emit**：那样每个 handler 会跑两遍。
      */

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
  async getOrderByIdInternal(idOrNumber: string, tenantId?: string) {
    // id 是 Postgres UUID 列，直接拿非 UUID 字符串按 id 查会导致数据库报错，
    // 所以只有输入是合法 UUID 时才按 id 匹配，否则只按订单号匹配
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrNumber);
    const match = isUuid
      ? { OR: [{ id: idOrNumber }, { orderNumber: idOrNumber }] }
      : { orderNumber: idOrNumber };

    /*
      ★ 按订单号查必须消歧。

      订单号只保证**门店内**唯一（schema 的 `@@unique([tenantId, orderNumber])`），
      两个组织同一秒、同一设备码各开一单就会拿到一模一样的号。

      这里原来是 `findFirst` 且没有 orderBy —— 重号时 Postgres 按自己的扫描顺序
      给第一条，返回的那单金额、商品、状态全都自洽，只是可能属于另一家店，
      排查的人看不出来。而 admin-bff 会拿这一条的 id 当 resolvedOrderId 再去查
      finance / member / Loki，于是整条链路视图**一致地**指向错的组织
      （见 transactionAggregator.getTransactionView）。

      所以：命中多条就报 409 并带上候选，让调用方指定 tenantId，
      或者直接拿候选里的 id 重查 —— 那是主键，全平台唯一，没有歧义。
      按 id 查的路径不受影响。

      take: 3 —— 只为判断"有没有歧义"和列出候选。重号是罕见路径，
      正常只有一条，开销和原来的 findFirst 一样。
    */
    const orders = await prisma.order.findMany({
      where: tenantId ? { AND: [match, { tenantId }] } : match,
      include: {
        orderItems: { include: { orderItemModifiers: true } },
        orderNotes: { orderBy: { createdAt: 'desc' } },
        analytics: true,
      },
      take: 3,
    });

    if (orders.length === 0) {
      throw new AppError(404, 'ORDER_NOT_FOUND', '订单不存在');
    }

    if (orders.length > 1) {
      // 组织名让运营一眼能选（organizationService 有 5 分钟缓存，候选只有两三条）
      const candidates = await Promise.all(orders.map(async (o) => ({
        orderId: o.id,
        tenantId: o.tenantId,
        orgName: (await organizationService.getOrganization(o.tenantId))?.orgName ?? null,
        orderNumber: o.orderNumber,
        createdAt: o.createdAt,
        totalAmount: o.totalAmount,
      })));
      logger.warn('[Internal] 订单号跨组织重号，要求调用方消歧', {
        orderNumber: idOrNumber,
        tenantIds: candidates.map((c) => c.tenantId),
      });
      throw new AppError(
        409,
        'ORDER_NUMBER_AMBIGUOUS',
        `订单号 ${idOrNumber} 在多个组织下都存在，请指定 tenantId，或改用候选中的订单 id 查询`,
        { candidates },
      );
    }

    const order = orders[0];
    const storeTimezone = await organizationService.getStoreTimezone(order.tenantId);
    return { ...order, storeTimezone };
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
    /* 停在 PENDING 等接单的只有**本店自配送**单：平台单没有「确认备餐」这一步，
       跟其它单一样直接 CONFIRMED 即可 */
    const deliveryDue = due.filter(o => o.deliveryProvider === 'MERCHANT');
    const otherDue = due.filter(o => o.deliveryProvider !== 'MERCHANT');
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
        // 同 autoCompleteOverdueReady：钱没收齐的单不自动完成
        paymentStatus: 'PAID',
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
   * 仅针对顾客在店内等餐的单。配送单 READY 要等骑手取；路边取餐的顾客
   * 可能还在开过来的路上，自动完成会变成「系统显示已完成、餐还没送出去」。
   */
  async autoCompleteOverdueReady(graceMinutes = 5): Promise<number> {
    const threshold = new Date(Date.now() - graceMinutes * 60 * 1000);

    const overdue = await prisma.order.findMany({
      where: {
        status: 'READY',
        readyAt: { lte: threshold },
        // 白名单：新履约方式不会默认获得「超时自动完成」这个行为
        orderType: { in: [...IN_STORE_PICKUP_TYPES] },
        orderSource: { not: 'UBER_EATS' },
        /*
          钱没收齐的单不自动完成。

          组合支付收到一半中断（PARTIALLY_PAID）的单照样会被推到 READY ——
          餐做好了是一回事，钱收没收齐是另一回事。让它自动 COMPLETED 等于
          把一张欠款单悄悄归档：订单管理里那颗「继续收款」只对非终态单出现，
          单一完成就再也收不回来了。

          精确匹配 PAID 而不是「排除 UNPAID/PARTIALLY_PAID」：REFUNDED 的单
          也不该被自动完成 —— 退了款该走取消，不是完成。
        */
        paymentStatus: 'PAID',
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

    /*
      ★ 取消订单 + 退回会员券，**同一个事务**。

      这单没做成，顾客不该白搭一张券 —— POS 上的取消基本都是店家发起的
      （缺货、做错了、点错了）。有效期由 member-service 按「被占用的时长」
      补偿，见那边的 computeRestoredExpiry。

      退券走发件箱而不是直接 fetch：后者是 fire-and-forget，
      member-service 那一刻不可达就永久丢了。写进同一个事务之后，
      订单被取消 ⟺ 退券任务一定在板上，投递失败由 relay 退避重试。

      只在**整单取消**这条路上退。部分退款不退 —— 那笔交易还在，
      折扣已经体现在里面了。
    */
    const grId = parseGrantedRewardId(order.discountReason);
    await prisma.$transaction(async (tx) => {
      await tx.order.update({
        where: { id: orderId },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          cancellationReason,
        },
      });

      if (grId) {
        await enqueueEvent(tx, {
          type: 'COUPON_RESTORE_REQUESTED',
          eventId: uuidv4(),
          timestamp: new Date(),
          tenantId,
          orderId,
          orderNumber: order.orderNumber,
          grantedRewardId: grId,
        });
      }

      /*
        积分冲正。只有真给了钱才该有积分 —— 钱退了分不收回就能反复刷。

        条件是**曾经付过款**：UNPAID 的单本来就没加过分，发了也是空跑
        （member-service 会返回 lot_not_found）。挂账单同理，它压根不计积分。
      */
      if (order.memberId && order.paymentStatus === 'PAID' && order.paymentMethod !== 'ACCOUNT') {
        await enqueueEvent(tx, {
          type: 'POINTS_REVERSE_REQUESTED',
          eventId: uuidv4(),
          timestamp: new Date(),
          tenantId,
          orderId,
          orderNumber: order.orderNumber,
          memberId: order.memberId,
        });
      }
    });

    logger.info(`Order cancelled: ${orderId}`, { cancellationReason, grantedRewardId: grId });
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
      throw new AppError(404, 'SNAPSHOT_NOT_FOUND', 'Snapshot not found');
    }

    if (snapshot.status === 'USED' || snapshot.status === 'EXPIRED') {
      throw new AppError(400, 'SNAPSHOT_INVALID', 'Snapshot is no longer valid');
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
            /* 顾客在本店自有渠道下的配送单 —— 骑手由本店经 Uber Direct 安排 */
            deliveryProvider: snapshot.orderType === 'DELIVERY' ? 'MERCHANT' : null,
            consumerId: (snapshot as any).consumerId || undefined,
            memberId: memberId || undefined,
            customerName: snapshot.customerName,
            customerPhone: toE164(snapshot.customerPhone),
            customerEmail: (snapshot as any).customerEmail || undefined,
            subtotal: pricing.subtotal,
            taxAmount: pricing.taxAmount,
            deliveryFee: pricing.deliveryFee || 0,
            // 销项：向顾客收的配送费税（已含在 taxAmount 内，这里单存一份供对账拆分）
            deliveryFeeTax: pricing.deliveryFeeTax || 0,
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
            // CURBSIDE 的车辆信息：店员靠它认车，必须跟着订单走到门店
            vehicleInfo: (snapshot as any).vehicleInfo ?? undefined,
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
                  categoryId: item.categoryId ?? null,   // 分类快照，厨房单路由用
                  quantity: item.quantity,
                  unitPrice: parseInt(item.unitPrice, 10),
                  totalPrice: parseInt(item.unitPrice, 10) * item.quantity,
                  modifiers: null,  // 不再写 JSON，改用关系表
                  // 耗材行（餐具/袋子/打包费）：itemId 存的是 catalog_supplies.id，
                  // supplyOrigin 区分系统自动加的和顾客自己选的
                  ...(item.isSupply && {
                    lineKind: 'SUPPLY' as const,
                    supplyOrigin: item.supplyOrigin ?? null,
                  }),
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
              (order.orderSource === 'WEB' && order.deliveryProvider !== 'MERCHANT' && !order.isScheduled)
            );

          // Uber Direct 配送单：支付成功后必须停在 PENDING 等接单，
          // 不能在这里自动推到 CONFIRMED——CONFIRMED 只能由 confirmDeliveryOrder 在
          // 真正建好 Uber 配送单后联动写入（否则 POS 界面会显示"备餐中"但实际没人接过单，
          // 接单按钮也因为状态不是 PENDING 而消失，订单卡死）
          /*
            改用 deliveryProvider 而不是 `orderSource==='WEB' && orderType==='DELIVERY'`。

            旧判据碰巧成立（本店渠道下单才走 Uber Direct），但它表达的是
            「从哪下的单」而不是「谁送」—— POS 上手工录的平台单也是 DELIVERY，
            靠 orderSource 排除等于依赖一个巧合。
          */
          const isUberDelivery = order.deliveryProvider === 'MERCHANT';

          if (autoComplete) {
            updateData.status = 'COMPLETED';
            updateData.completedAt = new Date();
          } else if (!isUberDelivery) {
            updateData.status = 'CONFIRMED';
            /*
              confirmedAt 一直漏了 —— 走 order-status.service 的那条路会写
              （getStatusTimestampField），而这里是支付回调自己改 status，
              两条路各写各的。结果是「状态 CONFIRMED 但 confirmedAt 为 null」，
              报表和审计都答不出这单是什么时候确认的。
              实测生产订单 260913-P01-1MMU 就是这样。
            */
            updateData.confirmedAt = new Date();
          }
          // isUberDelivery: 不改 status，保持 PENDING

          /*
            状态历史同样要补。没有这条记录时 order_status_history 里查不到
            PENDING→CONFIRMED 这一跳，整单的时间线从建单直接跳到完成。
            changedBy 留空：这是支付回调自动推的，没有操作人。
          */
          if (updateData.status) {
            await tx.orderStatusHistory.create({
              data: {
                orderId: data.orderId,
                fromStatus: order.status as any,
                toStatus: updateData.status as any,
                reason: '支付成功自动推进',
                changedAt: new Date(),
              },
            });
          }
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
          deliveryProvider: order.deliveryProvider,
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
          // 耗材不计积分（也不参与折扣）。事务内查一次，给下面两个事件共用
          supplySubtotal: await sumSupplySubtotal(tx, data.orderId),
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
        deliveryProvider: (result as any)._meta.deliveryProvider ?? null,
        previousStatus: (result as any)._meta.previousStatus,
        paymentIntentId: data.paymentIntentId,
        snapshot: (result as any)._meta.snapshot,
        memberId: (result as any)._meta.memberId,
        subtotal: (result as any)._meta.subtotal,
        discountAmount: (result as any)._meta.discountAmount,
        supplySubtotal: (result as any)._meta.supplySubtotal ?? 0,
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
          supplySubtotal: (result as any)._meta.supplySubtotal ?? 0,
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
      throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found');
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
      throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found');
    }

    if (order.totalAmount !== 0) {
      throw new AppError(400, 'ORDER_TOTAL_NOT_ZERO', 'Order total is not zero, payment required');
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

    /*
      ★ 查之前先自愈：把这个 consumer 名下、只挂了 memberId 却没有 consumer_id
      的历史订单补上。

      建单时已经会解析一次（见 createOrderInner），但有两种情况补不到：
        · 那次会员服务不可达
        · **纯线下会员后来才在 app 注册** —— 绑定发生在下单之后，
          他此前所有 POS 单的 consumer_id 都是空的

      为什么放在读取侧而不是让 member-service 在绑定时推一条过来：
      推送要么丢（fire-and-forget），要么得在 member-service 里再建一套待发板。
      而这里是**自愈**：每次顾客打开订单记录都会顺手补一遍，丢了下次自己好，
      和现金流水补录是同一个套路。成本是每页一次内部调用 + 一条带索引的 UPDATE，
      订单历史本来就是低频页面。

      任何一步失败都不影响查询本身 —— 补不上就还是只看到已经有 consumer_id 的那些。
    */
    try {
      const memberId = await getMemberIdByConsumerId(consumerId);
      if (memberId) {
        const { count } = await prisma.order.updateMany({
          where: { memberId, consumerId: null },
          data: { consumerId },
        });
        if (count > 0) {
          logger.info('[Order] 补齐历史订单的 consumer_id', { consumerId, memberId, count });
        }
      }
    } catch (e) {
      logger.warn('[Order] 补齐 consumer_id 失败，本次只返回已关联的订单', { consumerId, e });
    }

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
        // 渠道折扣单独存字段、也单独从 totalAmount 里减掉，明细要对得上就必须一起给
        channelDiscountAmount: true,
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
      throw new AppError(404, 'ORDER_NOT_FOUND', '订单不存在');
    }
    if (order.consumerId !== consumerId) {
      // 不透露"订单存在但不属于你"，统一按不存在处理（含 code/message 都要一致）
      throw new AppError(404, 'ORDER_NOT_FOUND', '订单不存在');
    }

    const [storeTimezone, refunds] = await Promise.all([
      organizationService.getStoreTimezone(order.tenantId),
      getRefundsByOrderId(order.id),
    ]);

    return { ...order, storeTimezone, refunds };
  }

}

export default new OrderService();
