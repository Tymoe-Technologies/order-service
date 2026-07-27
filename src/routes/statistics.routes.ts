import { Router } from 'express';
import orderController from '../controllers/order.controller';
import { authenticate } from '../middleware/auth';
import { requireModulePermission } from '../middleware/requirePermission';

const router = Router();
const requireReports = requireModulePermission('reports', 'view');

router.get('/orders', authenticate, requireReports, orderController.getStatistics);
router.get('/revenue', authenticate, requireReports, orderController.getRevenueStatistics);
router.get('/items', authenticate, requireReports, orderController.getItemStatistics);
router.get('/tax', authenticate, requireReports, orderController.getTaxStatistics);
router.get('/reconciliation', authenticate, requireReports, orderController.getReconciliationStatistics);

export default router;
