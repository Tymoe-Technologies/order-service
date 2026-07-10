# 模板配置说明

## 配置结构

```typescript
{
  language: 'zh-CN' | 'en' | 'zh-TW',
  paperWidth: 58 | 76 | 80,
  styleId: 'classic' | 'modern' | 'compact' | 'elegant',
  display: { ... },
  orderFields: [...],
  logo: { ... },
  qrCode: { ... },
  customMessage: { ... },
  printDensity: 'compact' | 'normal' | 'spacious'
}
```

---

## 1. 基础信息

### 语言
```typescript
language: 'zh-CN' | 'en' | 'zh-TW'
```

### 纸张宽度
```typescript
paperWidth: 58 | 76 | 80  // 单位:mm
```

### 样式ID
```typescript
styleId: 'classic' | 'modern' | 'compact' | 'elegant'
```

**样式说明**:
- `classic` - 经典传统(等号分隔,标准间距)
- `modern` - 现代简约(破折号,大间距)
- `compact` - 紧凑节省(无分隔,最小间距)
- `elegant` - 精致优雅(装饰线,优雅间距)

---

## 2. 显示控制 (display)

```typescript
display: {
  logo: boolean,              // 显示Logo
  storeInfo: boolean,         // 显示地址+电话
  customerName: boolean,      // 显示取餐名(KIOSK用)
  itemAttributes: boolean,    // 显示商品属性(大杯/中杯)
  itemAddons: boolean,        // 显示加料
  itemNotes: boolean,         // 显示备注
  priceBreakdown: boolean,    // 显示小计/折扣/税费
  qrCode: boolean            // 显示二维码
}
```

### 示例

**POS - 完整显示**:
```json
{
  "logo": true,
  "storeInfo": true,
  "customerName": false,
  "itemAttributes": true,
  "itemAddons": true,
  "itemNotes": true,
  "priceBreakdown": true,
  "qrCode": true
}
```

**KIOSK - 突出取餐名**:
```json
{
  "logo": true,
  "storeInfo": false,
  "customerName": true,
  "itemAttributes": true,
  "itemAddons": true,
  "itemNotes": false,
  "priceBreakdown": false,
  "qrCode": true
}
```

**节省纸张**:
```json
{
  "logo": false,
  "storeInfo": false,
  "customerName": false,
  "itemAttributes": false,
  "itemAddons": true,
  "itemNotes": false,
  "priceBreakdown": false,
  "qrCode": false
}
```

---

## 3. 订单信息字段 (orderFields)

```typescript
orderFields: Array<'orderType' | 'tableNumber' | 'time' | 'customerPhone'>
```

### 字段说明

| 字段 | 说明 | 适用场景 |
|------|------|----------|
| `orderType` | 订单类型(堂食/外带) | POS |
| `tableNumber` | 桌号 | POS |
| `time` | 下单时间 | 所有 |
| `customerPhone` | 客户电话 | WEB外卖 |

### 示例

**POS**:
```json
["tableNumber", "orderType", "time"]
```

**KIOSK**:
```json
[]
```

**WEB**:
```json
["customerPhone", "time"]
```

---

## 4. Logo配置

```typescript
logo: {
  enabled: boolean,
  data: string,      // Base64编码的ESC/POS位图指令
  width: number,     // 像素宽度
  height: number,    // 像素高度
  alignment: 'left' | 'center' | 'right'
}
```

### 上传Logo

**API**:
```http
POST /api/order/v1/receipt-templates/:id/logo
Content-Type: multipart/form-data

logo: <image file>
alignment: center
```

**图片要求**:
- 格式: PNG/JPG
- 推荐宽度: 384px (适配58mm纸张)
- 最大宽度: 576px (适配80mm纸张)
- 自动转换为单色位图

### 示例

```json
{
  "enabled": true,
  "data": "base64_encoded_escpos_bitmap...",
  "width": 384,
  "height": 192,
  "alignment": "center"
}
```

**说明**:
- 后端自动转换为ESC/POS位图指令
- 终端直接解码发送给打印机,无需转换

---

## 5. 二维码配置

```typescript
qrCode: {
  enabled: boolean,
  urlTemplate: string,  // URL模板
  title: {              // 标题(可选)
    'zh-CN': string,
    'en': string,
    'zh-TW': string
  },
  sizeRatio: number,    // 占纸张宽度的比例 (0.5-0.8)
  errorCorrection: 'L' | 'M' | 'Q' | 'H',
  alignment: 'center'
}
```

### URL模板

**支持的变量**:
- `{orderId}` - 订单ID
- `{orderNumber}` - 订单号
- `{tableNumber}` - 桌号

**示例**:
```
https://example.com/order/{orderId}
https://example.com/order?no={orderNumber}
https://example.com/review/{orderId}
```

### 尺寸比例 (sizeRatio)

二维码尺寸 = 纸张宽度 × sizeRatio

| 纸张 | ratio=0.5 | ratio=0.6 | ratio=0.7 | ratio=0.8 |
|------|-----------|-----------|-----------|-----------|
| 58mm | 210px | 252px | 294px | 336px |
| 76mm | 275px | 330px | 385px | 440px |
| 80mm | 292px | 350px | 408px | 467px |

**推荐**:
- 普通用途: 0.6
- 大二维码(KIOSK): 0.7
- 小二维码(节省纸张): 0.5

### 纠错级别 (errorCorrection)

| 级别 | 容错率 | 说明 |
|------|--------|------|
| L | 7% | 最小,适合清晰环境 |
| M | 15% | 推荐,平衡容错和尺寸 |
| Q | 25% | 较高容错 |
| H | 30% | 最高容错,适合可能损坏的场景 |

### 示例

**查看订单**:
```json
{
  "enabled": true,
  "urlTemplate": "https://example.com/order/{orderId}",
  "title": {
    "zh-CN": "扫码查看订单",
    "en": "Scan for Order",
    "zh-TW": "掃碼查看訂單"
  },
  "sizeRatio": 0.6,
  "errorCorrection": "M",
  "alignment": "center"
}
```

**评价反馈**:
```json
{
  "enabled": true,
  "urlTemplate": "https://example.com/review/{orderId}",
  "title": {
    "zh-CN": "扫码评价",
    "en": "Scan to Review",
    "zh-TW": "掃碼評價"
  },
  "sizeRatio": 0.6,
  "errorCorrection": "M",
  "alignment": "center"
}
```

**支付**:
```json
{
  "enabled": true,
  "urlTemplate": "https://pay.example.com/order/{orderId}",
  "title": {
    "zh-CN": "扫码支付",
    "en": "Scan to Pay",
    "zh-TW": "掃碼支付"
  },
  "sizeRatio": 0.7,
  "errorCorrection": "M",
  "alignment": "center"
}
```

---

## 6. 自定义消息

```typescript
customMessage: {
  'zh-CN': string,
  'en': string,
  'zh-TW': string
}
```

### 示例

```json
{
  "zh-CN": "感谢惠顾,欢迎再来",
  "en": "Thank you, welcome back",
  "zh-TW": "感謝惠顧,歡迎再來"
}
```

```json
{
  "zh-CN": "祝您用餐愉快 ◆ 期待再次光临",
  "en": "Enjoy your meal ◆ See you again",
  "zh-TW": "祝您用餐愉快 ◆ 期待再次光臨"
}
```

---

## 7. 打印密度 (printDensity)

```typescript
printDensity: 'compact' | 'normal' | 'spacious'
```

### 说明

| 密度 | 行间距 | 走纸行数 | 适用场景 |
|------|--------|----------|----------|
| `compact` | ×0.8 | 2行 | 节省纸张 |
| `normal` | ×1.0 | 3行 | 标准打印 |
| `spacious` | ×1.5 | 5行 | 宽松舒适 |

### 示例

**节省纸张**:
```json
"printDensity": "compact"
```

**标准打印**:
```json
"printDensity": "normal"
```

**宽松舒适(KIOSK)**:
```json
"printDensity": "spacious"
```

---

## 完整配置示例

### POS配置
```json
{
  "language": "zh-CN",
  "paperWidth": 80,
  "styleId": "classic",
  "display": {
    "logo": true,
    "storeInfo": true,
    "customerName": false,
    "itemAttributes": true,
    "itemAddons": true,
    "itemNotes": true,
    "priceBreakdown": true,
    "qrCode": true
  },
  "orderFields": ["tableNumber", "orderType", "time"],
  "logo": {
    "enabled": true,
    "data": "base64...",
    "width": 384,
    "height": 192,
    "alignment": "center"
  },
  "qrCode": {
    "enabled": true,
    "urlTemplate": "https://example.com/order/{orderId}",
    "title": { "zh-CN": "扫码查看订单" },
    "sizeRatio": 0.6,
    "errorCorrection": "M",
    "alignment": "center"
  },
  "customMessage": { "zh-CN": "感谢惠顾" },
  "printDensity": "normal"
}
```

### KIOSK配置
```json
{
  "language": "zh-CN",
  "paperWidth": 80,
  "styleId": "modern",
  "display": {
    "logo": true,
    "storeInfo": false,
    "customerName": true,
    "itemAttributes": true,
    "itemAddons": true,
    "itemNotes": false,
    "priceBreakdown": false,
    "qrCode": true
  },
  "orderFields": [],
  "logo": {
    "enabled": true,
    "data": "base64...",
    "width": 384,
    "height": 192,
    "alignment": "center"
  },
  "qrCode": {
    "enabled": true,
    "urlTemplate": "https://example.com/order/{orderId}",
    "title": { "zh-CN": "扫码查看" },
    "sizeRatio": 0.7,
    "errorCorrection": "M",
    "alignment": "center"
  },
  "printDensity": "spacious"
}
```

### 节省纸张配置
```json
{
  "language": "zh-CN",
  "paperWidth": 58,
  "styleId": "compact",
  "display": {
    "logo": false,
    "storeInfo": false,
    "customerName": false,
    "itemAttributes": false,
    "itemAddons": true,
    "itemNotes": false,
    "priceBreakdown": false,
    "qrCode": false
  },
  "orderFields": [],
  "printDensity": "compact"
}
```

---

## 前端修改流程

### 1. 获取模板
```typescript
const { data: template } = await fetch(
  `/api/order/v1/receipt-templates/${templateId}`
);
```

### 2. 修改配置
```typescript
const config = template.config;

// 修改显示选项
config.display.storeInfo = false;
config.display.itemNotes = false;

// 修改订单字段
config.orderFields = ['tableNumber', 'time'];

// 修改二维码
config.qrCode.sizeRatio = 0.7;
config.qrCode.title['zh-CN'] = '扫码评价';

// 修改自定义消息
config.customMessage['zh-CN'] = '欢迎再来';

// 修改打印密度
config.printDensity = 'compact';
```

### 3. 提交更新
```typescript
await fetch(`/api/order/v1/receipt-templates/${templateId}`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ config })
});
```

---

## 快速参考

| 配置项 | 路径 | 类型 | 可选值 |
|--------|------|------|--------|
| 语言 | `language` | string | `zh-CN`, `en`, `zh-TW` |
| 纸张宽度 | `paperWidth` | number | `58`, `76`, `80` |
| 样式 | `styleId` | string | `classic`, `modern`, `compact`, `elegant` |
| 显示Logo | `display.logo` | boolean | `true`, `false` |
| 显示店铺信息 | `display.storeInfo` | boolean | `true`, `false` |
| 显示取餐名 | `display.customerName` | boolean | `true`, `false` |
| 显示属性 | `display.itemAttributes` | boolean | `true`, `false` |
| 显示加料 | `display.itemAddons` | boolean | `true`, `false` |
| 显示备注 | `display.itemNotes` | boolean | `true`, `false` |
| 显示明细 | `display.priceBreakdown` | boolean | `true`, `false` |
| 显示二维码 | `display.qrCode` | boolean | `true`, `false` |
| 二维码尺寸 | `qrCode.sizeRatio` | number | `0.5` ~ `0.8` |
| 纠错级别 | `qrCode.errorCorrection` | string | `L`, `M`, `Q`, `H` |
| 打印密度 | `printDensity` | string | `compact`, `normal`, `spacious` |
