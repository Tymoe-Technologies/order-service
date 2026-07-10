import { PrismaClient } from '../../node_modules/.prisma/client-order'
import axios from 'axios'

const prisma = new PrismaClient()

interface CreateSnapshotDto {
  orderType: 'TAKEOUT' | 'DINE_IN' | 'DELIVERY'
  consumerId?: string  // 已登录用户的 Consumer UUID
  customer: {
    name: string
    phone: string
    email?: string
  }
  items: Array<{
    itemId: string
    quantity: number
    modifiers?: any
    selectedOptions?: Record<string, string[]>  // 结构化修饰符数据 { groupId: [optionId] }
  }>
  tipAmount?: number
  notes?: string
  expectedTotal?: number
  // 顾客自定义标签数据（可选）
  customLabelData?: {
    imageData: string
    width: number
    height: number
  }
  // 配送地址（DELIVERY 类型时）
  deliveryAddress?: {
    street: string
    city: string
    province: string
    postalCode: string
    fullAddress: string
  }
  deliveryFee?: number     // 向顾客收取的配送费（单位：分，根据商家规则计算）
  uberDeliveryFee?: number // Uber 实际报价的配送费（单位：分，成本价）
  deliveryQuoteId?: string // Uber Direct 报价 ID
  // 积分兑换奖励（Consumer 在 Rewards 页面兑换后携带）
  grantedRewardId?: string // GrantedReward.id
  // 预约自取
  isScheduled?: boolean    // 是否为预约订单
  scheduledAt?: string     // 预约取餐时间（ISO 8601）
  // 礼品卡抵扣预估（cents）：用于 platformFee 计算
  // 仅作为非 gc 部分 fee 的依据；后端会 cap 到 baseTotal，最终扣款由 finance preAuth 校验真实余额
  giftCardDeductionEstimate?: number
  // 销售渠道 ID（SalesChannelConfig.id），服务端从 DB 读取折扣规则，防止前端篡改金额
  salesChannelId?: string
}

interface SnapshotPricing {
  subtotal: number
  taxAmount: number
  tipAmount: number
  platformFee: number
  deliveryFee: number
  uberDeliveryFee?: number        // Uber 实际报价的配送费（成本）
  discountAmount?: number         // 积分奖励折扣（分）
  channelDiscountAmount?: number  // 渠道折扣（分）
  channelConfigId?: string        // 渠道配置 ID
  channelName?: string            // 渠道名称
  grantedRewardId?: string        // 使用的已兑换奖励 ID
  total: number
}

const MEMBER_SERVICE_URL = process.env.MEMBER_SERVICE_URL || 'http://localhost:7006'
const INTERNAL_SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY || ''

/**
 * 校验并获取 GrantedReward 的折扣金额（分）
 * 返回 0 表示无折扣或校验失败
 */
async function resolveRewardDiscount(
  grantedRewardId: string,
  consumerId: string,   // Consumer.id（非 Member.id）
  subtotalCents: number,
  verifiedItems: Array<{ itemId: string; categoryId: string | null; unitPrice: number; basePrice: number; quantity: number }>
): Promise<{ discountCents: number }> {
  if (!INTERNAL_SERVICE_KEY) {
    console.warn('[CheckoutSnapshot] INTERNAL_SERVICE_KEY 未配置，跳过奖励校验')
    return { discountCents: 0 }
  }

  try {
    const url = `${MEMBER_SERVICE_URL}/internal/rewards/validate/${grantedRewardId}?consumerId=${consumerId}`
    console.log('[CheckoutSnapshot] 校验奖励:', url)
    const res = await fetch(url, {
      headers: { 'x-service-api-key': INTERNAL_SERVICE_KEY },
    })
    const body = await res.json()
    console.log('[CheckoutSnapshot] 奖励校验响应:', res.status, JSON.stringify(body))
    if (!res.ok) {
      console.warn('[CheckoutSnapshot] 奖励校验失败:', res.status)
      return { discountCents: 0 }
    }

    const rewardData = body?.data

    if (!rewardData?.valid || !rewardData?.reward) {
      console.warn('[CheckoutSnapshot] 奖励无效:', rewardData)
      return { discountCents: 0 }
    }

    const reward = rewardData.reward
    let discountCents = 0

    console.log('[CheckoutSnapshot] 奖励详情:', { rewardType: reward.rewardType, discountAmount: reward.discountAmount, discountPercentage: reward.discountPercentage })

    if (reward.rewardType === 'DISCOUNT_AMOUNT' && reward.discountAmount) {
      // 固定金额折扣
      discountCents = reward.discountAmount  // 已是分
    } else if (reward.rewardType === 'DISCOUNT_PERCENTAGE' && reward.discountPercentage) {
      // 百分比折扣
      const pct = parseFloat(reward.discountPercentage) / 100
      discountCents = Math.round(subtotalCents * pct)
      if (reward.discountMaxAmount && discountCents > reward.discountMaxAmount) {
        discountCents = reward.discountMaxAmount
      }
    } else if (reward.rewardType === 'FREE_ITEM') {
      const rule = rewardData.freeItemRule
      const selectionMode: string = rule?.selectionMode ?? 'PICK_ONE'
      const pickCount: number = rule?.pickCount ?? 1
      const linkedItemIds: string[] = (rule?.linkedItems ?? []).map((li: any) => li.itemId)
      const linkedCategories: string[] = rule?.linkedCategories ?? []

      // 根据 selectionMode 筛选符合条件的购物车商品
      let eligibleItems: typeof verifiedItems = []
      if (selectionMode === 'PICK_FROM_CATEGORY' && linkedCategories.length > 0) {
        // 按品类匹配
        eligibleItems = verifiedItems.filter(i => i.categoryId && linkedCategories.includes(i.categoryId))
      } else if (linkedItemIds.length > 0) {
        // FIXED / PICK_ONE / PICK_N：按商品 ID 匹配
        eligibleItems = verifiedItems.filter(i => linkedItemIds.includes(i.itemId))
      } else {
        // 无限制，所有商品均可
        eligibleItems = verifiedItems
      }

      if (eligibleItems.length > 0) {
        // 按基础价从低到高排序，免费最便宜的 pickCount 件
        // 只免基础价，加价自定义选项（modifier）仍需顾客支付
        const sorted = [...eligibleItems].sort((a, b) => a.basePrice - b.basePrice)
        const freeItems = sorted.slice(0, pickCount)
        discountCents = freeItems.reduce((sum, i) => sum + i.basePrice, 0)
      }
    }

    console.log('[CheckoutSnapshot] 计算折扣(分):', discountCents)
    return { discountCents }
  } catch (err) {
    console.error('[CheckoutSnapshot] 奖励校验异常，跳过折扣:', err)
    return { discountCents: 0 }
  }
}

// 获取 Item Service 的商品价格（通过 API Gateway 公开接口）
async function getItemPrices(merchantId: string, itemIds: string[], channelCode?: string) {
  try {
    const apiGatewayUrl = process.env.API_GATEWAY_URL || 'http://localhost:8000'
    const response = await axios.get(
      `${apiGatewayUrl}/api/public/merchants/${merchantId}/items`,
      {
        params: {
          limit: 1000,
          page: 1,
          // 传入渠道码让 item-management 返回渠道定价（与前端展示逻辑一致）
          ...(channelCode ? { channelCode } : {}),
        },
        headers: {
          'X-Merchant-Id': merchantId,
        },
      }
    )
    const allItems = response.data.data || []
    return allItems.filter((item: any) => itemIds.includes(item.id))
  } catch (error) {
    console.error('[CheckoutSnapshot] Failed to fetch item prices:', error)
    throw new Error('Failed to fetch item prices from Item Service')
  }
}

// 计算修饰符价格
function calculateModifiersPrice(modifiers: any, itemModifierGroups: any): number {
  if (!modifiers || !itemModifierGroups) return 0

  let modifiersTotal = 0
  console.log('[CheckoutSnapshot] calculateModifiersPrice - modifiers:', JSON.stringify(modifiers))
  console.log('[CheckoutSnapshot] calculateModifiersPrice - itemModifierGroups count:', itemModifierGroups?.length)

  for (const [groupId, selectedOptions] of Object.entries(modifiers)) {
    // 从 item_modifier_groups 中查找对应的修饰符组
    const itemModGroup = itemModifierGroups.find((img: any) =>
      img.modifier_groups?.id === groupId
    )

    if (!itemModGroup) {
      console.log(`[CheckoutSnapshot] No itemModGroup found for groupId: ${groupId}`)
      continue
    }

    if (!itemModGroup?.modifier_groups) {
      console.log(`[CheckoutSnapshot] No modifier_groups in itemModGroup for groupId: ${groupId}`)
      continue
    }

    const group = itemModGroup.modifier_groups
    console.log(`[CheckoutSnapshot] Found modifier group: ${group.name || group.id}`)

    for (const optionId of selectedOptions as string[]) {
      const option = group.modifier_options?.find((o: any) => o.id === optionId)
      if (!option) {
        console.log(`[CheckoutSnapshot] Option ${optionId} not found in group ${groupId}`)
        continue
      }

      console.log(`[CheckoutSnapshot] Processing option: ${option.name || option.id}`)
      console.log(`[CheckoutSnapshot] Option full data:`, JSON.stringify(option))

      if (option?.item_modifier_prices?.length > 0) {
        // 使用第一个价格调整
        // ⚠️ item_modifier_prices.price 是 BigInt 类型，必须转为 Number
        const price = Number(option.item_modifier_prices[0].price) || 0
        console.log(`[CheckoutSnapshot] Option ${option.name} has price from item_modifier_prices: ${price}`)
        modifiersTotal += price
      } else {
        // 备用方案：如果没有 item_modifier_prices，尝试使用 price 或 default_price
        // ⚠️ default_price 也是 BigInt 类型，必须转为 Number
        const fallbackPrice = Number(option.price || option.default_price || 0)
        console.log(`[CheckoutSnapshot] Option ${option.name || option.id} has no item_modifier_prices, using fallback price: ${fallbackPrice}`)
        modifiersTotal += fallbackPrice || 0
      }
    }
  }
  console.log(`[CheckoutSnapshot] Total modifiersPrice: ${modifiersTotal}`)
  return modifiersTotal
}

// 从验证后的商品数据中提取完整修饰符信息（用于创建关系记录）
function extractVerifiedModifiers(
  modifiers: any,
  itemModifierGroups: any
): Array<{
  groupId: string
  optionId: string
  groupName: string
  optionName: string
  optionCode: string | undefined
  unitPrice: number
  quantity: number
}> {
  if (!modifiers || !itemModifierGroups) return []

  const result: Array<{
    groupId: string
    optionId: string
    groupName: string
    optionName: string
    optionCode: string | undefined
    unitPrice: number
    quantity: number
  }> = []

  for (const [groupId, selectedOptions] of Object.entries(modifiers)) {
    const itemModGroup = itemModifierGroups.find(
      (img: any) => img.modifier_groups?.id === groupId
    )
    if (!itemModGroup?.modifier_groups) continue

    const group = itemModGroup.modifier_groups

    for (const optionId of selectedOptions as string[]) {
      const option = group.modifier_options?.find((o: any) => o.id === optionId)
      if (!option) continue

      // 确定价格：优先使用 item_modifier_prices
      // ⚠️ price/default_price 是 BigInt，JSON 序列化后为字符串，必须转 Number
      let price = 0
      if (option?.item_modifier_prices?.length > 0) {
        price = Number(option.item_modifier_prices[0].price) || 0
      } else {
        price = Number(option.price || option.default_price || 0)
      }

      // 提取打印代码：优先 modifier_option_print_configs，回退到 option.code
      const printCode = option.modifier_option_print_configs?.[0]?.print_code
      const optionCode = (printCode != null && printCode !== '') ? printCode : (option.code || undefined)

      result.push({
        groupId,
        optionId,
        groupName: group.display_name || group.name || groupId,
        optionName: option.display_name || option.name || optionId,
        optionCode,
        unitPrice: Math.round(price),
        quantity: 1,
      })
    }
  }

  return result
}

// 从商品数据中提取税率信息
function extractTaxRatesFromItems(items: any[]): Array<{ name: string; rate: number; isCompound: boolean }> {
  const taxRatesMap = new Map<string, { name: string; rate: number; isCompound: boolean }>()

  for (const item of items) {
    if (item.item_tax_rates && Array.isArray(item.item_tax_rates)) {
      for (const itr of item.item_tax_rates) {
        // item service 返回的关联字段名是 tax_rate（兼容旧字段名 tenant_tax_rates）
        const tr = itr.tax_rate || itr.tenant_tax_rates
        if (tr && tr.id) {
          // 使用 id 作为唯一键，避免重复
          taxRatesMap.set(tr.id, {
            name: tr.name || 'Tax',
            rate: Number(tr.rate) || 0,
            isCompound: tr.is_compound || false,
          })
        }
      }
    }
  }

  return Array.from(taxRatesMap.values())
}

// 计算税费（支持非复合税和复合税）
function calculateTax(subtotal: number, taxRates: Array<{ name: string; rate: number; isCompound: boolean }>): number {
  // 没有配置税率则不计税
  if (!taxRates || taxRates.length === 0) {
    return 0
  }

  // 分离非复合税和复合税
  const nonCompoundTaxes = taxRates.filter(t => !t.isCompound)
  const compoundTaxes = taxRates.filter(t => t.isCompound)

  // 计算非复合税
  let taxAmount = 0
  for (const tax of nonCompoundTaxes) {
    taxAmount += Math.round(subtotal * tax.rate)
  }

  // 计算复合税（基础为 subtotal + 非复合税）
  const baseForCompoundTax = subtotal + taxAmount
  for (const tax of compoundTaxes) {
    taxAmount += Math.round(baseForCompoundTax * tax.rate)
  }

  console.log('[CheckoutSnapshot] Tax calculation:', { subtotal, nonCompoundTaxes: nonCompoundTaxes.length, compoundTaxes: compoundTaxes.length, taxAmount })
  return taxAmount
}

/**
 * 创建结账快照（后端验证价格）
 */
export async function createCheckoutSnapshot(
  merchantId: string,
  data: CreateSnapshotDto
): Promise<{
  success: boolean
  data?: {
    snapshotId: string
    expiresAt: string
    pricing: SnapshotPricing
  }
  error?: string
  message?: string
  pricing?: SnapshotPricing
}> {
  try {
    // 0. 提前查渠道配置（后续折扣计算和定价都需要）
    let channelConfig: any = null
    let channelCode: string | undefined
    if (data.salesChannelId) {
      channelConfig = await prisma.orderSourceConfig.findFirst({
        where: { id: data.salesChannelId, tenantId: merchantId, isActive: true },
      })
      if (channelConfig) {
        // sourceType 即 channel_code（均大写存储，查询时转小写）
        channelCode = channelConfig.sourceType?.toLowerCase()
      }
    }

    // 1. 调用 Item Service 获取商品真实价格（传入渠道码以获取渠道定价）
    const itemIds = data.items.map(item => item.itemId)
    console.log('[CheckoutSnapshot] Fetching item prices for:', itemIds, channelCode ? `(channelCode: ${channelCode})` : '')
    const itemPrices = await getItemPrices(merchantId, itemIds, channelCode)
    console.log('[CheckoutSnapshot] Received item prices:', itemPrices.length, 'items')

    // 2. 验证并重新计算每个商品的价格
    const verifiedItems = data.items.map(item => {
      const realItem = itemPrices.find((p: any) => p.id === item.itemId)
      if (!realItem) {
        throw new Error(`Item not found: ${item.itemId}`)
      }

      // 计算真实单价（基础价 + 修饰符价格）
      // 注意：Item Service 公开接口返回 base_price（以分为单位，可能是字符串）
      const basePrice = parseInt(String(realItem.base_price), 10) || 0  // 转换为数字，单位：分
      // 使用结构化的 selectedOptions（优先）或旧的 modifiers 文本
      const modifierData = item.selectedOptions || item.modifiers
      const modifiersPrice = calculateModifiersPrice(modifierData, realItem.item_modifier_groups)  // 分
      const realUnitPrice = basePrice + modifiersPrice  // 分，保持原单位

      console.log('[CheckoutSnapshot] Item detail:', {
        itemId: item.itemId,
        itemName: realItem.name,
        quantity: item.quantity,
        basePrice,
        modifiers: item.modifiers,
        selectedOptions: item.selectedOptions,
        modifierDataUsed: modifierData ? 'selectedOptions' : 'none',
        modifiersPrice,
        realUnitPrice,
        itemTotalPrice: realUnitPrice * item.quantity
      })

      return {
        itemId: item.itemId,
        itemName: realItem.name,
        categoryId: realItem.category_id ?? null,  // 用于 FREE_ITEM PICK_FROM_CATEGORY 匹配
        quantity: item.quantity,
        basePrice,        // 分，不含 modifier，FREE_ITEM 折扣只免这部分
        unitPrice: realUnitPrice,  // 分
        modifiers: item.modifiers,
        // 完整的修饰符信息（用于创建 OrderItemModifier 关系记录）
        verifiedModifiers: extractVerifiedModifiers(modifierData, realItem.item_modifier_groups),
      }
    })

    console.log('[CheckoutSnapshot] Verified items summary:', verifiedItems.map(i => ({
      itemId: i.itemId,
      itemName: i.itemName,
      quantity: i.quantity,
      unitPrice: i.unitPrice,
      totalPrice: i.unitPrice * i.quantity
    })))

    // 3. 重新计算订单价格（所有计算保持在分的单位）
    const subtotal = verifiedItems.reduce(
      (sum, item) => sum + item.unitPrice * item.quantity,
      0
    )  // 分

    // 3.5 积分奖励折扣（Consumer 携带 grantedRewardId 时校验并计算折扣）
    let discountAmount = 0
    if (data.grantedRewardId && data.consumerId) {
      const { discountCents } = await resolveRewardDiscount(
        data.grantedRewardId,
        data.consumerId,
        subtotal,
        verifiedItems
      )
      discountAmount = Math.min(discountCents, subtotal)  // 折扣不超过小计
    }

    // 3.6 渠道折扣（复用步骤0已查到的 channelConfig，防止前端篡改金额）
    let channelDiscountAmount = 0
    let channelConfigId: string | undefined
    let channelName: string | undefined
    if (channelConfig) {
      channelConfigId = channelConfig.id
      channelName = channelConfig.sourceName
      const rules = channelConfig.checkoutRules as any
      const discount = rules?.orderDiscount
      if (discount?.enabled) {
        if (discount.type === 'PERCENTAGE') {
          channelDiscountAmount = Math.round(subtotal * (discount.value / 100))
        } else if (discount.type === 'FIXED') {
          channelDiscountAmount = Math.min(discount.value, subtotal)
        }
      }
    }

    // 折后小计（用于税费计算）
    const discountedSubtotal = subtotal - discountAmount - channelDiscountAmount

    // 4. 从商品数据中提取税率，计算税费
    const taxRates = extractTaxRatesFromItems(itemPrices)
    console.log('[CheckoutSnapshot] Extracted tax rates:', taxRates)
    const taxAmount = calculateTax(discountedSubtotal, taxRates)  // 分

    // 5. 小费由用户决定，直接使用
    const tipAmount = data.tipAmount || 0

    // 5.5 配送费
    const deliveryFee = data.deliveryFee || 0          // 向顾客收取的配送费（分）
    const uberDeliveryFee = data.uberDeliveryFee || 0  // Uber 实际报价的成本（分）

    // 6. 基础订单金额（不含 platformFee）
    const baseTotal = discountedSubtotal + taxAmount + tipAmount + deliveryFee

    // 7. 平台费：记账渠道免收；其他渠道 1% × 非礼品卡支付部分（税前）
    const isAccountChannel = !!channelConfig && channelConfig.checkoutMode === 'CREDIT_ACCOUNT'
    const preTaxBase = discountedSubtotal + tipAmount + deliveryFee
    const gcDeductionEstimate = Math.max(0, Math.min(data.giftCardDeductionEstimate || 0, baseTotal))
    const stripePayablePart = Math.max(0, preTaxBase - gcDeductionEstimate)
    const platformFee = isAccountChannel ? 0 : Math.round(stripePayablePart * 0.01)

    // 8. 总价 = 基础金额 + 平台费
    const total = baseTotal + platformFee

    // 8. 可选：检查价格差异
    if (data.expectedTotal !== undefined) {
      const diff = Math.abs(total - data.expectedTotal)
      const tolerance = 100 // 容差 $1（100 分）

      if (diff > tolerance) {
        // 价格差异较大，返回新价格让用户确认
        const pricing: SnapshotPricing = {
          subtotal,
          taxAmount,
          tipAmount,
          platformFee,
          deliveryFee,
          discountAmount,
          grantedRewardId: data.grantedRewardId,
          total,
        }
        return {
          success: false,
          error: 'PRICE_CHANGED',
          message: 'Price has changed, please review the new price',
          pricing,
        }
      }
    }

    // 9. 创建快照（使用后端计算的价格）
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000) // 30 分钟后过期

    console.log('[CheckoutSnapshot] Creating snapshot with pricing:', { subtotal, discountAmount, channelDiscountAmount, taxAmount, platformFee, tipAmount, deliveryFee, total })
    const snapshot = await prisma.checkoutSnapshot.create({
      data: {
        merchantId,
        consumerId: data.consumerId || undefined,
        orderType: data.orderType,
        customerName: data.customer.name,
        customerPhone: data.customer.phone,
        customerEmail: data.customer.email,
        items: verifiedItems,
        pricing: {
          subtotal,
          taxAmount,
          tipAmount,
          platformFee,
          deliveryFee,
          uberDeliveryFee,
          deliveryQuoteId: data.deliveryQuoteId || undefined,
          discountAmount,
          channelDiscountAmount,
          channelConfigId,
          channelName,
          grantedRewardId: data.grantedRewardId || undefined,
          total,
        },
        notes: data.notes,
        customLabelData: data.customLabelData ?? undefined,
        deliveryAddress: data.deliveryAddress ?? undefined,
        scheduledAt: (data.isScheduled && data.scheduledAt) ? new Date(data.scheduledAt) : undefined,
        expiresAt,
      },
    })

    // 转换为美元返回给前端
    const pricing: SnapshotPricing = {
      subtotal: subtotal / 100,
      taxAmount: taxAmount / 100,
      tipAmount: (data.tipAmount || 0) / 100,
      platformFee: platformFee / 100,
      deliveryFee: deliveryFee / 100,
      uberDeliveryFee: uberDeliveryFee / 100,
      discountAmount: discountAmount / 100,
      channelDiscountAmount: channelDiscountAmount / 100,
      channelConfigId,
      grantedRewardId: data.grantedRewardId,
      total: total / 100,
    }

    console.log('[CheckoutSnapshot] Snapshot created successfully:', snapshot.id)
    return {
      success: true,
      data: {
        snapshotId: snapshot.id,
        expiresAt: expiresAt.toISOString(),
        pricing,
      },
    }
  } catch (error: any) {
    console.error('[CheckoutSnapshot] Error creating snapshot:', error)
    throw error
  }
}

/**
 * 获取快照详情
 */
export async function getSnapshotById(snapshotId: string) {
  return prisma.checkoutSnapshot.findUnique({
    where: { id: snapshotId },
  })
}

/**
 * 定时清理过期快照（定时任务调用）
 */
export async function cleanExpiredSnapshots() {
  const result = await prisma.checkoutSnapshot.deleteMany({
    where: {
      status: 'PENDING',
      expiresAt: { lt: new Date() },
    },
  })
  console.log(`[CheckoutSnapshot] Cleaned ${result.count} expired snapshots`)
  return result
}
