import { Router } from 'express';
import salesChannelController from '../controllers/sales-channel.controller';
import { authMiddleware } from '../middleware/auth';
import { requireModulePermission } from '../middleware/requirePermission';
import { rateLimitMiddleware } from '../middleware/rateLimiter';

const router = Router();

// 所有路由都需要认证
router.use(authMiddleware);
router.use(requireModulePermission('salesChannels'));

// 获取销售渠道列表
router.get('/', rateLimitMiddleware, salesChannelController.getSalesChannels);

/*
  渠道数据版本号（POS 轻量轮询用）。

  ⚠️ 必须排在 `/:channelId` 之前，否则 Express 会把 "version" 当成 channelId，
  返回 404 而不是版本号 —— 而 POS 那边只会记一条「取版本失败」，看不出是路由顺序问题。

  故意不挂 rateLimitMiddleware：那个限流器是 100 次 / 15 分钟**按 IP**，
  而一个门店的所有 POS 在同一个出口 IP 后面。被挡掉时受害的是静默的后台同步
  （店员完全看不到），而不是真正滥用的请求。这个接口本身是幂等只读、
  一次带索引的聚合查询，且要过 authMiddleware + salesChannels 权限，不是公开面。
*/
router.get('/version', salesChannelController.getChannelVersion);

// 初始化默认销售渠道
router.post('/init-defaults', salesChannelController.initializeDefaultChannels);

// 创建销售渠道
router.post('/', salesChannelController.createSalesChannel);

// 获取单个销售渠道
router.get('/:channelId', salesChannelController.getSalesChannelById);

// 更新销售渠道
router.put('/:channelId', salesChannelController.updateSalesChannel);

// 删除销售渠道
router.delete('/:channelId', salesChannelController.deleteSalesChannel);

// ── 渠道成员管理 ──────────────────────────────────────────────────────
// 获取渠道成员列表
router.get('/:channelId/members', salesChannelController.getChannelMembers);
// 添加成员（单个）
router.post('/:channelId/members', salesChannelController.addChannelMember);
// 批量导入成员
router.post('/:channelId/members/batch', salesChannelController.batchAddChannelMembers);
// 更新成员（姓名/备注/状态）
router.put('/:channelId/members/:memberId', salesChannelController.updateChannelMember);
// 删除成员
router.delete('/:channelId/members/:memberId', salesChannelController.removeChannelMember);
// 按手机号查询所属渠道（POS 录单时自动匹配）
router.get('/lookup/by-phone', salesChannelController.lookupChannelByPhone);

// 查询渠道授信额度使用情况（Consumer 结账页展示剩余额度）
router.get('/channel-credit/:channelId', salesChannelController.getChannelCreditStatus);

export default router;
