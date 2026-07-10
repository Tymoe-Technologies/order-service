import Joi from 'joi';

export const createOrderSchema = Joi.object({
  orderType: Joi.string().valid('DINE_IN', 'TAKEOUT', 'DELIVERY').required(),
  clientOrigin: Joi.string().valid('POS', 'WEB', 'KIOSK').default('POS'),
  tableNumber: Joi.string().max(50).optional().allow(null),
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
