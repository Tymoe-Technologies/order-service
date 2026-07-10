import { Router } from 'express';
import orderController from '../controllers/order.controller';
import { authenticate } from '../middleware/auth';

const router = Router();

router.get('/orders', authenticate, orderController.getStatistics);
router.get('/revenue', authenticate, orderController.getRevenueStatistics);
router.get('/items', authenticate, orderController.getItemStatistics);
router.get('/tax', authenticate, orderController.getTaxStatistics);
router.get('/reconciliation', authenticate, orderController.getReconciliationStatistics);

export default router;
