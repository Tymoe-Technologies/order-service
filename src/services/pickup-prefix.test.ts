/**
 * 取餐号前缀的「配置透传」回归测试
 *
 * 栽过的坑：formatPickupDisplay 的第 4 个参数 channelPrefixes 当初带默认值 `{}`，
 * order.service 的 generatePickupNumber 漏传了它，编译器不吭声。
 * 结果同一单两个号 —— 小票和建单响应走内置默认前缀（P-42），
 * 叫号屏和配送通知走商家自定义前缀（堂食-42），店员和顾客对不上。
 *
 * 现在默认值去掉了，漏传会编译报错；下面再补一道行为断言和调用点检查，
 * 防止有人手滑传个 `{}` 把默认值又变相加回来。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PickupNumberConfigService } from './print-setting.service'

const svc = new PickupNumberConfigService()

describe('formatPickupDisplay 的前缀优先级', () => {
  test('商家自定义前缀优先于内置默认值', () => {
    // 内置默认里 POS 是 'P'，商家配成 '堂食' 就得听商家的
    assert.equal(svc.formatPickupDisplay(42, 'POS', true, { POS: '堂食' }), '堂食-42')
  })

  test('没配的渠道回落到内置默认值', () => {
    assert.equal(svc.formatPickupDisplay(42, 'POS', true, { WEB: '网订' }), 'P-42')
  })

  test('内置默认里也没有的渠道，不加前缀', () => {
    assert.equal(svc.formatPickupDisplay(42, 'UBER_EATS', true, {}), '42')
  })

  test('关掉前缀开关时，自定义前缀也不显示', () => {
    assert.equal(svc.formatPickupDisplay(42, 'POS', false, { POS: '堂食' }), '42')
  })
})

describe('每个调用点都得把 config.channelPrefixes 传下去', () => {
  const SRC = join(__dirname, '..')
  // 四个会算取餐号显示的地方，当初只有 order.service 漏了
  const callSites = [
    'services/order.service.ts',
    'services/delivery-confirmation.service.ts',
    'events/handlers/delivery.handler.ts',
    'routes/internal.ts',
  ]

  for (const file of callSites) {
    test(`${file} 传了 channelPrefixes`, () => {
      const src = readFileSync(join(SRC, file), 'utf8')
      // 抠出每一处 formatPickupDisplay( ... ) 的实参
      const calls = [...src.matchAll(/formatPickupDisplay\(([\s\S]*?)\)/g)].map(m => m[1])
      assert.ok(calls.length > 0, `${file} 里找不到 formatPickupDisplay 调用（正则可能失效了）`)

      for (const args of calls) {
        assert.match(
          args, /channelPrefixes/,
          `这处调用没传 channelPrefixes，商家自定义前缀会被静默忽略：\n  formatPickupDisplay(${args.trim()})`,
        )
        assert.doesNotMatch(
          args, /\{\s*\}/,
          `别传空对象糊弄，要传 getConfig() 拿到的 config.channelPrefixes：\n  formatPickupDisplay(${args.trim()})`,
        )
      }
    })
  }
})
