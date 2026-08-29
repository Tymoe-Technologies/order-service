import { Router } from 'express';
import * as fulfillmentOptionController from '../controllers/fulfillment-option.controller';

const router = Router();

/**
 * 门店履约方式配置（堂食 / 外带 / 配送 / 路边取餐 / 车道取餐）
 *
 * 取代 MerchantOnlineOrderConfig 上的 allow_pickup / allow_dine_in / allow_delivery
 * 三个布尔列 —— 那套结构每加一种方式就要加一列。旧列仍在双写，等调用方切完再删。
 */

/**
 * @swagger
 * /merchants/{merchantId}/fulfillment-options:
 *   get:
 *     summary: 获取门店的履约方式配置（含未配置过的，按默认值补齐）
 *     tags: [FulfillmentOptions]
 */
router.get(
  '/merchants/:merchantId/fulfillment-options',
  fulfillmentOptionController.listOptions
);

/**
 * @swagger
 * /merchants/{merchantId}/fulfillment-options:
 *   put:
 *     summary: 保存履约方式配置（整份提交，至少启用一种）
 *     tags: [FulfillmentOptions]
 */
router.put(
  '/merchants/:merchantId/fulfillment-options',
  fulfillmentOptionController.saveOptions
);

/**
 * @swagger
 * /public/merchants/{merchantId}/fulfillment-options:
 *   get:
 *     summary: 顾客端读取本店启用的履约方式（无需认证）
 *     tags: [FulfillmentOptions]
 */
router.get(
  '/public/merchants/:merchantId/fulfillment-options',
  fulfillmentOptionController.listPublicOptions
);

export default router;
