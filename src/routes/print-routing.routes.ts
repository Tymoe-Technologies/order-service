import { Router } from 'express';
import printRoutingController from '../controllers/print-routing.controller';
import { authenticate } from '../middleware/auth';
import { requireModulePermission } from '../middleware/requirePermission';

const router = Router();

router.use(authenticate);
router.use(requireModulePermission('printSettings'));

// 打印机归属（放在根路由之前避免冲突）
router.put('/assignments', printRoutingController.putAssignments);
router.delete('/assignments/:scope', printRoutingController.deleteAssignment);

router.get('/', printRoutingController.getConfig);
router.put('/', printRoutingController.replaceConfig);

export default router;
