import { Router } from 'express';
import { getPosSyncVersions } from '../services/sync-version.service';
import { authMiddleware } from '../middleware/auth';
import logger from '../utils/logger';
import { successResponse } from '../utils/response';

const router = Router();

router.use(authMiddleware);

/**
 * GET /api/order/v1/sync/version
 *
 * order-service 负责的所有 POS 同步数据的版本号（渠道 + 打印设置）。
 * POS 每个信号打一次，版本没变就一个数据请求都不发。
 *
 * 三个刻意的决定：
 *
 * 1. **不挂 requireModulePermission。** 原来渠道版本号挂在
 *    /sales-channels 下，继承了 `salesChannels` 模块权限。但这个接口现在同时
 *    覆盖打印设置，按哪个模块判都不对；而它返回的只是两个「数据变了没」的
 *    不透明字符串，不含任何业务内容。认证仍然要过（authMiddleware 给出 tenantId）。
 *
 * 2. **不挂 rateLimitMiddleware。** 那个限流器是 100 次 / 15 分钟**按 IP**，
 *    而一个门店的所有 POS 共用出口 IP。被挡掉时受害的是静默的后台同步
 *    （店员完全看不到），而不是真正滥用的请求。
 *
 * 3. **不打 info 日志。** 每台设备每 5 分钟一次，记下来只会淹掉别的日志。
 */
router.get('/version', async (req, res, next) => {
  try {
    const tenantId = req.user!.tenantId;
    const versions = await getPosSyncVersions(tenantId);
    successResponse(res, versions);
  } catch (error) {
    logger.error('Error fetching POS sync versions', error);
    next(error);
  }
});

export default router;
