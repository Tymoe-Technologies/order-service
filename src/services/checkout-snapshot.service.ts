import { PrismaClient } from '../../node_modules/.prisma/client-order'
import axios from 'axios'
import { isTypeAllowed } from './fulfillment-option.service'
import {
  type TaxablePortion,
  extractTaxRatesFromRelations,
  extractTaxRatesFromItems,
  buildItemTaxPortions,
  calculateOrderTax,
  calculateAllocatedTax,
} from './tax-calculation'

const prisma = new PrismaClient()

const FINANCE_SERVICE_URL = process.env.FINANCE_SERVICE_URL || 'http://localhost:7007'

/**
 * 向 finance 的平台费策略服务取消费者平台费（单位：分）
 *
 * 费率的唯一权威来源是 finance 的 platform_fee_policies 表，这里只负责问、不负责算。
 *
 * 取不到时返回 0 而不是回退某个默认费率：计价是下单主链路，不能因为 finance 抖动就
 * 阻断结账；而在“少收”和“按一个可能已经过期的数字乱收”之间，只能选少收。
 * 真发生了会留 error 日志，靠对账兜底。
 */
async function quoteConsumerPlatformFee(params: {
  tenantId: string
  skipFees: boolean
  breakdown: {
    subtotal: number
    tax: number
    tip: number
    deliveryFee: number
    giftCardDeduction: number
  }
}): Promise<number> {
  if (params.skipFees) return 0

  try {
    const res = await axios.post<{ data?: { consumerFee?: number } }>(
      `${FINANCE_SERVICE_URL}/internal/platform-fee/quote`,
      {
        tenantId: params.tenantId,
        channel: 'ONLINE',
        breakdown: params.breakdown,
      },
      {
        headers: { 'x-service-api-key': INTERNAL_SERVICE_KEY },
        timeout: 3000,
      }
    )
    return res.data?.data?.consumerFee ?? 0
  } catch (err: any) {
    console.error('[CheckoutSnapshot] 平台费报价失败，本单按 0 计', {
      tenantId: params.tenantId,
      err: err?.message,
    })
    return 0
  }
}

interface CreateSnapshotDto {
  orderType: 'TAKEOUT' | 'DINE_IN' | 'DELIVERY' | 'CURBSIDE' | 'DRIVE_THRU'
  /** CURBSIDE 专用：店员靠这个认车。字段由商家配置决定要不要必填 */
  vehicleInfo?: {
    make?: string
    model?: string
    color?: string
    plate?: string
    spot?: string
  }
  consumerId?: string  // 已登录用户的 Consumer UUID
  customer: {
    name: string
    phone: string
    email?: string
  }
  items: Array<{
    itemId?: string       // 普通商品行；套餐行不传这个，传 comboId
    quantity: number
    modifiers?: any
    selectedOptions?: Record<string, string[]>  // 结构化修饰符数据 { groupId: [optionId] }
    // 套餐行专用字段：comboId 存在即视为套餐行
    comboId?: string
    // 套餐可选分组里顾客选中的 combo_item id 列表（固定必选子项不用传，后端自动带上）
    selectedComboItemIds?: string[]
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
  /**
   * 顾客对耗材的答复（餐具/购物袋等）。只传 ASK / OPT_IN 的答复：
   * quantity=0 表示明确不要，**不传**表示还没答复 —— ASK 模式必须区分这两者。
   * AUTO 的耗材不用传，传了也会被 item-management 忽略。
   */
  supplySelections?: Array<{ supplyId: string; quantity: number }>
}

interface SnapshotPricing {
  subtotal: number
  /** 耗材小计（分）。已包含在 subtotal 内，单列一份供前端分行展示 */
  supplySubtotal?: number
  taxAmount: number
  tipAmount: number
  platformFee: number
  deliveryFee: number
  /** 向顾客收取的配送费税额（分）。已含在 taxAmount 内，单列供对账拆分销项 */
  deliveryFeeTax?: number
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
          // salesChannelCode = 销售渠道码：仅渠道单（有 salesChannelId）传入，
          // item-management 据此返回销售渠道差价；普通单用门店统一价（产品规则）
          ...(channelCode ? { salesChannelCode: channelCode } : {}),
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

// 获取 Item Service 的套餐数据（通过 API Gateway 公开接口）
// 注意：套餐公开接口不返回子项商品的税率，子项的价格/税率仍然要靠 getItemPrices 查
async function getComboPrices(merchantId: string, comboIds: string[], channelCode?: string) {
  try {
    const apiGatewayUrl = process.env.API_GATEWAY_URL || 'http://localhost:8000'
    const response = await axios.get(
      `${apiGatewayUrl}/api/public/merchants/${merchantId}/combos`,
      {
        params: {
          limit: 500,
          page: 1,
          ...(channelCode ? { salesChannelCode: channelCode } : {}),
        },
        headers: {
          'X-Merchant-Id': merchantId,
        },
      }
    )
    const allCombos = response.data.data || []
    return allCombos.filter((combo: any) => comboIds.includes(combo.id))
  } catch (error) {
    console.error('[CheckoutSnapshot] Failed to fetch combo prices:', error)
    throw new Error('Failed to fetch combo prices from Item Service')
  }
}

/** item-management 报价出来的一条耗材行 */
interface QuotedSupplyLine {
  supply_id: string
  /** 按请求 locale 压平后的名字。**别用它落快照**，见 name_default */
  name: string
  /** 英文基准名（catalog_supplies.name 的原值）。订单快照写这个 */
  name_default?: string | null
  /** 各语言译名。打印时各端按自己的票据语言重挑 */
  name_i18n?: Record<string, string> | null
  quantity: number
  unit_price: number   // 分
  total_price: number  // 分
  is_waived: boolean
  prompt_mode: 'ASK' | 'OPT_IN' | 'AUTO'
  origin: 'auto' | 'selected'
  tax_rates: any[]
}

interface SupplyQuote {
  lines: QuotedSupplyLine[]
  total: number
  /** ASK 模式但顾客没给答复的耗材，非空就不允许下单 */
  missingRequired: Array<{ supply_id: string; name: string }>
}

/**
 * 向 item-management 要耗材报价（餐具 / 购物袋 / 配送打包费）。
 *
 * 金额一定要问后端：满额免收的门槛、份数上限、AUTO 收几份全是商家配的规则，
 * 信客户端提交的耗材金额等于让顾客自己决定该付多少。
 *
 * 出错时**不静默跳过**——耗材可能是 AUTO 的打包费，漏了就是少收钱；
 * 也可能是 ASK 的餐具，漏了就是该问没问。直接抛出去让结账失败，比悄悄算错强。
 */
async function quoteSupplies(params: {
  merchantId: string
  orderType: string
  channelCode?: string
  itemsSubtotal: number
  selections: Array<{ supplyId: string; quantity: number }>
}): Promise<SupplyQuote> {
  const apiGatewayUrl = process.env.API_GATEWAY_URL || 'http://localhost:8000'
  try {
    const response = await axios.post(
      `${apiGatewayUrl}/api/public/merchants/${params.merchantId}/supplies/quote`,
      {
        orderType: params.orderType,
        salesChannelCode: params.channelCode,
        itemsSubtotal: params.itemsSubtotal,
        selections: params.selections,
      },
      { headers: { 'X-Merchant-Id': params.merchantId }, timeout: 5000 }
    )
    const data = response.data?.data ?? {}
    return {
      lines: data.lines ?? [],
      total: data.total ?? 0,
      missingRequired: data.missing_required ?? [],
    }
  } catch (error: any) {
    console.error('[CheckoutSnapshot] 耗材报价失败:', error?.message)
    throw new Error('Failed to fetch supply quote from Item Service')
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

// 从验证后的商品数据中提取完整修饰符信息（用于创建关系记录 + 逐段计税）
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
  /** 该选项自己的税率。空数组 = 没单独配，计税时回退到所属商品的税率 */
  taxRates: Array<{ name: string; rate: number; isCompound: boolean }>
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
    taxRates: Array<{ name: string; rate: number; isCompound: boolean }>
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
        taxRates: extractTaxRatesFromRelations(option.tax_rates),
      })
    }
  }

  return result
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
    // 0.0 商家有没有开这种履约方式。前端只是不显示未启用的选项，挡不住直接打接口；
    // 收下一单没法履约的 curbside，损失比拒掉大得多
    const typeAllowed = await isTypeAllowed(merchantId, data.orderType)
    if (!typeAllowed) {
      return {
        success: false,
        error: 'FULFILLMENT_NOT_AVAILABLE',
        message: `This store does not offer ${data.orderType} orders`,
      }
    }

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

    // 1. 拆开普通商品行和套餐行，套餐要先查套餐详情才知道子项商品是谁
    const itemLines = data.items.filter(item => !item.comboId)
    const comboLines = data.items.filter(item => !!item.comboId)

    const comboIds = comboLines.map(item => item.comboId!)
    const comboPrices = comboIds.length > 0
      ? await getComboPrices(merchantId, comboIds, channelCode)
      : []
    console.log('[CheckoutSnapshot] Received combo prices:', comboPrices.length, 'combos')

    // 套餐子项商品的价格/税率仍然要靠 getItemPrices 查（套餐公开接口不返回子项税率），
    // 所以要把套餐里引用到的所有子项商品 id，跟普通商品行的 itemId 合并成一次批量查询
    const comboChildItemIds = comboPrices.flatMap((combo: any) =>
      (combo.combo_items || []).map((ci: any) => ci.item?.id).filter(Boolean)
    )
    const itemIds = Array.from(new Set([
      ...itemLines.map(item => item.itemId!),
      ...comboChildItemIds,
    ]))
    console.log('[CheckoutSnapshot] Fetching item prices for:', itemIds, channelCode ? `(channelCode: ${channelCode})` : '')
    const itemPrices = itemIds.length > 0
      ? await getItemPrices(merchantId, itemIds, channelCode)
      : []
    console.log('[CheckoutSnapshot] Received item prices:', itemPrices.length, 'items')

    // 2. 验证并重新计算每一行的价格（普通商品行 / 套餐行分别处理）
    const verifiedItems = data.items.map(item => {
      if (item.comboId) {
        const realCombo = comboPrices.find((c: any) => c.id === item.comboId)
        if (!realCombo) {
          throw new Error(`Combo not found: ${item.comboId}`)
        }

        const comboBasePrice = parseInt(String(realCombo.base_price), 10) || 0
        const allComboItems: any[] = realCombo.combo_items || []

        // 固定必选子项（不属于任何可选分组）不需要顾客指定，后端直接带上；
        // 可选分组里的子项必须是顾客传的 selectedComboItemIds，且必须真的属于这个套餐——
        // 防止顾客伪造 id 把别的套餐/别的分组的高价子项塞进来白嫖
        const requiredItems = allComboItems.filter((ci: any) => !ci.group_id && ci.is_required)
        const selectedIds = new Set(item.selectedComboItemIds || [])
        const selectedOptionalItems = allComboItems.filter((ci: any) => ci.group_id && selectedIds.has(ci.id))
        const chosenComboItems = [...requiredItems, ...selectedOptionalItems]

        if (chosenComboItems.length === 0) {
          throw new Error(`No valid combo items selected for combo: ${item.comboId}`)
        }

        // 可选项加价（additionalPrice）加总，套餐总价 = 品牌/门店/渠道已经合并好的基础价 + 加价
        const additionalPriceTotal = chosenComboItems.reduce(
          (sum, ci) => sum + (parseInt(String(ci.additional_price), 10) || 0), 0
        )
        const realUnitPrice = comboBasePrice + additionalPriceTotal

        // 按子项商品的单卖标价(× quantity)做权重分摊计税，子项各自税率不同也能算对
        // （跟 POS 前端 taxCalculation.ts 的套餐分摊算法是同一个思路）
        const comboAllocation: TaxablePortion[] = chosenComboItems.map((ci: any) => {
          const childItem = itemPrices.find((p: any) => p.id === ci.item?.id)
          const childBasePrice = childItem ? (parseInt(String(childItem.base_price), 10) || 0) : 0
          return {
            weight: childBasePrice * (ci.quantity || 1),
            taxRates: childItem ? extractTaxRatesFromItems([childItem]) : [],
          }
        })

        console.log('[CheckoutSnapshot] Combo detail:', {
          comboId: item.comboId,
          comboName: realCombo.name,
          quantity: item.quantity,
          comboBasePrice,
          additionalPriceTotal,
          realUnitPrice,
          chosenComboItemCount: chosenComboItems.length,
        })

        return {
          itemId: item.comboId,   // 占位用 comboId：FREE_ITEM/分类匹配这类逻辑按真实 itemId 匹配，套餐天然不会命中，符合预期
          itemName: realCombo.name,
          categoryId: realCombo.category?.id ?? null,
          quantity: item.quantity,
          basePrice: realUnitPrice,  // 套餐没有"不含加价"这个子概念，跟 unitPrice 一致即可
          unitPrice: realUnitPrice,
          modifiers: null,
          taxRates: [] as Array<{ name: string; rate: number; isCompound: boolean }>,  // 套餐没有自己的税率，走 comboAllocation
          verifiedModifiers: [] as ReturnType<typeof extractVerifiedModifiers>,
          isCombo: true,
          comboId: item.comboId,
          comboAllocation,
          // 落库到 OrderItem.comboSelections 的快照，供收据/厨房显示这份套餐具体选了什么
          comboSelections: chosenComboItems.map((ci: any) => ({
            itemId: ci.item?.id,
            itemName: ci.item?.name,
            quantity: ci.quantity,
            additionalPrice: parseInt(String(ci.additional_price), 10) || 0,
          })),
        }
      }

      if (!item.itemId) {
        throw new Error('Each order line must have either itemId or comboId')
      }
      const itemId = item.itemId
      const realItem = itemPrices.find((p: any) => p.id === itemId)
      if (!realItem) {
        throw new Error(`Item not found: ${itemId}`)
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

      // 该商品自身的税率（逐行计税用，不与其他商品的税率混合）
      const itemTaxRates = extractTaxRatesFromItems([realItem])
      // 完整的修饰符信息（用于创建 OrderItemModifier 关系记录 + 逐段计税）
      const verifiedModifiers = extractVerifiedModifiers(modifierData, realItem.item_modifier_groups)

      return {
        itemId,
        itemName: realItem.name,
        categoryId: realItem.category_id ?? null,  // 用于 FREE_ITEM PICK_FROM_CATEGORY 匹配
        quantity: item.quantity,
        basePrice,        // 分，不含 modifier，FREE_ITEM 折扣只免这部分
        unitPrice: realUnitPrice,  // 分
        modifiers: item.modifiers,
        taxRates: itemTaxRates,
        verifiedModifiers,
        // 计税分段：商品基础价一段 + 每个选项一段，选项没配税率则回退商品税率
        taxPortions: buildItemTaxPortions(basePrice, item.quantity, verifiedModifiers, itemTaxRates),
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
    // 这里的 subtotal 只含商品/套餐 —— 折扣、奖励都只能打在商品上，耗材（袋子、
    // 打包费）不参与打折，所以它要等折扣算完之后再单独并进来（见步骤 3.7）
    const productSubtotal = verifiedItems.reduce(
      (sum, item) => sum + item.unitPrice * item.quantity,
      0
    )  // 分
    const subtotal = productSubtotal

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

    // 折后商品小计（用于税费计算）
    const discountedSubtotal = subtotal - discountAmount - channelDiscountAmount

    // 3.7 耗材报价（餐具/购物袋/配送打包费）
    //
    // 必须排在折扣之后：满额免收的门槛看的是顾客实际付的商品钱，
    // 拿折前金额去判断会出现「打完折没到门槛却免了打包费」。
    const supplyQuote = await quoteSupplies({
      merchantId,
      orderType: data.orderType,
      channelCode,
      itemsSubtotal: discountedSubtotal,
      selections: data.supplySelections ?? [],
    })

    // ASK 类耗材（餐具）没答复就不许下单。这不是前端校验能替代的：
    // 「不问不给」是法规要求，服务端必须自己拦一道。
    if (supplyQuote.missingRequired.length > 0) {
      return {
        success: false,
        error: 'SUPPLY_SELECTION_REQUIRED',
        message: `Please answer the supply options: ${supplyQuote.missingRequired.map(m => m.name).join(', ')}`,
      }
    }

    const supplySubtotal = supplyQuote.total
    // 耗材行也进 orderItems，所以 subtotal 必须把它算进去，
    // 否则 subtotal ≠ Σ orderItems.totalPrice，对账时两边对不上
    const subtotalWithSupplies = subtotal + supplySubtotal

    // 4. 逐行计税：每行按该商品自身税率计税（税率并集乘整单会对不该征税的商品征税），
    //    折扣按各行小计占比分摊到行后再计税，Σ行折扣 = 总折扣（末行吃余数）。
    //    行内再分段：商品基础价一段、每个收费选项一段，选项可以有自己的税率
    //    （免税饮品 + 收税配料这种组合，整行套商品税率会漏收配料的税）。
    const totalDiscount = discountAmount + channelDiscountAmount
    const productTax = calculateOrderTax(  // 分
      verifiedItems.map(vi => {
        const lineSubtotal = vi.unitPrice * vi.quantity
        // 套餐行按子项标价权重分摊，普通商品行按「基础价 + 各选项」分段；
        // 两者都没有时退化成整行一段（用商品自身税率），与改造前等价
        const portions: TaxablePortion[] =
          (vi as any).comboAllocation ??
          (vi as any).taxPortions ??
          [{ weight: lineSubtotal, taxRates: vi.taxRates }]
        return { lineSubtotal, portions }
      }),
      totalDiscount
    )

    // 耗材单独走一次计税，折扣传 0 —— 不能跟商品行合起来调用：
    // calculateOrderTax 会把折扣按行小计分摊到**每一行**，耗材混进去就等于
    // 把商品的折扣分了一部分到袋子上，商品那边少扣、袋子那边白扣
    const supplyTax = calculateOrderTax(
      supplyQuote.lines.map(line => ({
        lineSubtotal: line.total_price,
        portions: [{
          weight: line.total_price,
          taxRates: extractTaxRatesFromRelations(line.tax_rates),
        }] as TaxablePortion[],
      })),
      0
    )

    // 配送费。定义提前到计税之前——下面算配送费税要用它
    const deliveryFee = data.deliveryFee || 0          // 向顾客收取的配送费（分，已扣商家补贴）
    const uberDeliveryFee = data.uberDeliveryFee || 0  // Uber 实际报价的成本（分）

    /*
      配送费的税。Uber Direct 是白标派送——顾客在商家自有渠道下单、钱进商家账户，
      商家是 Merchant of Record，所以这笔税由商家收缴（Uber Eats 平台单才是平台代收）。

      税率跟随所配送的商品，按各商品行金额加权分摊：一单里既有 5% GST 的餐食
      又有 12% 的酒时，配送费按金额比例拆开分别计税，而不是整单套一个税率。
      这正好是 calculateAllocatedTax 的用途，不用新写算法。

      计税基数用 deliveryFee 而不是 uberDeliveryFee：前者已经扣掉商家补贴
      （MERCHANT_SUBSIDY 规则下 customerFee = max(0, 报价 - 补贴)），
      只有顾客自掏腰包的那部分才向顾客收税。满额免运时 deliveryFee = 0，税也是 0。

      分摊权重只取商品行，不含耗材：袋子、打包盒是附属包装，不是被配送的标的物。
    */
    const deliveryFeeTax = deliveryFee > 0
      ? calculateAllocatedTax(
          deliveryFee,
          verifiedItems.map(vi => ({
            weight: vi.unitPrice * vi.quantity,
            taxRates: vi.taxRates ?? [],
          })),
        )
      : 0

    const taxAmount = productTax + supplyTax + deliveryFeeTax
    console.log('[CheckoutSnapshot] Per-line tax total:', taxAmount,
      '(商品', productTax, '耗材', supplyTax, '配送费', deliveryFeeTax, ')')

    // 5. 小费由用户决定，直接使用
    const tipAmount = data.tipAmount || 0


    // 6. 基础订单金额（不含 platformFee）。耗材不打折，所以是折后商品 + 耗材原价
    const baseTotal = discountedSubtotal + supplySubtotal + taxAmount + tipAmount + deliveryFee

    // 7. 消费者平台费：向 finance 的平台费策略服务取，本地不再硬编码费率。
    //    原来这里写死 1%，consumer-app 的结账页又写了一遍，调价要同时发两个版；
    //    现在费率统一存 finance 的 platform_fee_policies，改配置即可生效。
    //    记账渠道（CREDIT_ACCOUNT）不走收单通道，两种平台费都不收。
    const isAccountChannel = !!channelConfig && channelConfig.checkoutMode === 'CREDIT_ACCOUNT'
    const gcDeductionEstimate = Math.max(0, Math.min(data.giftCardDeductionEstimate || 0, baseTotal))
    const platformFee = await quoteConsumerPlatformFee({
      tenantId: merchantId,
      skipFees: isAccountChannel,
      breakdown: {
        // 耗材也是顾客实付的一部分，平台费基数要含它
        subtotal: discountedSubtotal + supplySubtotal,
        tax: taxAmount,
        tip: tipAmount,
        deliveryFee,
        giftCardDeduction: gcDeductionEstimate,
      },
    })

    // 8. 总价 = 基础金额 + 平台费
    const total = baseTotal + platformFee

    // 8. 可选：检查价格差异
    if (data.expectedTotal !== undefined) {
      const diff = Math.abs(total - data.expectedTotal)
      const tolerance = 100 // 容差 $1（100 分）

      if (diff > tolerance) {
        // 价格差异较大，返回新价格让用户确认
        const pricing: SnapshotPricing = {
          subtotal: subtotalWithSupplies,
          supplySubtotal,
          taxAmount,
          tipAmount,
          platformFee,
          deliveryFee,
          deliveryFeeTax,
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

    console.log('[CheckoutSnapshot] Creating snapshot with pricing:', { subtotal: subtotalWithSupplies, supplySubtotal, discountAmount, channelDiscountAmount, taxAmount, platformFee, tipAmount, deliveryFee, total })

    // 耗材行拼成和商品行同构的形状，一起存进快照 —— 建订单时统一 map 成 OrderItem，
    // isSupply 标记让落库那步知道该写 lineKind=SUPPLY
    const supplySnapshotLines = supplyQuote.lines.map(line => ({
      itemId: line.supply_id,
      /*
        ★ 落**英文基准名**，不是压平后的 name。

        item_name 是快照，而压平后的名字取决于下单时顾客界面是什么语言 ——
        同一个购物袋会按顾客语言存成几种名字：报表按名字分组会拆成几行，
        票据也没法按自己配置的语言重挑（商品名踩过同一个坑，
        实测「经典奶茶」和「Black Milk Tea」在热销榜上是两行）。

        老版本 item-service 不返回 name_default 时退回 name，行为不变。
      */
      itemName: line.name_default || line.name,
      quantity: line.quantity,
      unitPrice: line.unit_price,
      isSupply: true,
      supplyOrigin: line.origin === 'auto' ? 'AUTO' : 'SELECTED',
      isWaived: line.is_waived,
      taxRates: extractTaxRatesFromRelations(line.tax_rates),
    }))

    const snapshot = await prisma.checkoutSnapshot.create({
      data: {
        merchantId,
        consumerId: data.consumerId || undefined,
        orderType: data.orderType,
        customerName: data.customer.name,
        customerPhone: data.customer.phone,
        customerEmail: data.customer.email,
        // 商品行/套餐行两种形状的联合类型让 Prisma 的 JSON 类型推导过不去，转成 any（存的就是普通JSON快照）
        items: [...verifiedItems, ...supplySnapshotLines] as any,
        pricing: {
          subtotal: subtotalWithSupplies,
          supplySubtotal,
          taxAmount,
          tipAmount,
          platformFee,
          deliveryFee,
          deliveryFeeTax,
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
        // CURBSIDE 的车辆信息随快照一起锁定，建单时原样搬进 Order
        vehicleInfo: data.vehicleInfo ?? undefined,
        scheduledAt: (data.isScheduled && data.scheduledAt) ? new Date(data.scheduledAt) : undefined,
        expiresAt,
      },
    })

    // 转换为美元返回给前端
    const pricing: SnapshotPricing = {
      subtotal: subtotalWithSupplies / 100,
      supplySubtotal: supplySubtotal / 100,
      taxAmount: taxAmount / 100,
      tipAmount: (data.tipAmount || 0) / 100,
      platformFee: platformFee / 100,
      deliveryFee: deliveryFee / 100,
      deliveryFeeTax: deliveryFeeTax / 100,
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
