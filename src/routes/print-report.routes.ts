import { Router } from 'express';
import { reportPrintResults } from '../services/print-report.service';
import { authenticate } from '../middleware/auth';
import { successResponse } from '../utils/response';

const router = Router();

router.use(authenticate);

/**
 * POST /api/order/v1/print-results
 *
 * POS 补报本机打印结果。幂等（按 clientTaskId），见 print-report.service。
 *
 * **不挂 requireModulePermission**：这是收银机在正常收款流程里发的留痕，
 * 不是打印设置的管理动作。挂上 printSettings 权限会让没有该权限的收银员
 * 每单都补报失败 —— 而那批记录正是排查「这单打没打」的唯一依据。
 * 认证仍要过（authenticate 给出 tenantId）。
 */
router.post('/', async (req, res, next) => {
  try {
    const result = await reportPrintResults(
      req.user!.tenantId,
      req.user!.userId,
      req.body?.results,
    );
    successResponse(res, result);
  } catch (error) {
    next(error);
  }
});

export default router;
