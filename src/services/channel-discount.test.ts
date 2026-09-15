/**
 * 渠道整单折扣。
 *
 * 守的是一条纪律：**和 POS 算出同一个数**。
 * POS 那份在 reall-pos 的 src/services/channelService.ts（calcChannelDiscount），
 * 算法必须逐字一致，只有基数由调用方给。
 */

import { test, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { calcChannelDiscount } from './channel-discount'

const PCT20 = { enabled: true, type: 'PERCENTAGE' as const, value: 20 }

describe('calcChannelDiscount', () => {
  it('基数是整单折扣之后的小计，不是原始 subtotal', () => {
    // 订单 260914-P02-1WLQ 的真实数据：小计 424，会员券减 62
    // 错的算法：round(424 × 20%) = 85  ← 前后端差 13 分就是这么来的
    // 对的算法：round((424−62) × 20%) = round(72.4) = 72
    assert.equal(calcChannelDiscount(PCT20, 424, 62), 72)
  })

  it('没有整单折扣时就是按小计算', () => {
    assert.equal(calcChannelDiscount(PCT20, 424, 0), 85)
  })

  it('FIXED 折扣不能超过折后基数', () => {
    const fixed = { enabled: true, type: 'FIXED' as const, value: 500 }
    assert.equal(calcChannelDiscount(fixed, 424, 62), 362)   // 封顶到 424−62
    assert.equal(calcChannelDiscount(fixed, 1000, 0), 500)
  })

  it('整单折扣吃光小计时不产生负数', () => {
    assert.equal(calcChannelDiscount(PCT20, 424, 424), 0)
    assert.equal(calcChannelDiscount(PCT20, 424, 999), 0)
  })

  it('规则没开 / 缺字段 → 0', () => {
    assert.equal(calcChannelDiscount(null, 424, 0), 0)
    assert.equal(calcChannelDiscount({ enabled: false, type: 'PERCENTAGE', value: 20 }, 424, 0), 0)
    assert.equal(calcChannelDiscount({ enabled: true, type: 'PERCENTAGE' }, 424, 0), 0)
  })
})
