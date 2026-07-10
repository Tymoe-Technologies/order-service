import { Router } from 'express'
import * as checkoutSnapshotController from '../controllers/checkout-snapshot.controller'

const router = Router()

// 公开端点 - 创建快照（无需认证，通过 X-Merchant-Id 识别商家）
router.post('/', checkoutSnapshotController.createSnapshot)

// 可选：获取快照详情（调试用）
router.get('/:snapshotId', checkoutSnapshotController.getSnapshot)

export default router
