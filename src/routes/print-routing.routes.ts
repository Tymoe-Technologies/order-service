import { Router } from 'express';
import printRoutingController from '../controllers/print-routing.controller';
import { authenticate } from '../middleware/auth';
import { requireModulePermission } from '../middleware/requirePermission';

const router = Router();

router.use(authenticate);

/*
  ## 读和写的权限不一样，这是有意的

  **写**要 `printSettings` 权限：改站、改路由规则、登记打印机归属都是管理动作。

  **读不要。** 每一台 POS 都要靠这份配置拆厨房单 —— 同步引擎会为**每个登录的
  员工**拉一次。要是读也卡 `printSettings.view`，没有该权限的收银员每轮同步都
  403，那台机器的本机缓存永远追不上，于是它出的厨房单退回「全单一张」，
  而界面上一点异常都看不出来。
  内容本身也不敏感：站名 + 商品归属，没有任何金额或客户信息。

  归属登记（PUT /assignments）是收银机在配打印机时发的，同样算管理动作，
  所以也要权限 —— 那个操作本来就发生在设置页里。
*/
const requireEdit = requireModulePermission('printSettings', 'edit');

// 打印机归属（放在根路由之前避免冲突）
router.put('/assignments', requireEdit, printRoutingController.putAssignments);
// 具体路径在 :scope 之前 —— 虽然 :scope 只匹配单段、吃不掉 device/xxx，
// 但依赖这个细节不如把顺序写明确
router.delete('/assignments/device/:deviceId', requireEdit, printRoutingController.releaseDeviceAssignments);
router.delete('/assignments/:scope', requireEdit, printRoutingController.deleteAssignment);

router.get('/', printRoutingController.getConfig);
router.put('/', requireEdit, printRoutingController.replaceConfig);

export default router;
