# 小票模板系统设计

## 核心原则

**终端直接使用,无需复杂转换**

1. 样式层(视觉)由styleId控制,终端根据styleId获取预设样式
2. 业务层(内容)由简单开关控制
3. Logo存储为ESC/POS指令,终端直接发送
4. 二维码存储URL模板,终端替换变量后生成

---

## 配置结构

```typescript
{
  // 基础信息
  language: 'zh-CN',
  paperWidth: 80,
  styleId: 'classic',
  
  // 显示控制(简单开关)
  display: {
    logo: true,
    storeInfo: true,
    customerName: false,
    itemAttributes: true,
    itemAddons: true,
    itemNotes: true,
    priceBreakdown: true,
    qrCode: true
  },
  
  // 订单信息字段
  orderFields: ['tableNumber', 'orderType', 'time'],
  
  // Logo配置
  logo: {
    enabled: true,
    data: "base64_encoded_escpos_bitmap",
    width: 200,
    height: 100,
    alignment: 'center'
  },
  
  // 二维码配置
  qrCode: {
    enabled: true,
    urlTemplate: "https://example.com/order/{orderId}",
    title: { 'zh-CN': '扫码查看订单' },
    sizeRatio: 0.6,
    errorCorrection: 'M',
    alignment: 'center'
  },
  
  // 自定义消息
  customMessage: { 'zh-CN': '感谢惠顾' },
  
  // 打印密度
  printDensity: 'normal'
}
```

---

## 1. Logo处理

### 后端存储
```typescript
logo: {
  enabled: boolean,
  data: string,      // Base64编码的ESC/POS位图指令
  width: number,     // 像素宽度
  height: number,    // 像素高度
  alignment: 'left' | 'center' | 'right'
}
```

### 上传流程
```typescript
// 1. 前端上传图片(PNG/JPG)
const formData = new FormData();
formData.append('logo', imageFile);

// 2. 后端转换为ESC/POS位图指令
import { Image } from 'canvas';
import escpos from 'escpos';

async function convertLogoToESCPOS(imageBuffer: Buffer): Promise<string> {
  // 加载图片
  const image = new Image();
  image.src = imageBuffer;
  
  // 调整尺寸(最大宽度384px,适配58mm纸张)
  const maxWidth = 384;
  const ratio = maxWidth / image.width;
  const width = Math.min(image.width, maxWidth);
  const height = Math.floor(image.height * ratio);
  
  // 转换为单色位图
  const bitmap = convertToMonochrome(image, width, height);
  
  // 生成ESC/POS指令 (GS v 0)
  const commands = [
    0x1D, 0x76, 0x30, 0x00,  // GS v 0
    width & 0xFF, (width >> 8) & 0xFF,
    height & 0xFF, (height >> 8) & 0xFF,
    ...bitmap
  ];
  
  // Base64编码
  return Buffer.from(commands).toString('base64');
}

// 3. 保存到数据库
await prisma.receiptTemplate.update({
  where: { id },
  data: {
    config: {
      ...config,
      logo: {
        enabled: true,
        data: escposData,
        width: 384,
        height: 192,
        alignment: 'center'
      }
    }
  }
});
```

### 终端使用
```typescript
// 终端直接解码并发送
const logoData = Buffer.from(template.config.logo.data, 'base64');

// 根据对齐方式添加居中指令
if (template.config.logo.alignment === 'center') {
  await printer.send([0x1B, 0x61, 0x01]); // ESC a 1 (居中)
}

// 发送Logo位图指令
await printer.send(logoData);

// 恢复左对齐
await printer.send([0x1B, 0x61, 0x00]); // ESC a 0
```

---

## 2. 二维码处理

### 后端存储
```typescript
qrCode: {
  enabled: boolean,
  urlTemplate: string,  // "https://example.com/order/{orderId}"
  title: MultiLanguageText,
  sizeRatio: number,    // 0.5-0.8
  errorCorrection: 'L' | 'M' | 'Q' | 'H',
  alignment: 'center'
}
```

### 尺寸自动计算
```typescript
// 后端提供计算函数
function calculateQRCodeSize(paperWidth: number, ratio: number): number {
  const dpi = 203;  // 热敏打印机标准DPI
  const mmToInch = 25.4;
  const pixelWidth = (paperWidth / mmToInch) * dpi;
  const margin = 40;  // 左右边距
  const maxWidth = pixelWidth - margin;
  return Math.floor(maxWidth * ratio);
}

// 58mm, ratio=0.6 → 252px
// 76mm, ratio=0.6 → 330px
// 80mm, ratio=0.6 → 350px
```

### 终端使用
```typescript
// 1. 替换URL模板中的变量
const url = template.config.qrCode.urlTemplate
  .replace('{orderId}', order.id)
  .replace('{tableNumber}', order.tableNumber);

// 2. 计算二维码尺寸
const size = calculateQRCodeSize(
  template.config.paperWidth,
  template.config.qrCode.sizeRatio
);

// 3. 生成ESC/POS二维码指令
const qrCommands = generateQRCode(url, size, template.config.qrCode.errorCorrection);

// 4. 打印标题(如果有)
if (template.config.qrCode.title) {
  const title = template.config.qrCode.title[template.config.language];
  await printer.text(title, { align: 'center' });
}

// 5. 打印二维码
await printer.send(qrCommands);
```

### ESC/POS二维码指令生成
```typescript
function generateQRCode(
  data: string, 
  size: number, 
  errorCorrection: 'L' | 'M' | 'Q' | 'H'
): Buffer {
  const commands = [];
  
  // 选择二维码模型
  commands.push(0x1D, 0x28, 0x6B, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00);
  
  // 设置模块大小
  const moduleSize = Math.floor(size / 33);  // QR码通常是33x33模块
  commands.push(0x1D, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x43, moduleSize);
  
  // 设置纠错级别
  const ecMap = { 'L': 0x30, 'M': 0x31, 'Q': 0x32, 'H': 0x33 };
  commands.push(0x1D, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x45, ecMap[errorCorrection]);
  
  // 存储数据
  const dataBytes = Buffer.from(data, 'utf8');
  const len = dataBytes.length + 3;
  commands.push(
    0x1D, 0x28, 0x6B,
    len & 0xFF, (len >> 8) & 0xFF,
    0x31, 0x50, 0x30,
    ...dataBytes
  );
  
  // 打印
  commands.push(0x1D, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x51, 0x30);
  
  return Buffer.from(commands);
}
```

---

## 3. 样式系统

### 样式定义(后端预设)
```typescript
const STYLE_PRESETS = {
  classic: {
    separator: '=',
    fontSize: {
      storeName: 'xlarge',
      orderNumber: 'xxlarge',
      items: 'medium',
      total: 'large'
    },
    spacing: {
      header: 1,
      body: 2,
      footer: 2,
      lineSpacing: 1.2
    }
  },
  modern: {
    separator: '- - - - -',
    fontSize: {
      storeName: 'xxlarge',
      orderNumber: 'xxxlarge',
      items: 'large',
      total: 'xlarge'
    },
    spacing: {
      header: 3,
      body: 4,
      footer: 5,
      lineSpacing: 2.5
    }
  },
  compact: {
    separator: '',
    fontSize: {
      storeName: 'large',
      orderNumber: 'xlarge',
      items: 'medium',
      total: 'large'
    },
    spacing: {
      header: 0,
      body: 0,
      footer: 1,
      lineSpacing: 0.8
    }
  },
  elegant: {
    separator: '╌╌╌╌╌╌╌',
    fontSize: {
      storeName: 'xlarge',
      orderNumber: 'xxlarge',
      items: 'medium',
      total: 'large'
    },
    spacing: {
      header: 2,
      body: 2,
      footer: 3,
      lineSpacing: 1.6
    }
  }
};
```

### 终端获取样式
```typescript
// 终端根据styleId获取样式
const style = STYLE_PRESETS[template.config.styleId];

// 应用样式打印
await printer.setTextSize(style.fontSize.storeName);
await printer.text(storeName, { align: 'center' });

if (style.separator) {
  await printer.text(style.separator.repeat(32), { align: 'center' });
}
```

---

## 4. 打印密度

```typescript
printDensity: 'compact' | 'normal' | 'spacious'
```

**影响**:
- `compact`: 行间距 × 0.8, 走纸2行
- `normal`: 行间距 × 1.0, 走纸3行
- `spacious`: 行间距 × 1.5, 走纸5行

**终端应用**:
```typescript
const densityMap = {
  compact: { lineSpacing: 0.8, feedLines: 2 },
  normal: { lineSpacing: 1.0, feedLines: 3 },
  spacious: { lineSpacing: 1.5, feedLines: 5 }
};

const density = densityMap[template.config.printDensity];

// 设置行间距
const spacing = Math.floor(style.spacing.lineSpacing * density.lineSpacing * 30);
await printer.send([0x1B, 0x33, spacing]); // ESC 3 n

// 走纸
for (let i = 0; i < density.feedLines; i++) {
  await printer.send([0x0A]); // LF
}
```

---

## 5. 完整打印流程

```typescript
async function printReceipt(order: Order, template: Template) {
  const printer = new ThermalPrinter();
  const style = STYLE_PRESETS[template.config.styleId];
  const density = densityMap[template.config.printDensity];
  
  // 初始化
  await printer.init();
  
  // === 头部 ===
  
  // Logo
  if (template.config.display.logo && template.config.logo?.enabled) {
    const logoData = Buffer.from(template.config.logo.data, 'base64');
    if (template.config.logo.alignment === 'center') {
      await printer.align('center');
    }
    await printer.send(logoData);
    await printer.feed(1);
  }
  
  // 店铺名称
  await printer.setTextSize(style.fontSize.storeName);
  await printer.text(order.storeName, { align: 'center', bold: true });
  await printer.feed(style.spacing.header);
  
  // 店铺信息
  if (template.config.display.storeInfo) {
    await printer.setTextSize('small');
    await printer.text(`地址: ${order.storeAddress}`, { align: 'center' });
    await printer.text(`电话: ${order.storePhone}`, { align: 'center' });
    await printer.feed(1);
  }
  
  // 分隔符
  if (style.separator) {
    await printer.text(style.separator.repeat(32), { align: 'center' });
    await printer.feed(style.spacing.header);
  }
  
  // === 主体 ===
  
  // 订单号
  await printer.setTextSize(style.fontSize.orderNumber);
  await printer.text(`订单号`, { align: 'center' });
  await printer.text(`#${order.orderNumber}`, { align: 'center', bold: true });
  await printer.feed(style.spacing.body);
  
  // 客户姓名(KIOSK)
  if (template.config.display.customerName && order.customerName) {
    await printer.setTextSize('xlarge');
    await printer.text(`取餐名`, { align: 'center' });
    await printer.text(order.customerName, { align: 'center', bold: true });
    await printer.feed(style.spacing.body);
  }
  
  // 订单信息
  if (template.config.orderFields.length > 0) {
    await printer.setTextSize('medium');
    for (const field of template.config.orderFields) {
      const label = getFieldLabel(field, template.config.language);
      const value = order[field];
      await printer.text(`${label}: ${value}`);
    }
    await printer.feed(style.spacing.body);
  }
  
  // 商品列表
  await printer.setTextSize(style.fontSize.items);
  await printer.text('商品明细', { align: 'center' });
  await printer.feed(1);
  
  for (const item of order.items) {
    await printer.text(`${item.name} x${item.quantity}`, { width: 0.7, align: 'left' });
    await printer.text(`${item.price}`, { width: 0.3, align: 'right' });
    
    // 属性
    if (template.config.display.itemAttributes && item.attributes) {
      await printer.text(`  ${item.attributes}`, { size: 'small' });
    }
    
    // 加料
    if (template.config.display.itemAddons && item.addons) {
      await printer.text(`  + ${item.addons}`, { size: 'small' });
    }
    
    // 备注
    if (template.config.display.itemNotes && item.notes) {
      await printer.text(`  备注: ${item.notes}`, { size: 'small' });
    }
  }
  await printer.feed(style.spacing.body);
  
  // === 底部 ===
  
  // 金额汇总
  await printer.setTextSize(style.fontSize.total);
  
  if (template.config.display.priceBreakdown) {
    await printer.text(`小计: ${order.subtotal}`);
    await printer.text(`折扣: -${order.discount}`);
    await printer.text(`税费: ${order.tax}`);
  }
  
  await printer.text(`总计: ${order.total}`, { bold: true });
  await printer.feed(style.spacing.footer);
  
  // 二维码
  if (template.config.display.qrCode && template.config.qrCode?.enabled) {
    const url = template.config.qrCode.urlTemplate.replace('{orderId}', order.id);
    const size = calculateQRCodeSize(template.config.paperWidth, template.config.qrCode.sizeRatio);
    
    // 标题
    if (template.config.qrCode.title) {
      const title = template.config.qrCode.title[template.config.language];
      await printer.text(title, { align: 'center' });
    }
    
    // 二维码
    const qrCommands = generateQRCode(url, size, template.config.qrCode.errorCorrection);
    await printer.send(qrCommands);
    await printer.feed(2);
  }
  
  // 自定义消息
  if (template.config.customMessage) {
    const message = template.config.customMessage[template.config.language];
    await printer.text(message, { align: 'center' });
  }
  
  // 走纸切纸
  await printer.feed(density.feedLines);
  await printer.cut();
}
```

---

## 6. API接口

### 上传Logo
```http
POST /api/order/v1/receipt-templates/:id/logo
Content-Type: multipart/form-data

logo: <image file>
alignment: center
```

**响应**:
```json
{
  "success": true,
  "data": {
    "logo": {
      "enabled": true,
      "data": "base64_encoded_escpos...",
      "width": 384,
      "height": 192,
      "alignment": "center"
    }
  }
}
```

### 更新配置
```http
PUT /api/order/v1/receipt-templates/:id
```

**请求**:
```json
{
  "config": {
    "display": {
      "logo": true,
      "storeInfo": true,
      "customerName": false,
      "itemAttributes": true,
      "itemAddons": true,
      "itemNotes": false,
      "priceBreakdown": true,
      "qrCode": true
    },
    "orderFields": ["tableNumber", "orderType"],
    "qrCode": {
      "enabled": true,
      "urlTemplate": "https://example.com/order/{orderId}",
      "title": { "zh-CN": "扫码查看订单" },
      "sizeRatio": 0.6,
      "errorCorrection": "M"
    },
    "customMessage": { "zh-CN": "感谢惠顾" },
    "printDensity": "normal"
  }
}
```

---

## 7. 优势总结

### 简化配置
- 用户只需要配置业务相关的开关
- 视觉样式由styleId控制,无需调整字体大小、间距等细节

### 终端友好
- Logo存储为ESC/POS指令,终端直接发送,无需转换
- 二维码存储URL模板,终端替换变量后生成
- 尺寸自动计算,适配不同纸张宽度

### 易于维护
- 样式预设集中管理
- 配置结构清晰,易于理解
- 减少终端的计算负担

### 灵活扩展
- 可以轻松添加新的样式预设
- 可以添加新的订单字段
- 二维码URL模板支持任意变量

---

## 8. WebSocket 打印队列架构

### 概述

基于 `ws` 库实现 WebSocket 服务，将打印任务实时推送到 POS 设备。解决传统轮询方式的延迟和资源浪费问题。

### 架构设计

```
订单创建 (POS/WEB/KIOSK)
       ↓
  OrderService.createOrder()
       ↓
  根据 PrintSetting 生成 PrintTask (PENDING)
       ↓
  检查目标设备是否在线
       ↓
  ┌─── 在线 ──→ WebSocket 推送 PRINT_TASK → 状态变为 SENT
  └─── 离线 ──→ 任务保持 PENDING，等待设备重连拉取
```

### PrintTask 模型

```prisma
model PrintTask {
  id          String   @id @default(uuid()) @db.Uuid
  tenantId    String   @map("tenant_id") @db.Uuid
  orderId     String   @map("order_id") @db.Uuid
  ticketType  String   @map("ticket_type")
  status      PrintTaskStatus @default(PENDING)
  deviceId    String?  @map("device_id")
  payload     Json     @db.Json
  error       String?  @db.Text
  createdAt   DateTime @default(now()) @map("created_at")
  sentAt      DateTime? @map("sent_at")
  completedAt DateTime? @map("completed_at")

  order       Order    @relation(fields: [orderId], references: [id])

  @@index([tenantId, status])
  @@index([deviceId, status])
  @@map("print_tasks")
}

enum PrintTaskStatus {
  PENDING
  SENT
  RECEIVED
  COMPLETED
  FAILED
}
```

### WebSocket 消息协议

| 方向 | 消息类型 | 说明 |
|------|---------|------|
| 客户端→服务端 | REGISTER | 设备注册，携带 deviceId 和 tenantId |
| 服务端→客户端 | REGISTER_ACK | 注册确认 |
| 服务端→客户端 | PRINT_TASK | 推送打印任务 |
| 客户端→服务端 | TASK_ACK | 确认接收任务（状态→RECEIVED） |
| 客户端→服务端 | TASK_RESULT | 报告打印结果（状态→COMPLETED/FAILED） |
| 客户端→服务端 | FETCH_PENDING | 拉取离线期间积压的待处理任务 |
| 服务端→客户端 | PENDING_TASKS | 返回待处理任务列表 |
| 客户端→服务端 | PING | 心跳检测 |
| 服务端→客户端 | PONG | 心跳响应 |

### 离线容错机制

- 设备不在线时，PrintTask 保持 `PENDING` 状态存储在数据库
- 设备重新连接后发送 `FETCH_PENDING`，服务端返回所有待处理任务
- 确保不会因网络中断丢失打印任务
