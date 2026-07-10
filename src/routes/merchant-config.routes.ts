import { Router } from 'express';
import * as merchantConfigController from '../controllers/merchant-config.controller';

const router = Router();

// 注意：商家品牌身份相关接口（subdomain 解析、check-subdomain 唯一性、resolve）
// 全部迁移到 auth-service：
//   - GET  /api/auth-service/v1/organizations/public/resolve/:slug   （前端用）
//   - GET  /api/auth-service/v1/internal/org/by-slug/:slug           （内部服务用）
// 本服务只负责"商家点单业务"字段（enabled / allowPickup / businessHours / deliveryFee 等）。

/**
 * @swagger
 * /merchants/{merchantId}/config:
 *   get:
 *     summary: 根据商家ID获取点单配置
 *     tags: [MerchantConfig]
 */
router.get(
  '/merchants/:merchantId/config',
  merchantConfigController.getConfigByMerchantId
);

/**
 * @swagger
 * /merchants/{merchantId}/config:
 *   post:
 *     summary: 创建商家点单配置（主店/分店关系由 auth-service 决定）
 *     tags: [MerchantConfig]
 */
router.post(
  '/merchants/:merchantId/config',
  merchantConfigController.createConfig
);

/**
 * @swagger
 * /merchants/{merchantId}/config:
 *   put:
 *     summary: 更新商家点单配置
 *     tags: [MerchantConfig]
 */
router.put(
  '/merchants/:merchantId/config',
  merchantConfigController.updateConfig
);

/**
 * @swagger
 * /merchants/{merchantId}/config:
 *   delete:
 *     summary: 删除商家点单配置
 *     tags: [MerchantConfig]
 */
router.delete(
  '/merchants/:merchantId/config',
  merchantConfigController.deleteConfig
);

/**
 * @swagger
 * /admin/merchant-configs:
 *   get:
 *     summary: 获取所有点单配置列表（管理员）
 *     tags: [MerchantConfig]
 */
router.get(
  '/admin/merchant-configs',
  merchantConfigController.getAllConfigs
);

/**
 * @swagger
 * /public/merchants/{merchantId}/stores:
 *   get:
 *     summary: 公开门店列表（前端使用）
 *     description: |
 *       返回主店及所有子店的点单业务字段（enabled, allowPickup, businessHours, deliveryFee 等）。
 *       门店名称/地址/经纬度由前端调 auth-service 的 /organizations/public/resolve/:slug 接口
 *       获取，并按 storeId 与本接口的结果 join。
 *     tags: [Public]
 */
router.get(
  '/public/merchants/:merchantId/stores',
  merchantConfigController.getPublicMerchantStores
);

export default router;
