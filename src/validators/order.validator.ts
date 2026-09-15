import Joi from 'joi';

export const createOrderSchema = Joi.object({
  // 五种履约方式都要放行。少列一种的后果是那种单直接被拒——
  // CURBSIDE/DRIVE_THRU 加进枚举后这里漏改过一次，顾客选了路边取餐提交就 400
  orderType: Joi.string().valid('DINE_IN', 'TAKEOUT', 'DELIVERY', 'CURBSIDE', 'DRIVE_THRU').required(),
  /*
    谁负责配送。**漏了这个字段的后果是整类单被拒**（Joi 默认不允许未知键，
    而这里没开 allowUnknown）—— POS 上的外卖平台单会全部 400，
    然后被当成网络失败落进离线队列。上面 CURBSIDE/DRIVE_THRU 那条教训
    说的是同一件事：新字段/新枚举值必须同步到这里。
  */
  deliveryProvider: Joi.string().valid('MERCHANT', 'PLATFORM').optional().allow(null),
  /*
    总额后端自己算，收下只为**不把请求打成 400**：POS 的 CreateOrderRequest
    声明了这个字段（离线队列那边读它做显示），一旦有人照着类型填，
    Joi 的未知键检查会让整个请求挂掉。放行、忽略，比让它炸掉安全。
  */
  totalAmount: Joi.number().integer().min(0).optional(),
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
        // 分类快照，厨房单的分类级路由靠它（见 OrderItem.categoryId）。
        // 不放行的话 Joi 直接 400，POS 传了也进不来
        categoryId: Joi.string().uuid().optional().allow(null),
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

        /*
          这一行自己的税种明细。形状和订单头那份一样（见下面的 taxLines）。
          Joi 默认拒绝未知字段 —— POS 一开始发这个字段，这里不放行整个请求就 400，
          收了钱的单落不了库。
        */
        taxLines: Joi.array().items(
          Joi.object({
            name: Joi.string().max(40).required(),
            rate: Joi.number().min(0).max(1).required(),
            amount: Joi.number().integer().min(0).required(),
          }),
        ).optional(),

        /*
          耗材行（餐具 / 购物袋 / 打包费）。itemId 存的是 catalog_supplies.id。
          不放行的话 Joi 会把整个请求打成 400 —— POS 就是这么一直没能带耗材下单的。
        */
        isSupply: Joi.boolean().optional(),
        supplyOrigin: Joi.string().valid('auto', 'selected').optional().allow(null),
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
  /*
    税种明细 `[{ name, rate, amount }]`（amount 单位分）。加拿大申报要按
    税种分别填，而 taxAmount 只是合计。

    这里只做形状校验，**加不加得平交给 sanitizeTaxLines** ——
    在这里拒会让整单 400（一笔已经收了钱的单落不了库），
    而那边的处理是「丢掉明细、保留订单」，坏得轻得多。
  */
  taxLines: Joi.array().items(
    Joi.object({
      name: Joi.string().max(40).required(),
      rate: Joi.number().min(0).max(1).required(),
      amount: Joi.number().integer().min(0).required(),
    }),
  ).optional(),
  /*
    开这一单的 POS 设备码（auth-service 分配的，形如 `ylfin5tep`）。
    **Joi 默认拒绝未知字段，整个请求会 400** —— 所以 POS 一旦开始发这个字段，
    这里必须先放行，否则收了钱的单落不了库。
  */
  deviceId: Joi.string().max(255).optional(),
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
