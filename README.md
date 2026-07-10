# 小票模板系统

## 快速开始

### 1. 选择样式并创建模板
```bash
POST /api/order/v1/receipt-templates/create-all-sources
{
  "styleId": "classic",
  "paperWidth": 80,
  "language": "zh-CN"
}
```

### 2. 上传Logo(可选)
```bash
POST /api/order/v1/receipt-templates/:id/logo
Content-Type: multipart/form-data

logo: <image file>
alignment: center
```

### 3. 配置显示选项
```bash
PUT /api/order/v1/receipt-templates/:id
{
  "config": {
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
    "qrCode": {
      "urlTemplate": "https://example.com/order/{orderId}",
      "sizeRatio": 0.6,
      "errorCorrection": "M"
    },
    "printDensity": "normal"
  }
}
```

### 4. 终端打印
```bash
GET /api/order/v1/receipt-templates/by-source/POS
```

---

## 核心概念

### 样式(Style)
预设的视觉风格,控制字体大小、间距、分隔符等

- `classic` - 经典传统(等号分隔,紧凑)
- `modern` - 现代简约(破折号,大间距)
- `compact` - 紧凑节省(无分隔,最小间距)
- `elegant` - 精致优雅(装饰线,优雅间距)

### 显示控制(Display)
简单的开关,控制显示什么内容

```typescript
{
  logo: boolean,              // Logo
  storeInfo: boolean,         // 地址+电话
  customerName: boolean,      // 取餐名(KIOSK)
  itemAttributes: boolean,    // 商品属性
  itemAddons: boolean,        // 加料
  itemNotes: boolean,         // 备注
  priceBreakdown: boolean,    // 小计/折扣/税费
  qrCode: boolean            // 二维码
}
```

### Logo
- 上传图片(PNG/JPG)
- 后端转换为ESC/POS位图指令
- 存储为Base64编码
- 终端直接发送给打印机

### 二维码
- 存储URL模板: `https://example.com/order/{orderId}`
- 终端替换变量后生成二维码
- 尺寸根据纸张宽度自动计算
- 支持L/M/Q/H四种纠错级别

---

## 文档

- [API.md](./API.md) - API接口文档
- [DESIGN.md](./DESIGN.md) - 详细设计文档
- [CONFIG.md](./CONFIG.md) - 配置说明(已过时,参考DESIGN.md)

---

## 配置示例

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
  "qrCode": {
    "enabled": true,
    "urlTemplate": "https://example.com/order/{orderId}",
    "title": { "zh-CN": "扫码查看订单" },
    "sizeRatio": 0.6,
    "errorCorrection": "M"
  },
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
  "qrCode": {
    "enabled": true,
    "urlTemplate": "https://example.com/order/{orderId}",
    "title": { "zh-CN": "扫码查看" },
    "sizeRatio": 0.7,
    "errorCorrection": "M"
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
