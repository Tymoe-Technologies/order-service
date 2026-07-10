import Joi from 'joi';

const timeStr = Joi.string().pattern(/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/);

// 单段时间（新格式）
const dayPeriodSchema = Joi.object({
  open: timeStr.required(),
  close: timeStr.required(),
  nextDay: Joi.boolean().optional(), // true = close 是次日（跨午夜）
});

// 单日配置：新格式 { closed, periods[] }，兼容旧格式 { open, close, closed }
const dayHoursSchema = Joi.alternatives().try(
  // 新格式
  Joi.object({
    closed: Joi.boolean().required(),
    periods: Joi.array().items(dayPeriodSchema).min(1).required(),
  }),
  // 旧格式（向下兼容）
  Joi.object({
    open: timeStr.required(),
    close: timeStr.required(),
    closed: Joi.boolean().required(),
  }),
);

// 营业时间配置
const businessHoursSchema = Joi.object({
  monday: dayHoursSchema.required(),
  tuesday: dayHoursSchema.required(),
  wednesday: dayHoursSchema.required(),
  thursday: dayHoursSchema.required(),
  friday: dayHoursSchema.required(),
  saturday: dayHoursSchema.required(),
  sunday: dayHoursSchema.required(),
});

// 创建点单配置：商家身份字段（subdomain/customDomain/themeSettings/parentMerchantId）
// 已全部迁移到 auth-service；本服务只接收点单业务字段。
// 主店/分店关系由 service 内部从 auth-service 解析。
const pickupScheduleFields = {
  allowPickupSchedule: Joi.boolean(),
  pickupLeadMinutes: Joi.number().integer().min(0).max(1440),   // 最多提前 24 小时
  pickupSlotInterval: Joi.number().integer().valid(15, 30, 60), // 只允许 15/30/60 分钟
  pickupAdvanceDays: Joi.number().integer().min(0).max(30),     // 最多提前 30 天
};

export const createConfigSchema = Joi.object({
  merchantId: Joi.string().uuid().required(),
  enabled: Joi.boolean(),
  allowPickup: Joi.boolean(),
  allowDineIn: Joi.boolean(),
  allowDelivery: Joi.boolean(),
  // businessHours 已迁移到 auth-service Organization.businessHours
  minOrderAmount: Joi.number().integer().min(0),
  deliveryFee: Joi.number().integer().min(0),
  deliveryRadius: Joi.number().min(0).max(100),
  ...pickupScheduleFields,
});

// 更新点单配置
export const updateConfigSchema = Joi.object({
  enabled: Joi.boolean(),
  allowPickup: Joi.boolean(),
  allowDineIn: Joi.boolean(),
  allowDelivery: Joi.boolean(),
  minOrderAmount: Joi.number().integer().min(0).allow(null),
  deliveryFee: Joi.number().integer().min(0),
  deliveryRadius: Joi.number().min(0).max(100),
  ...pickupScheduleFields,
}).min(1);
