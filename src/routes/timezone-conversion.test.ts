/**
 * `AT TIME ZONE` 必须写两次。
 *
 * ## 坑在哪
 * 所有时间列都是 `timestamp without time zone`，里面存的是 **UTC 时刻**。
 * 对这种列，PostgreSQL 的 `ts AT TIME ZONE 'X'` 语义是**反的**：
 *
 *     timestamptz AT TIME ZONE 'X'   →  转换到 X 时区的本地时间   ✓ 直觉如此
 *     timestamp   AT TIME ZONE 'X'   →  把值当作 X 时区的本地时间，
 *                                        转成 timestamptz          ✗ 方向反了
 *
 * 所以要拿到「门店时区的第几点」，得先把 naive timestamp 标记成 UTC：
 *
 *     created_at AT TIME ZONE 'UTC' AT TIME ZONE '<门店时区>'
 *
 * ## 出过什么事
 * 按小时报表少写了第一次，整条曲线整体偏移：库里 03:22（UTC，即温哥华
 * 20:22 的晚市高峰）被算成 **10 点**。店主看到的是「上午是高峰」。
 *
 * 按天分组（daily-series）是同一个坑的另一面 —— 靠近日界的单会记到隔壁那天。
 *
 * ## 为什么值得钉住
 * 少写一次**不报错**，只是数字悄悄偏移几小时；而且同一个仓库里两种写法
 * 并存过（order.service 是对的、internal.ts 是错的），照着错的那份抄很容易。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const files = [
  ['routes/internal.ts', readFileSync(join(__dirname, 'internal.ts'), 'utf8')],
  ['services/order.service.ts',
   readFileSync(join(__dirname, '..', 'services', 'order.service.ts'), 'utf8')],
] as const

describe('时间列转门店时区', () => {
  for (const [label, src] of files) {
    /* 剥注释：解释这个坑时必然会写出错误写法本身 */
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*--.*$/gm, '')

    test(`${label} 没有单写一次 AT TIME ZONE 的地方`, () => {
      /*
        找所有 AT TIME ZONE，排除掉「前面紧跟着 AT TIME ZONE 'UTC'」的正确写法。
        剩下的就是把 naive timestamp 直接往目标时区转 —— 方向反了。
      */
      const all = [...code.matchAll(/AT TIME ZONE/g)].length
      const correct = [...code.matchAll(/AT TIME ZONE 'UTC' AT TIME ZONE/g)].length
      // 每个正确写法自己含两个 AT TIME ZONE
      const lone = all - correct * 2
      assert.equal(
        lone, 0,
        `${label} 有 ${lone} 处只写了一次 AT TIME ZONE。\n`
        + '   时间列是 timestamp without time zone（存 UTC），单写一次是把值\n'
        + '   当作目标时区的本地时间去解释 —— 方向反了，结果整体偏移几小时。\n'
        + "   正确：created_at AT TIME ZONE 'UTC' AT TIME ZONE <门店时区>",
      )
    })
  }

  test('按小时聚合确实用了双重转换', () => {
    const internal = files[0][1]
    assert.match(
      internal,
      /EXTRACT\(HOUR FROM \(o\.created_at AT TIME ZONE 'UTC' AT TIME ZONE \$\{sqlTz\}\)\)/,
      '按小时报表是这个坑最早暴露的地方，写法不能退回去',
    )
  })

  /*
    时间列的类型是这套写法成立的前提。哪天迁成 timestamptz 了，
    双重转换反而会错 —— 那时这个测试该跟着改，所以把前提也钉住。
  */
  test('时间列仍是 timestamp without time zone（双重转换的前提）', () => {
    const schema = readFileSync(
      join(__dirname, '..', '..', 'shared', 'database', 'schema-order.prisma'), 'utf8')
    const orderModel = schema.match(/^model Order \{[\s\S]*?^\}/m)?.[0] ?? ''
    assert.ok(orderModel.includes('createdAt'), '找不到 Order.createdAt')
    assert.ok(
      !/createdAt\s+DateTime[^\n]*@db\.Timestamptz/.test(orderModel),
      'createdAt 迁成 timestamptz 了 —— 那时双重 AT TIME ZONE 反而是错的，'
      + '本测试和三处查询都要跟着改',
    )
  })
})
