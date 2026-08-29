import Joi from 'joi';

export const createOrderSchema = Joi.object({
  // 五种履约方式都要放行。少列一种的后果是那种单直接被拒——
  // CURBSIDE/DRIVE_THRU 加进枚举后这里漏改过一次，顾客选了路边取餐提交就 400
  orderType: Joi.string().valid('DINE_IN', 'TAKEOUT', 'DELIVERY', 'CURBSIDE', 'DRIVE_THRU').required(),
  clientOrigin: Joi.string().valid('POS', 'WEB', 'KIOSK').default('POS'),
  tableNumber: Joi.string().max(50).optional().allow(null),
  // 离线补传：小票上没有取餐号，别补发一个（见 order.service 里那段说明）
  skipPickupNumber: Joi.boolean().optional(),
  customerName: Joi.string().max(255).optional().allow(null),
  customerPhone: Joi.string().max(50).optional().allow(null),
  memberId: Joi.string().uuid().optional().allow(null),  // 会员 ID（可选）
  items: Joi.array()
    .items(
      Joi.object({
        itemId: Joi.string().uuid().required(),
        itemName: Joi.string().max(255).required(),
        quantity: Joi.number().integer().min(1).required(),
        unitPrice: Joi.number().integer().min(0).required(),  // 单价（分，整数）
        
        // 商品级别折扣
        discountAmount: Joi.number().integer().min(0).optional(),  // 折扣（分，整数）
        discountType: Joi.string().valid('PERCENTAGE', 'FIXED').optional(),
        discountValue: Joi.number().min(0).optional(),
        discountReason: Joi.string().max(100).optional(),
        
        attributes: Joi.object().optional(),
        modifiers: Joi.array()
          .items(
            Joi.object({
              groupId: Joi.string().uuid().required(),     // 修饰符组 ID
              optionId: Joi.string().uuid().required(),
              groupName: Joi.string().required(),           // 修饰符组名（快照）
              optionName: Joi.string().required(),
              unitPrice: Joi.number().integer().min(0).required(),  // 修饰符价格（分，整数）
              quantity: Joi.number().integer().min(1).required(),
            })
          )
          .optional(),
        specialNotes: Joi.string().optional().allow(null),
      })
    )
    .min(1)
    .required(),
  notes: Joi.string().optional().allow(null),

  // 预约自取
  isScheduled: Joi.boolean().default(false),
  scheduledAt: Joi.when('isScheduled', {
    is: true,
    then: Joi.date().iso().greater('now').required()
      .messages({ 'date.greater': '预约时间必须晚于当前时间' }),
    otherwise: Joi.date().iso().optional().allow(null),
  }),

  // 费用相关（分，整数）
  taxAmount: Joi.number().integer().min(0).default(0),
  discountAmount: Joi.number().integer().min(0).default(0),
  serviceFee: Joi.number().integer().min(0).default(0),
  deliveryFee: Joi.number().integer().min(0).default(0),
  platformFee: Joi.number().integer().min(0).default(0),
  tipAmount: Joi.number().integer().min(0).default(0),
  
  // 折扣明细
  discountType: Joi.string().max(50).optional().allow(null),
  discountValue: Joi.number().min(0).optional().allow(null),
  discountCode: Joi.string().max(100).optional().allow(null),
  discountReason: Joi.string().max(255).optional().allow(null),
  
  // 支付信息
  paymentMethod: Joi.string()
    .valid('CASH', 'CARD', 'ALIPAY', 'WECHAT', 'APPLE_PAY', 'GOOGLE_PAY', 'FREE', 'ACCOUNT', 'PLATFORM')
    .optional()
    .allow(null),
  transactionId: Joi.string().max(255).optional().allow(null),
  
  // 现金支付相关（分，整数）

  // 收银员信息（POS 订单）
  cashierName: Joi.string().max(100).optional().allow(null, ''),
  cashierEmployeeNumber: Joi.string().max(50).optional().allow(null, ''),

  // 销售渠道（关联 orderSourceConfig.id）
  salesChannelId: Joi.string().uuid().optional().allow(null),

  /*
    客户端记录的下单时间（ISO 8601），只有 POS 离线补传会传。
    不传 = 实时下单，服务端用自己的 now()。

    ⚠️ 这个 schema 是白名单（Joi 默认拒绝未知字段），加字段必须**三处一起改**：
    CreateOrderData 类型、这里的校验、以及落库那段。
    只改前两处的话请求会被这里 400 掉（"clientCreatedAt" is not allowed），
    而且报错发生在补传里 —— 界面上只是"补传失败"，不点开控制台看不出是字段被拒。

    这里只校验格式，**合理性由 order.service 的 resolvePlacedAt 判**
    （不能是未来、不能早于 7 天）：那属于业务规则，而且不合格时要退回 now()
    并把原值留痕，不是简单拒绝请求 —— 拒绝的话这单永远补不上去。
  */
  clientCreatedAt: Joi.string().isoDate().optional().allow(null),

  /*
    客户端生成的订单主键（UUIDv7）。不传则服务端生成。
    只校验是不是合法 UUID —— 是不是重放、有没有被别的租户占用，
    由 order.service 的重放检查判（那里才拿得到 tenantId）。
  */
  id: Joi.string().uuid().optional(),

  /*
    客户端生成的订单号。格式 `营业日(6)-渠道码(1)设备码(2)-当日秒数(4)` = 15 位。
    这是雪花算法换了刻度和编码：时间戳=营业日+当日秒数、机器ID=设备码、
    序号=同秒借下一秒。唯一性靠结构（设备码做号段隔离），不靠随机。

    这里只做形状校验，防脏数据（比如把 UUID 塞进来）；
    唯一性由 DB 的 @@unique([tenantId, orderNumber]) 兜底，
    撞了则服务端改用自己发的号并把这个留进 claimed_order_number（不拒绝请求）。
  */
  orderNumber: Joi.string().pattern(/^\d{6}-[A-Z][0-9A-HJ-NP-Z]{2}-[0-9A-HJ-NP-Z]{4}$/).optional(),
});

export const updateOrderStatusSchema = Joi.object({
  status: Joi.string()
    .valid(
      'SCHEDULED',
      'PENDING',
      'CONFIRMED',
      'PREPARING',
      'READY',
      'PICKED_UP',
      'OUT_FOR_DELIVERY',
      'DELIVERED',
      'COMPLETED',
      'CANCELLED'
    )
    .required(),
  reason: Joi.string().optional().allow(null),
});

export const cancelOrderSchema = Joi.object({
  reason: Joi.string()
    .valid('MERCHANT_REQUEST', 'CUSTOMER_REQUEST', 'OUT_OF_STOCK', 'DUPLICATE_ORDER', 'PAYMENT_FAILED', 'SYSTEM_CANCEL')
    .required(),
});

export const printOrderSchema = Joi.object({
  printType: Joi.string().valid('RECEIPT', 'KITCHEN_TICKET', 'LABEL').required(),
  printerName: Joi.string().max(255).optional().allow(null),
  copies: Joi.number().integer().min(1).default(1),
});
