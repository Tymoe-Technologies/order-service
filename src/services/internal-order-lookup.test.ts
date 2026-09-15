/**
 * 平台内部按订单号查单必须消歧。
 *
 * ## 出过什么事
 * 订单号只在门店内唯一（`@@unique([tenantId, orderNumber])`，全局唯一由
 * `orders.id` 这个 UUIDv7 主键承担）。两家店同一秒、同一设备码各开一单，
 * 拿到的号一模一样 —— 这是设计，不是 bug。
 *
 * 但 getOrderByIdInternal 原来是 `findFirst` 且没有 orderBy：重号时
 * Postgres 按自己的扫描顺序给第一条。返回的那单金额、商品、状态全都自洽，
 * 只是可能属于另一家店，看的人分辨不出来。而 admin-bff 会拿这一条的 id
 * 当 resolvedOrderId 再去查 finance / member / Loki，于是整条链路视图
 * **一致地**指向错的组织 —— 排查的人拿着 B 店的数据解释 A 店的问题。
 *
 * 所以这里钉两件事：命中多条必须报 409 带候选（不能静默挑一条），
 * 命中一条照常返回。
 */
import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import prisma from '../utils/prisma'
import organizationService from './organization.service'
import orderService from './order.service'

const ORDER_NUMBER = '260817-P01-2F7Q'

const fakeOrder = (id: string, tenantId: string) => ({
  id,
  tenantId,
  orderNumber: ORDER_NUMBER,
  createdAt: new Date('2026-08-17T12:00:00Z'),
  totalAmount: 1999,
  orderItems: [],
  orderNotes: [],
  analytics: null,
})

const origFindMany = prisma.order.findMany
const origGetOrg = organizationService.getOrganization
const origGetTz = organizationService.getStoreTimezone

/** 记录 service 实际发给 prisma 的 where，用来验证 tenantId 消歧确实下推了 */
let lastArgs: any = null

const stub = (rows: any[]) => {
  lastArgs = null
  ;(prisma.order as any).findMany = async (args: any) => {
    lastArgs = args
    return rows
  }
  ;(organizationService as any).getOrganization = async (orgId: string) => ({ orgName: `店-${orgId}` })
  ;(organizationService as any).getStoreTimezone = async () => 'America/Toronto'
}

afterEach(() => {
  ;(prisma.order as any).findMany = origFindMany
  ;(organizationService as any).getOrganization = origGetOrg
  ;(organizationService as any).getStoreTimezone = origGetTz
})

describe('按订单号查单（跨租户）', () => {
  test('重号时报 409 并带上候选，不静默挑一条', async () => {
    stub([fakeOrder('11111111-1111-7111-8111-111111111111', 'org-a'),
          fakeOrder('22222222-2222-7222-8222-222222222222', 'org-b')])

    const err = await orderService.getOrderByIdInternal(ORDER_NUMBER).then(
      () => null,
      (e: any) => e,
    )

    assert.ok(err, '重号却返回了订单 —— 那一条可能属于另一家店，而调用方看不出来')
    assert.equal(err.statusCode, 409)
    assert.equal(err.code, 'ORDER_NUMBER_AMBIGUOUS')

    const candidates = err.details?.candidates
    assert.equal(candidates?.length, 2, '候选没带全，前端就没法让人选店')
    // 组织名要有：运营看 tenantId 的 UUID 是选不出店的
    assert.deepEqual(candidates.map((c: any) => c.orgName), ['店-org-a', '店-org-b'])
    // 订单 id 要有：选中后要用它重查（UUID 主键，全平台唯一，不会再有歧义）
    assert.deepEqual(
      candidates.map((c: any) => c.orderId),
      ['11111111-1111-7111-8111-111111111111', '22222222-2222-7222-8222-222222222222'],
    )
  })

  test('只命中一条时照常返回', async () => {
    stub([fakeOrder('33333333-3333-7333-8333-333333333333', 'org-a')])
    const order: any = await orderService.getOrderByIdInternal(ORDER_NUMBER)
    assert.equal(order.id, '33333333-3333-7333-8333-333333333333')
    assert.equal(order.storeTimezone, 'America/Toronto')
  })

  test('查不到时报 404', async () => {
    stub([])
    const err = await orderService.getOrderByIdInternal(ORDER_NUMBER).then(() => null, (e: any) => e)
    assert.equal(err?.statusCode, 404)
    assert.equal(err?.code, 'ORDER_NOT_FOUND')
  })

  test('带 tenantId 时下推到查询里（这是调用方消歧的手段）', async () => {
    stub([fakeOrder('44444444-4444-7444-8444-444444444444', 'org-b')])
    await orderService.getOrderByIdInternal(ORDER_NUMBER, 'org-b')
    assert.deepEqual(lastArgs.where, { AND: [{ orderNumber: ORDER_NUMBER }, { tenantId: 'org-b' }] })
  })

  test('按 id（UUID）查不受消歧影响 —— 主键全平台唯一', async () => {
    const id = '55555555-5555-7555-8555-555555555555'
    stub([fakeOrder(id, 'org-a')])
    const order: any = await orderService.getOrderByIdInternal(id)
    assert.equal(order.id, id)
    // UUID 输入仍然按 id / orderNumber 两路匹配（历史数据里可能有 UUID 形状的订单号）
    assert.ok(lastArgs.where.OR, 'UUID 输入应该走 OR 匹配')
  })
})
