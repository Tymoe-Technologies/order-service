# 多端订单服务架构设计

## 1. 架构概览

### 1.1 核心原则
- **统一订单模型**: 所有订单使用统一的数据结构
- **来源识别**: 通过 `orderSource` 字段区分订单来源
- **差异化处理**: 不同来源的订单有不同的业务逻辑和验证规则
- **差异化定价**: 支持不同来源设置不同的商品价格(如外卖平台加价)
- **简化订单号**: 非外卖订单使用简单数字序号作为取餐号
- **可扩展性**: 易于添加新的订单来源(如第三方平台)
- **商家自定义**: 商家可以自定义添加订单来源，方便对账和管理

### 1.2 订单来源类型

采用**系统预设 + 商家自定义**的混合模式：

**系统预设来源** (内置处理逻辑):
```typescript
enum SystemOrderSource {
  POS         // POS机 - 员工操作
  WEB         // Web自助点单 - 客户在网页下单
  KIOSK       // Kiosk自助点单 - 客户在自助机下单
  UBER_EATS   // Uber Eats外卖平台
  UBER_DIRECT // Uber Direct配送
  DOORDASH    // DoorDash外卖平台
  GRUBHUB     // GrubHub外卖平台
  PHONE       // 电话订单
  CUSTOM      // 自定义来源(指向 OrderSourceConfig 表)
}
```

**商家自定义来源**:
- 商家可以创建自定义订单来源(如: 美团、饿了么、企业合作、微信小程序等)
- 自定义来源使用 `CUSTOM` 类型，通过 `orderSourceConfigId` 关联到具体配置
- 支持设置来源名称、图标、颜色、费率等信息
- 方便订单统计、对账和财务分析

---

## 2. 数据模型设计

### 2.1 订单来源配置表 (新增)

```prisma
// 订单来源配置表 - 商家自定义订单来源
model OrderSourceConfig {
  id              String    @id @default(uuid()) @db.Uuid
  tenantId        String    @map("tenant_id") @db.Uuid
  
  // 基本信息
  name            String    @db.VarChar(100)  // 来源名称(如: 美团、饿了么、企业合作)
  code            String    @db.VarChar(50)   // 来源代码(用于订单号前缀, 如: MT, ELM)
  description     String?   @db.Text
  
  // 显示设置
  icon            String?   @db.VarChar(255)  // 图标URL
  color           String?   @db.VarChar(20)   // 主题颜色(用于UI显示)
  
  // 费率设置
  platformFeeType String    @default("PERCENTAGE") @map("platform_fee_type") // PERCENTAGE | FIXED
  platformFeeRate Decimal?  @map("platform_fee_rate") @db.Decimal(5, 4)  // 百分比费率(如 0.0500 = 5%)
  platformFeeFixed Decimal? @map("platform_fee_fixed") @db.Decimal(10, 2) // 固定费用
  
  // 定价策略
  priceAdjustmentType String? @default("NONE") @map("price_adjustment_type") // NONE | PERCENTAGE | FIXED
  priceAdjustmentRate Decimal? @map("price_adjustment_rate") @db.Decimal(5, 4) // 价格调整比例(如 0.1000 = 10%加价)
  priceAdjustmentFixed Decimal? @map("price_adjustment_fixed") @db.Decimal(10, 2) // 固定加价金额
  
  // 对账设置
  settlementCycle String?   @map("settlement_cycle") @db.VarChar(50)  // 结算周期(daily, weekly, monthly)
  accountNumber   String?   @map("account_number") @db.VarChar(100)   // 对账账号
  
  // 联系信息
  contactName     String?   @map("contact_name") @db.VarChar(100)
  contactPhone    String?   @map("contact_phone") @db.VarChar(50)
  contactEmail    String?   @map("contact_email") @db.VarChar(255)
  
  // 配置
  config          Json?     @db.Json  // 其他配置(webhook URL, API密钥等)
  
  // 状态
  isActive        Boolean   @default(true) @map("is_active")
  
  // 时间
  createdAt       DateTime  @default(now()) @map("created_at")
  updatedAt       DateTime  @updatedAt @map("updated_at")
  
  // 关联
  orders          Order[]
  
  @@unique([tenantId, code])
  @@index([tenantId, isActive])
  @@map("order_source_configs")
}
```

### 2.2 订单表扩展

```prisma
model Order {
  id                   String              @id @default(uuid()) @db.Uuid
  tenantId             String              @map("tenant_id") @db.Uuid
  orderNumber          String              @unique @map("order_number")
  
  // 订单来源相关
  orderSource          OrderSource         @map("order_source")  // 系统预设来源
  orderSourceConfigId  String?             @map("order_source_config_id") @db.Uuid  // 自定义来源ID
  orderSourceConfig    OrderSourceConfig?  @relation(fields: [orderSourceConfigId], references: [id])
  orderSourceId        String?             @map("order_source_id")  // 第三方平台订单ID
  orderSourceMeta      Json?               @map("order_source_meta") // 来源特定元数据
  
  // 客户信息
  customerName      String?       @map("customer_name")
  customerPhone     String?       @map("customer_phone")
  customerEmail     String?       @map("customer_email")
  
  // 订单类型
  orderType         OrderType     @map("order_type")
  
  // 配送信息(外卖订单)
  deliveryAddress   Json?         @map("delivery_address")
  deliveryNotes     String?       @map("delivery_notes")
  estimatedDelivery DateTime?     @map("estimated_delivery")
  
  // 取餐信息(自助订单)
  pickupName        String?       @map("pickup_name")  // KIOSK取餐名
  pickupNumber      Int?          @map("pickup_number") // 取餐号(非外卖订单使用简单序号)
  
  // 桌号(堂食)
  tableNumber       String?       @map("table_number")
  
  // 金额
  subtotal          Decimal       @db.Decimal(10, 2)
  taxAmount         Decimal       @default(0) @map("tax_amount")
  discountAmount    Decimal       @default(0) @map("discount_amount")
  deliveryFee       Decimal       @default(0) @map("delivery_fee")
  serviceFee        Decimal       @default(0) @map("service_fee")
  platformFee       Decimal       @default(0) @map("platform_fee")  // 第三方平台费用
  totalAmount       Decimal       @map("total_amount")
  
  // 支付信息
  paymentStatus     PaymentStatus @default(PENDING) @map("payment_status")
  paymentMethod     String?       @map("payment_method")
  paidAt            DateTime?     @map("paid_at")
  
  // 订单状态
  status            OrderStatus   @default(PENDING)
  
  // 时间信息
  scheduledFor      DateTime?     @map("scheduled_for")  // 预约时间
  createdAt         DateTime      @default(now()) @map("created_at")
  updatedAt         DateTime      @updatedAt @map("updated_at")
  
  // 创建人(POS订单有,自助订单为空)
  createdBy         String?       @map("created_by") @db.Uuid
  
  // 备注
  notes             String?       @db.Text
  
  // 关联
  orderItems        OrderItem[]
  orderNotes        OrderNote[]
  printRecords      PrintRecord[]
  statusHistory     OrderStatusHistory[]
  
  @@index([tenantId, orderSource, createdAt])
  @@index([orderSource, status])
  @@index([orderSourceId])
  @@index([orderSourceConfigId])
  @@map("orders")
}

// 订单状态历史
model OrderStatusHistory {
  id          String      @id @default(uuid()) @db.Uuid
  orderId     String      @map("order_id") @db.Uuid
  fromStatus  OrderStatus @map("from_status")
  toStatus    OrderStatus @map("to_status")
  reason      String?     @db.Text
  changedBy   String?     @map("changed_by") @db.Uuid
  changedAt   DateTime    @default(now()) @map("changed_at")
  
  order       Order       @relation(fields: [orderId], references: [id], onDelete: Cascade)
  
  @@index([orderId, changedAt])
  @@map("order_status_history")
}

enum PaymentStatus {
  PENDING
  PAID
  FAILED
  REFUNDED
  PARTIALLY_REFUNDED
}

enum OrderType {
  DINE_IN    // 堂食
  TAKEOUT    // 自取/打包
  DELIVERY   // 外卖配送
}

enum OrderNumberType {
  SIMPLE     // 简单序号(1, 2, 3...) - 用于非外卖订单
  COMPLEX    // 复杂格式(MT-20241023-0001) - 用于外卖订单
}

---

## 3. 服务层架构

### 3.1 核心服务结构

```
src/services/
├── order/
│   ├── order.service.ts                # 订单核心服务
│   ├── order-validator.service.ts      # 订单验证服务
│   ├── order-number.service.ts         # 订单号生成服务
│   ├── order-source-config.service.ts  # 订单来源配置服务
│   └── sources/                        # 订单来源处理器
│       ├── base-order-source.ts        # 基础抽象类
│       ├── custom-order.service.ts     # 自定义来源处理器
│       ├── pos-order.service.ts        # POS订单处理
│       ├── kiosk-order.service.ts      # KIOSK订单处理
│       ├── web-order.service.ts        # Web订单处理
│       └── platform/                   # 第三方平台
│           ├── uber-eats.service.ts
│           ├── uber-direct.service.ts
│           └── doordash.service.ts
├── print-queue/                        # WebSocket 打印队列
│   ├── print-queue.ws.ts              # WebSocket 服务端（ws 库）
│   ├── print-task.service.ts          # PrintTask CRUD 及状态管理
│   └── print-task-generator.ts        # 根据 PrintSetting 生成打印任务
```

### 3.2 基础订单来源抽象类

```typescript
// src/services/order/sources/base-order-source.ts
export abstract class BaseOrderSource {
  protected orderSource: OrderSource;

  constructor(orderSource: OrderSource) {
    this.orderSource = orderSource;
  }

  /**
   * 验证订单数据
   */
  abstract validateOrder(data: any): Promise<ValidationResult>;

  /**
   * 转换为标准订单格式
   */
  abstract transformToStandardOrder(data: any): Promise<StandardOrderData>;

  /**
   * 订单创建前的钩子
   */
  async beforeCreate(data: StandardOrderData): Promise<StandardOrderData> {
    return data;
  }

  /**
   * 订单创建后的钩子
   */
  async afterCreate(order: Order): Promise<void> {
    // 默认实现:打印小票
    await this.printReceipt(order);
  }

  /**
   * 获取订单号前缀
   */
  abstract getOrderNumberPrefix(config?: OrderSourceConfig): string;

  /**
   * 打印小票
   */
  protected async printReceipt(order: Order): Promise<void> {
    // 根据orderSource获取对应的小票模板
    // 调用打印服务
  }

  /**
   * 发送通知
   */
  protected async sendNotification(order: Order, type: NotificationType): Promise<void> {
    // 发送通知逻辑
  }
}
```

### 3.3 自定义来源订单处理器 (新增)

```typescript
// src/services/order/sources/custom-order.service.ts
export class CustomOrderService extends BaseOrderSource {
  constructor() {
    super(OrderSource.CUSTOM);
  }

  async validateOrder(data: any, config: OrderSourceConfig): Promise<ValidationResult> {
    const errors: string[] = [];
    
    // 验证必填字段
    if (!data.orderSourceConfigId) {
      errors.push('必须指定订单来源配置ID');
    }
    
    if (!data.items || data.items.length === 0) {
      errors.push('订单必须包含商品');
    }
    
    // 验证来源配置是否激活
    if (!config.isActive) {
      errors.push('该订单来源已被禁用');
    }
    
    return {
      isValid: errors.length === 0,
      errors
    };
  }

  async transformToStandardOrder(
    data: any, 
    config: OrderSourceConfig
  ): Promise<StandardOrderData> {
    // 计算平台费用
    let platformFee = 0;
    if (config.platformFeeType === 'PERCENTAGE') {
      platformFee = data.subtotal * parseFloat(config.platformFeeRate?.toString() || '0');
    } else if (config.platformFeeType === 'FIXED') {
      platformFee = parseFloat(config.platformFeeFixed?.toString() || '0');
    }
    
    return {
      orderSource: OrderSource.CUSTOM,
      orderSourceConfigId: config.id,
      orderSourceId: data.externalOrderId,
      orderType: data.orderType,
      customerName: data.customerName,
      customerPhone: data.customerPhone,
      deliveryAddress: data.deliveryAddress,
      items: data.items,
      subtotal: data.subtotal,
      platformFee: platformFee,
      totalAmount: data.totalAmount,
      orderSourceMeta: {
        customSourceName: config.name,
        customSourceCode: config.code,
        externalOrderId: data.externalOrderId,
        platformFee: platformFee,
        ...data.meta
      }
    };
  }

  /**
   * 是否使用简单订单号(作为取餐号)
   */
  useSimpleOrderNumber(): boolean {
    return true; // 默认使用简单订单号
  }

  getOrderNumberPrefix(config?: OrderSourceConfig): string {
    // 使用自定义来源的代码作为前缀
    return config?.code || 'CUSTOM';
  }

  async afterCreate(order: Order, config: OrderSourceConfig): Promise<void> {
    // 1. 打印小票(如果配置了打印)
    if (config.config?.autoPrint) {
      await this.printReceipt(order);
    }
    
    // 2. 发送webhook通知(如果配置了webhook)
    if (config.config?.webhookUrl) {
      await this.sendWebhook(order, config.config.webhookUrl);
    }
    
    // 3. 记录对账信息
    await this.recordSettlement(order, config);
  }

  private async sendWebhook(order: Order, webhookUrl: string): Promise<void> {
    try {
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'order.created',
          order: {
            id: order.id,
            orderNumber: order.orderNumber,
            status: order.status,
            totalAmount: order.totalAmount
          }
        })
      });
    } catch (error) {
      logger.error('Webhook发送失败', { orderId: order.id, error });
    }
  }

  private async recordSettlement(order: Order, config: OrderSourceConfig): Promise<void> {
    // 记录对账信息到对账表
    // 用于后续财务对账
  }
}
```

### 3.4 POS订单处理器

```typescript
// src/services/order/sources/pos-order.service.ts
export class POSOrderService extends BaseOrderSource {
  constructor() {
    super(OrderSource.POS);
  }

  async validateOrder(data: any): Promise<ValidationResult> {
    // POS订单验证
    // - 必须有员工ID
    // - 必须有商品
    // - 金额必须正确
    return {
      isValid: true,
      errors: []
    };
  }

  async transformToStandardOrder(data: any): Promise<StandardOrderData> {
    return {
      orderSource: OrderSource.POS,
      orderType: data.orderType,
      tableNumber: data.tableNumber,
      items: data.items,
      subtotal: data.subtotal,
      totalAmount: data.totalAmount,
      createdBy: data.userId,
      // POS订单特定字段
      orderSourceMeta: {
        posId: data.posId,
        cashierId: data.userId,
        shift: data.shift
      }
    };
  }

  useSimpleOrderNumber(): boolean {
    return true; // POS订单使用简单序号
  }

  getOrderNumberPrefix(): string {
    return 'POS';
  }

  async afterCreate(order: Order): Promise<void> {
    // 1. 打印小票
    await this.printReceipt(order);
    
    // 2. 如果有厨房商品,打印厨房单
    await this.printKitchenTicket(order);
    
    // 3. 更新POS缓存
    await this.updatePOSCache(order);
  }
}
```

### 3.4 KIOSK订单处理器

```typescript
// src/services/order/sources/kiosk-order.service.ts
export class KioskOrderService extends BaseOrderSource {
  constructor() {
    super(OrderSource.KIOSK);
  }

  async validateOrder(data: any): Promise<ValidationResult> {
    // KIOSK订单验证
    // - 必须有取餐名
    // - 必须已支付
    // - 商品必须可用
    return {
      isValid: true,
      errors: []
    };
  }

  async transformToStandardOrder(data: any): Promise<StandardOrderData> {
    // 生成取餐号
    const pickupNumber = await this.generatePickupNumber();
    
    return {
      orderSource: OrderSource.KIOSK,
      orderType: data.orderType || OrderType.TAKEOUT,
      pickupName: data.customerName,
      pickupNumber: pickupNumber,
      customerPhone: data.customerPhone,
      items: data.items,
      subtotal: data.subtotal,
      totalAmount: data.totalAmount,
      paymentStatus: PaymentStatus.PAID,
      paymentMethod: data.paymentMethod,
      paidAt: new Date(),
      orderSourceMeta: {
        kioskId: data.kioskId,
        language: data.language,
        pickupNumber: pickupNumber
      }
    };
  }

  getOrderNumberPrefix(): string {
    return 'KIOSK';
  }

  async afterCreate(order: Order): Promise<void> {
    // 1. 打印取餐小票(大字体显示取餐号和取餐名)
    await this.printReceipt(order);
    
    // 2. 打印厨房单
    await this.printKitchenTicket(order);
    
    // 3. 显示在叫号屏幕
    await this.displayOnCallScreen(order);
    
    // 4. 发送短信通知(如果有手机号)
    if (order.customerPhone) {
      await this.sendSMSNotification(order);
    }
  }

  private async generatePickupNumber(): Promise<number> {
    // 生成今日取餐号(1-999循环)
    const today = new Date().toISOString().split('T')[0];
    const lastOrder = await prisma.order.findFirst({
      where: {
        orderSource: OrderSource.KIOSK,
        createdAt: {
          gte: new Date(today)
        }
      },
      orderBy: {
        pickupNumber: 'desc'
      }
    });

    const lastNumber = lastOrder?.pickupNumber || 0;
    return (lastNumber % 999) + 1;
  }
}
```

### 3.5 Uber Eats订单处理器

```typescript
// src/services/order/sources/platform/uber-eats.service.ts
export class UberEatsOrderService extends BaseOrderSource {
  constructor() {
    super(OrderSource.UBER_EATS);
  }

  async validateOrder(data: any): Promise<ValidationResult> {
    // Uber Eats订单验证
    // - 必须有外部订单ID
    // - 必须有配送地址
    // - 验证签名
    return {
      isValid: true,
      errors: []
    };
  }

  async transformToStandardOrder(data: any): Promise<StandardOrderData> {
    return {
      orderSource: OrderSource.UBER_EATS,
      orderSourceId: data.id,
      orderType: OrderType.DELIVERY,
      customerName: data.eater.first_name + ' ' + data.eater.last_name,
      customerPhone: data.eater.phone,
      deliveryAddress: {
        street: data.delivery.location.address,
        city: data.delivery.location.city,
        zipCode: data.delivery.location.postal_code,
        instructions: data.delivery.notes
      },
      items: this.transformUberItems(data.cart.items),
      subtotal: data.payment.charges.total / 100,
      deliveryFee: data.payment.charges.delivery_fee / 100,
      platformFee: data.payment.charges.uber_fee / 100,
      totalAmount: data.payment.charges.total / 100,
      estimatedDelivery: new Date(data.delivery.pickup_time),
      orderSourceMeta: {
        platform: 'uber_eats',
        externalOrderId: data.id,
        restaurantId: data.restaurant.id,
        deliveryType: data.delivery.type,
        courierInfo: data.courier
      }
    };
  }

  getOrderNumberPrefix(): string {
    return 'UE';
  }

  async afterCreate(order: Order): Promise<void> {
    // 1. 打印厨房单(标注为Uber Eats订单)
    await this.printKitchenTicket(order);
    
    // 2. 确认订单到Uber Eats
    await this.confirmOrderToUberEats(order);
    
    // 3. 通知厨房显示屏
    await this.notifyKitchenDisplay(order);
  }

  private async confirmOrderToUberEats(order: Order): Promise<void> {
    // 调用Uber Eats API确认订单
    // POST /v1/eats/orders/{orderId}/accept_pos_order
  }
}
```

---

## 4. 统一订单服务

```typescript
// src/services/order/order.service.ts
export class OrderService {
  private sourceHandlers: Map<OrderSource, BaseOrderSource>;

  constructor() {
    this.sourceHandlers = new Map([
      [OrderSource.POS, new POSOrderService()],
      [OrderSource.KIOSK, new KioskOrderService()],
      [OrderSource.WEB, new WebOrderService()],
      [OrderSource.UBER_EATS, new UberEatsOrderService()],
      [OrderSource.UBER_DIRECT, new UberDirectService()],
    ]);
  }

  /**
   * 创建订单 - 统一入口
   */
  async createOrder(
    orderSource: OrderSource,
    data: any,
    context: OrderContext
  ): Promise<Order> {
    // 1. 获取对应的处理器
    const handler = this.sourceHandlers.get(orderSource);
    if (!handler) {
      throw new AppError(400, 'UNSUPPORTED_ORDER_SOURCE', '不支持的订单来源');
    }

    // 2. 验证订单
    const validation = await handler.validateOrder(data);
    if (!validation.isValid) {
      throw new AppError(400, 'VALIDATION_FAILED', '订单验证失败', validation.errors);
    }

    // 3. 转换为标准格式
    let standardData = await handler.transformToStandardOrder(data);

    // 4. 创建前钩子
    standardData = await handler.beforeCreate(standardData);

    // 5. 生成订单号
    const orderNumber = await this.generateOrderNumber(handler.getOrderNumberPrefix());

    // 6. 创建订单
    const order = await prisma.order.create({
      data: {
        ...standardData,
        orderNumber,
        tenantId: context.tenantId,
        status: OrderStatus.PENDING
      },
      include: {
        orderItems: true
      }
    });

    // 7. 创建后钩子
    await handler.afterCreate(order);

    // 8. 记录状态历史
    await this.recordStatusChange(order.id, null, OrderStatus.PENDING);

    // 9. 发送事件
    await this.emitOrderCreatedEvent(order);

    logger.info(`Order created: ${order.orderNumber}`, {
      orderId: order.id,
      orderSource: order.orderSource
    });

    return order;
  }

  /**
   * 生成订单号
   */
  private async generateOrderNumber(
    prefix: string,
    useSimple: boolean = false
  ): Promise<string> {
    if (useSimple) {
      // 简单序号: 1, 2, 3... (当日循环,最大999)
      return await this.generateSimpleOrderNumber();
    } else {
      // 复杂格式: MT-20241023-0001
      return await this.generateComplexOrderNumber(prefix);
    }
  }

  /**
   * 生成简单订单号(取餐号)
   * 当日循环: 1-999
   */
  private async generateSimpleOrderNumber(): Promise<string> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    // 获取今日最大订单号
    const lastOrder = await prisma.order.findFirst({
      where: {
        createdAt: {
          gte: today,
          lt: tomorrow
        },
        orderNumber: {
          // 只匹配纯数字订单号
          not: { contains: '-' }
        }
      },
      orderBy: {
        pickupNumber: 'desc'
      }
    });

    let sequence = 1;
    if (lastOrder?.pickupNumber) {
      // 循环使用 1-999
      sequence = (lastOrder.pickupNumber % 999) + 1;
    }

    return sequence.toString();
  }

  /**
   * 生成复杂订单号(外卖订单)
   * 格式: MT-20241023-0001
   */
  private async generateComplexOrderNumber(prefix: string): Promise<string> {
    const today = new Date();
    const dateStr = today.toISOString().split('T')[0].replace(/-/g, '');
    
    const lastOrder = await prisma.order.findFirst({
      where: {
        orderNumber: {
          startsWith: `${prefix}-${dateStr}`
        }
      },
      orderBy: {
        orderNumber: 'desc'
      }
    });

    let sequence = 1;
    if (lastOrder) {
      const parts = lastOrder.orderNumber.split('-');
      const lastSequence = parseInt(parts[parts.length - 1] || '0');
      sequence = lastSequence + 1;
    }

    return `${prefix}-${dateStr}-${sequence.toString().padStart(4, '0')}`;
  }

  /**
   * 更新订单状态
   */
  async updateOrderStatus(
    orderId: string,
    newStatus: OrderStatus,
    context: OrderContext
  ): Promise<Order> {
    const order = await prisma.order.findFirst({
      where: { id: orderId, tenantId: context.tenantId }
    });

    if (!order) {
      throw new AppError(404, 'ORDER_NOT_FOUND', '订单不存在');
    }

    // 验证状态转换
    this.validateStatusTransition(order.status, newStatus);

    // 更新状态
    const updatedOrder = await prisma.order.update({
      where: { id: orderId },
      data: { status: newStatus }
    });

    // 记录状态历史
    await this.recordStatusChange(orderId, order.status, newStatus, context.userId);

    // 状态变更后的处理
    await this.handleStatusChange(updatedOrder, order.status, newStatus);

    return updatedOrder;
  }

  /**
   * 处理状态变更
   */
  private async handleStatusChange(
    order: Order,
    oldStatus: OrderStatus,
    newStatus: OrderStatus
  ): Promise<void> {
    const handler = this.sourceHandlers.get(order.orderSource);
    
    switch (newStatus) {
      case OrderStatus.CONFIRMED:
        // 确认订单
        await this.sendNotification(order, 'order_confirmed');
        break;
        
      case OrderStatus.PREPARING:
        // 开始准备
        await this.sendNotification(order, 'order_preparing');
        break;
        
      case OrderStatus.READY:
        // 订单完成
        if (order.orderSource === OrderSource.KIOSK) {
          // KIOSK订单:显示在叫号屏
          await this.displayOnCallScreen(order);
          // 发送短信
          if (order.customerPhone) {
            await this.sendSMS(order.customerPhone, `您的订单 #${order.pickupNumber} 已完成,请取餐`);
          }
        } else if (order.orderSource === OrderSource.UBER_EATS) {
          // Uber Eats:通知平台订单已准备好
          await this.notifyPlatformOrderReady(order);
        }
        break;
        
      case OrderStatus.COMPLETED:
        // 订单完成
        await this.sendNotification(order, 'order_completed');
        break;
    }
  }
}
```

---

## 5. 订单来源配置管理服务 (新增)

```typescript
// src/services/order/order-source-config.service.ts
export class OrderSourceConfigService {
  /**
   * 创建自定义订单来源
   */
  async createOrderSource(
    data: CreateOrderSourceData,
    tenantId: string
  ): Promise<OrderSourceConfig> {
    // 验证code唯一性
    const existing = await prisma.orderSourceConfig.findFirst({
      where: { tenantId, code: data.code }
    });
    
    if (existing) {
      throw new AppError(400, 'CODE_EXISTS', '来源代码已存在');
    }
    
    return await prisma.orderSourceConfig.create({
      data: {
        tenantId,
        name: data.name,
        code: data.code.toUpperCase(),
        description: data.description,
        icon: data.icon,
        color: data.color,
        platformFeeType: data.platformFeeType || 'PERCENTAGE',
        platformFeeRate: data.platformFeeRate,
        platformFeeFixed: data.platformFeeFixed,
        settlementCycle: data.settlementCycle,
        accountNumber: data.accountNumber,
        contactName: data.contactName,
        contactPhone: data.contactPhone,
        contactEmail: data.contactEmail,
        config: data.config
      }
    });
  }

  /**
   * 获取所有订单来源
   */
  async getOrderSources(
    tenantId: string,
    includeInactive: boolean = false
  ): Promise<OrderSourceConfig[]> {
    return await prisma.orderSourceConfig.findMany({
      where: {
        tenantId,
        ...(includeInactive ? {} : { isActive: true })
      },
      orderBy: { createdAt: 'desc' }
    });
  }

  /**
   * 更新订单来源
   */
  async updateOrderSource(
    id: string,
    data: Partial<CreateOrderSourceData>,
    tenantId: string
  ): Promise<OrderSourceConfig> {
    const config = await prisma.orderSourceConfig.findFirst({
      where: { id, tenantId }
    });
    
    if (!config) {
      throw new AppError(404, 'CONFIG_NOT_FOUND', '订单来源配置不存在');
    }
    
    return await prisma.orderSourceConfig.update({
      where: { id },
      data
    });
  }

  /**
   * 启用/禁用订单来源
   */
  async toggleOrderSource(
    id: string,
    isActive: boolean,
    tenantId: string
  ): Promise<void> {
    await prisma.orderSourceConfig.updateMany({
      where: { id, tenantId },
      data: { isActive }
    });
  }

  /**
   * 获取订单来源统计
   */
  async getOrderSourceStats(
    tenantId: string,
    startDate: Date,
    endDate: Date
  ) {
    // 系统预设来源统计
    const systemStats = await prisma.order.groupBy({
      by: ['orderSource'],
      where: {
        tenantId,
        orderSource: { not: OrderSource.CUSTOM },
        createdAt: { gte: startDate, lte: endDate }
      },
      _count: true,
      _sum: {
        totalAmount: true,
        platformFee: true
      }
    });
    
    // 自定义来源统计
    const customStats = await prisma.order.groupBy({
      by: ['orderSourceConfigId'],
      where: {
        tenantId,
        orderSource: OrderSource.CUSTOM,
        createdAt: { gte: startDate, lte: endDate }
      },
      _count: true,
      _sum: {
        totalAmount: true,
        platformFee: true
      }
    });
    
    // 获取自定义来源详情
    const customConfigs = await prisma.orderSourceConfig.findMany({
      where: {
        id: { in: customStats.map(s => s.orderSourceConfigId).filter(Boolean) as string[] }
      }
    });
    
    return {
      system: systemStats,
      custom: customStats.map(stat => ({
        ...stat,
        config: customConfigs.find(c => c.id === stat.orderSourceConfigId)
      }))
    };
  }
}

export default new OrderSourceConfigService();
```

---

## 6. API路由设计

### 6.1 订单来源配置管理API

```typescript
// src/routes/order-source-config.routes.ts
import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import orderSourceConfigService from '../services/order/order-source-config.service';

const router = Router();

// 创建自定义订单来源
router.post('/', authenticate, async (req, res) => {
  const config = await orderSourceConfigService.createOrderSource(
    req.body,
    req.organizationId
  );
  res.json({ success: true, data: config });
});

// 获取所有订单来源
router.get('/', authenticate, async (req, res) => {
  const configs = await orderSourceConfigService.getOrderSources(
    req.organizationId,
    req.query.includeInactive === 'true'
  );
  res.json({ success: true, data: configs });
});

// 获取单个订单来源
router.get('/:id', authenticate, async (req, res) => {
  const config = await prisma.orderSourceConfig.findFirst({
    where: {
      id: req.params.id,
      tenantId: req.organizationId
    }
  });
  res.json({ success: true, data: config });
});

// 更新订单来源
router.put('/:id', authenticate, async (req, res) => {
  const config = await orderSourceConfigService.updateOrderSource(
    req.params.id,
    req.body,
    req.organizationId
  );
  res.json({ success: true, data: config });
});

// 启用/禁用订单来源
router.post('/:id/toggle', authenticate, async (req, res) => {
  await orderSourceConfigService.toggleOrderSource(
    req.params.id,
    req.body.isActive,
    req.organizationId
  );
  res.json({ success: true });
});

// 获取订单来源统计
router.get('/stats', authenticate, async (req, res) => {
  const stats = await orderSourceConfigService.getOrderSourceStats(
    req.organizationId,
    new Date(req.query.startDate as string),
    new Date(req.query.endDate as string)
  );
  res.json({ success: true, data: stats });
});

export default router;
```

### 6.2 订单API

```typescript
// src/routes/order.routes.ts
router.post('/orders', authenticate, async (req, res) => {
  const { orderSource, orderSourceConfigId, ...data } = req.body;
  
  // 如果是自定义来源,需要提供配置ID
  let config = null;
  if (orderSource === OrderSource.CUSTOM) {
    if (!orderSourceConfigId) {
      return res.status(400).json({
        success: false,
        error: '自定义来源订单必须提供orderSourceConfigId'
      });
    }
    
    config = await prisma.orderSourceConfig.findFirst({
      where: {
        id: orderSourceConfigId,
        tenantId: req.organizationId,
        isActive: true
      }
    });
    
    if (!config) {
      return res.status(404).json({
        success: false,
        error: '订单来源配置不存在或已禁用'
      });
    }
  }
  
  const order = await orderService.createOrder(
    orderSource,
    { ...data, orderSourceConfigId },
    {
      tenantId: req.organizationId,
      userId: req.userId,
      sourceConfig: config
    }
  );
  
  res.json({ success: true, data: order });
});

// 按来源查询订单
router.get('/orders/by-source/:source', authenticate, async (req, res) => {
  const { source } = req.params;
  const orders = await orderService.getOrdersBySource(
    source as OrderSource,
    req.query,
    req.organizationId
  );
  
  res.json({ success: true, data: orders });
});

// Webhook端点(第三方平台)
router.post('/webhooks/uber-eats', async (req, res) => {
  // 验证签名
  const isValid = await verifyUberEatsSignature(req);
  if (!isValid) {
    return res.status(401).json({ error: 'Invalid signature' });
  }
  
  // 处理订单
  const order = await orderService.createOrder(
    OrderSource.UBER_EATS,
    req.body,
    { tenantId: req.body.restaurant.id }
  );
  
  res.json({ success: true });
});
```

---

## 7. 小票打印差异化

不同订单来源使用不同的小票模板:

```typescript
// 获取小票模板
const template = await prisma.receiptTemplate.findFirst({
  where: {
    tenantId: order.tenantId,
    orderSource: order.orderSource,
    isActive: true,
    isDefault: true
  }
});

// POS小票: 完整信息
// KIOSK小票: 超大字体显示取餐号和取餐名
// Uber Eats: 标注平台信息和配送地址
```

---

## 8. 使用示例

### 8.1 创建自定义订单来源(美团)

```typescript
// 1. 创建美团订单来源配置
const meiTuanConfig = await fetch('/api/order/v1/order-sources', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    'x-organization-id': organizationId
  },
  body: JSON.stringify({
    name: '美团外卖',
    code: 'MT',
    description: '美团外卖平台订单',
    icon: 'https://example.com/meituan-icon.png',
    color: '#FFD100',
    platformFeeType: 'PERCENTAGE',
    platformFeeRate: 0.18,  // 18%抽成
    settlementCycle: 'weekly',
    accountNumber: 'MT-123456',
    contactName: '美团客服',
    contactPhone: '10109777',
    config: {
      autoPrint: true,
      webhookUrl: 'https://api.meituan.com/webhook/order-status'
    }
  })
});

// 2. 创建美团订单
const order = await fetch('/api/order/v1/orders', {
  method: 'POST',
  body: JSON.stringify({
    orderSource: 'CUSTOM',
    orderSourceConfigId: meiTuanConfig.data.id,
    externalOrderId: 'mt-20241023-12345',
    orderType: 'DELIVERY',
    customerName: '张三',
    customerPhone: '13800138000',
    deliveryAddress: {
      street: '中关村大街1号',
      city: '北京',
      district: '海淀区',
      detail: '5号楼302'
    },
    items: [
      {
        itemId: 'item-1',
        itemName: '宫保鸡丁',
        quantity: 1,
        unitPrice: 38.00
      }
    ],
    subtotal: 38.00,
    deliveryFee: 5.00,
    totalAmount: 43.00,
    meta: {
      meiTuanOrderId: 'mt-20241023-12345',
      estimatedDeliveryTime: '2024-10-23T13:30:00Z'
    }
  })
});
```

### 8.2 查询自定义来源订单统计

```typescript
// 获取所有订单来源的统计数据
const stats = await fetch(
  `/api/order/v1/order-sources/stats?startDate=2024-10-01&endDate=2024-10-31`,
  {
    headers: {
      'Authorization': `Bearer ${token}`,
      'x-organization-id': organizationId
    }
  }
);

// 响应示例
{
  "success": true,
  "data": {
    "system": [
      {
        "orderSource": "POS",
        "_count": 150,
        "_sum": {
          "totalAmount": 15000.00,
          "platformFee": 0
        }
      },
      {
        "orderSource": "KIOSK",
        "_count": 80,
        "_sum": {
          "totalAmount": 6400.00,
          "platformFee": 0
        }
      }
    ],
    "custom": [
      {
        "orderSourceConfigId": "uuid-mt",
        "_count": 45,
        "_sum": {
          "totalAmount": 4500.00,
          "platformFee": 810.00
        },
        "config": {
          "name": "美团外卖",
          "code": "MT",
          "color": "#FFD100"
        }
      },
      {
        "orderSourceConfigId": "uuid-elm",
        "_count": 32,
        "_sum": {
          "totalAmount": 3200.00,
          "platformFee": 640.00
        },
        "config": {
          "name": "饿了么",
          "code": "ELM",
          "color": "#0089FF"
        }
      }
    ]
  }
}
```

### 8.3 对账报表

```typescript
// 生成美团订单对账报表
const report = await prisma.order.findMany({
  where: {
    tenantId: organizationId,
    orderSource: OrderSource.CUSTOM,
    orderSourceConfigId: meiTuanConfigId,
    createdAt: {
      gte: new Date('2024-10-01'),
      lte: new Date('2024-10-31')
    }
  },
  select: {
    orderNumber: true,
    orderSourceId: true,  // 美团订单号
    totalAmount: true,
    platformFee: true,
    createdAt: true,
    orderSourceConfig: {
      select: {
        name: true,
        platformFeeRate: true
      }
    }
  }
});

// 计算汇总
const summary = {
  totalOrders: report.length,
  totalRevenue: report.reduce((sum, o) => sum + parseFloat(o.totalAmount.toString()), 0),
  totalPlatformFee: report.reduce((sum, o) => sum + parseFloat(o.platformFee.toString()), 0),
  netRevenue: 0
};
summary.netRevenue = summary.totalRevenue - summary.totalPlatformFee;
```

---

## 9. 扩展性设计

### 7.1 添加新的订单来源

1. 在 `OrderSource` 枚举中添加新类型
2. 创建新的处理器类继承 `BaseOrderSource`
3. 在 `OrderService` 中注册处理器
4. 创建对应的小票模板

### 7.2 第三方平台集成

```typescript
// src/services/order/sources/platform/doordash.service.ts
export class DoorDashOrderService extends BaseOrderSource {
  // 实现DoorDash特定逻辑
}
```

---

## 10. 监控和分析

### 8.1 订单来源统计

```typescript
// 按来源统计订单
const stats = await prisma.order.groupBy({
  by: ['orderSource'],
  where: {
    tenantId: tenantId,
    createdAt: {
      gte: startDate,
      lte: endDate
    }
  },
  _count: true,
  _sum: {
    totalAmount: true
  }
});
```

### 8.2 性能监控

- 每个订单来源的平均处理时间
- 订单创建成功率
- 第三方平台API响应时间

---

## 11. 优势总结

### 11.1 商家自定义能力
- 商家可以灵活添加任意订单来源
- 支持设置不同的费率和对账周期
- 方便财务对账和成本分析
- 支持webhook集成

### 11.2 统一性

### 9.1 统一性
- 所有订单使用统一的数据模型
- 统一的API接口
- 统一的状态管理

### 11.3 差异化
- 每个来源有独立的验证逻辑
- 每个来源有独立的后处理逻辑
- 每个来源有独立的小票模板

### 11.4 可扩展性
- 易于添加新的订单来源
- 易于集成第三方平台
- 易于定制业务逻辑

### 11.5 可维护性
- 清晰的代码结构
- 职责分离
- 易于测试

---

## 12. 实施步骤

1. **Phase 1**: 扩展数据模型
   - 创建 `OrderSourceConfig` 表
   - 更新 `Order` 表,添加 `orderSourceConfigId` 字段
   - 运行数据库迁移

2. **Phase 2**: 实现订单来源配置管理
   - 创建 `OrderSourceConfigService`
   - 实现订单来源配置CRUD API
   - 实现统计和对账功能

3. **Phase 3**: 实现基础架构
   - 创建 `BaseOrderSource` 抽象类
   - 实现 `CustomOrderService` 处理器
   - 重构现有 `OrderService`

4. **Phase 4**: 实现各订单来源处理器
   - POS订单处理器
   - KIOSK订单处理器
   - Web订单处理器

5. **Phase 5**: 集成第三方平台
   - Uber Eats集成
   - 其他平台集成

6. **Phase 6**: 测试和优化
   - 单元测试
   - 集成测试
   - 性能优化
   - 前端管理界面开发

---

## 13. WebSocket 打印队列

### 13.1 概述

通过 WebSocket 实时推送打印任务到 POS 设备，替代轮询方式。使用 `ws` 库实现，端点为 `ws://localhost:3002/ws/print-queue`。

### 13.2 核心流程

```
┌─────────────┐     创建订单      ┌──────────────┐
│  POS/WEB/   │ ───────────────→ │ OrderService │
│  KIOSK      │                  └──────┬───────┘
└─────────────┘                         │
                                        ↓
                              查询租户 PrintSetting
                                        │
                                        ↓
                              生成 PrintTask (PENDING)
                                        │
                              ┌─────────┴─────────┐
                              ↓                   ↓
                         设备在线             设备离线
                              │                   │
                              ↓                   ↓
                     WebSocket 推送         保持 PENDING
                     PRINT_TASK             等待 FETCH_PENDING
                              │
                              ↓
                    POS 设备打印并回复
                    TASK_ACK → TASK_RESULT
```

### 13.3 PrintTask 数据模型

```prisma
model PrintTask {
  id          String          @id @default(uuid()) @db.Uuid
  tenantId    String          @map("tenant_id") @db.Uuid
  orderId     String          @map("order_id") @db.Uuid
  ticketType  String          @map("ticket_type")
  status      PrintTaskStatus @default(PENDING)
  deviceId    String?         @map("device_id")
  payload     Json            @db.Json
  error       String?         @db.Text
  createdAt   DateTime        @default(now()) @map("created_at")
  sentAt      DateTime?       @map("sent_at")
  completedAt DateTime?       @map("completed_at")

  order       Order           @relation(fields: [orderId], references: [id])

  @@index([tenantId, status])
  @@index([deviceId, status])
  @@map("print_tasks")
}

enum PrintTaskStatus {
  PENDING     // 等待推送
  SENT        // 已推送
  RECEIVED    // 设备已确认接收
  COMPLETED   // 打印完成
  FAILED      // 打印失败
}
```

### 13.4 消息协议

| 消息类型 | 方向 | 说明 |
|---------|------|------|
| `REGISTER` | 客户端→服务端 | 设备注册（deviceId + tenantId） |
| `REGISTER_ACK` | 服务端→客户端 | 注册确认 |
| `PRINT_TASK` | 服务端→客户端 | 推送打印任务 |
| `TASK_ACK` | 客户端→服务端 | 确认接收（状态→RECEIVED） |
| `TASK_RESULT` | 客户端→服务端 | 打印结果（状态→COMPLETED/FAILED） |
| `FETCH_PENDING` | 客户端→服务端 | 拉取积压任务 |
| `PENDING_TASKS` | 服务端→客户端 | 返回待处理任务列表 |
| `PING` / `PONG` | 双向 | 心跳保活 |

### 13.5 与 PrintSetting 的关系

订单创建时，系统查询租户的 PrintSetting 配置，确定需要生成哪些类型的打印任务：

- 如果 `CUSTOMER_RECEIPT` 已启用 → 生成收据打印任务
- 如果 `KITCHEN_TICKET` 已启用 → 生成厨房单打印任务
- 如果 `ITEM_LABEL` 已启用 → 生成标签打印任务
- 打印份数根据 PrintSetting 中的 `copies` 字段决定

## 14. 订单分析维度（OrderAnalytics）

### 14.1 概述

`OrderAnalytics` 是"每订单一行"的事实表，供 BI / AI 分析使用。订单创建后由事件总线
**异步**写入（[analytics.handler.ts](src/events/handlers/analytics.handler.ts)），任何外部依赖失败都降级，
**不阻塞下单主流程**。所有下单渠道（POS / KIOSK / WEB / Uber Eats 等）统一通过
`ORDER_CREATED` / `ORDER_CREATED_FROM_SNAPSHOT` / `TEMPORARY_ORDER_CREATED` 三个事件收口，
天气与时间维度在此处统一填充，渠道天然全覆盖。

### 14.2 设计原则

- **系统维度（天气 / 时间 / 日历）→ 强类型列**：可索引、可聚合、对 BI/ML 友好。
- **天气状况归一化为枚举** `WeatherCondition`：由 WMO weather_code 映射，避免自由文本碎类别。
- **唯一的 jsonb 逃生舱** `weatherRaw`：存天气 API 原始返回，便于未来扩展；某字段一旦要分析就提升为强类型列。
- **时间维度按门店本地时区计算**：`hour` / `dayOfWeek` / `dayPart` 等均为门店本地值，跨时区门店不再算错。
- **`tenantId` 冗余在分析表上**：按门店分析无需 join `orders`。

### 14.3 天气管线

```
订单创建 → 事件总线 → analytics.handler
   ├─ organizationService.getOrganization(tenantId) → 门店信息（含经纬度/地址，5 分钟缓存）
   ├─ geoService.resolveCoordinates(org)            → 坐标：优先经纬度，缺失则按地址地理编码（7 天缓存）
   ├─ weatherService.getWeather(lat, lng)           → 天气快照 + 门店 IANA 时区（15 分钟窗缓存）
   └─ computeTimeDimensions(createdAt, timezone)    → 本地时区时间维度
        ↓
   写入 OrderAnalytics（天气列 + 时间维度列）
```

- **坐标解析（geo.service）**：auth-service 多数门店只填了地址、没填经纬度。故优先用 org 自带经纬度，
  缺失时用"城市/省/国家"调 Open-Meteo Geocoding（免费免 key）换算坐标，城市级精度对天气足够。
  结果长期缓存（默认 7 天，地址几乎不变），可用 `GEOCODING_API_URL` 覆盖。
- **天气数据源**：Open-Meteo（免费、无需 API key），可用 `WEATHER_API_URL` 覆盖。
- **缓存**：天气按"经纬度(2 位小数) + 15 分钟时间窗"缓存，避免同店大量订单重复调用。
- **降级**：解析不出坐标 / 天气失败 → 天气列留空，时间维度回退 UTC，分析行照常创建。
- **时区**：Open-Meteo `timezone=auto` 顺带返回门店 IANA 时区，复用于时间维度，无需额外依赖。

### 14.4 字段说明

| 分类 | 字段 | 说明 |
|------|------|------|
| 标识 | `tenantId` | 门店 ID（冗余，便于按店分析） |
| 时间 | `localTime` / `timezone` | 门店本地墙钟时间 + IANA 时区 |
| 时间 | `year`/`month`/`day`/`dayOfWeek`/`hour`/`weekOfYear`/`isWeekend`/`dayPart` | 本地时区拆解的时间维度 |
| 天气 | `weatherCondition` | 归一化枚举（CLEAR/RAIN/SNOW…） |
| 天气 | `weatherTemp`/`weatherFeelsLike`/`weatherHumidity`/`weatherPrecipMm`/`weatherWindKph`/`weatherCloudPct`/`isRaining` | 强类型天气指标 |
| 天气 | `weatherSource`/`weatherFetchedAt`/`weatherRaw` | 数据源 / 采样时间 / 原始返回（jsonb） |
| 日历 | `isHoliday`/`holidayName`/`eventName` | 节假日 / 活动（数据源待接入） |

### 14.5 后续规划（未实现）

- **商家自定义分析维度**：注册表 `CustomDimension` + 分析表上的 `customDimensions` jsonb 列 + GIN 索引。
- **销量预测用天气时序表** `WeatherSnapshot`：每店每小时独立采集，消除"仅有订单时才有天气"的选择性偏差。
- **`order_features` 视图**：join `orders` 提供含金额/件数的宽特征表，金额以 `orders` 为真相源、零冗余。
