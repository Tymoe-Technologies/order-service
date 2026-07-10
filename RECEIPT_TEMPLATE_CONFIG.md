# 现代简约小票模板配置指南

## 概述

现代简约小票模板是一个通用的热敏纸打印模板，专为 POS 系统设计。模板可自动适配 58mm、76mm、80mm 三种常见的热敏纸宽度。

**特点**：
- ✅ 精简排版，突出关键信息
- ✅ 自动适配多种纸张宽度
- ✅ 用户可自定义显示内容
- ✅ 支持多语言 (中文、英文、繁体中文)
- ✅ 支持二维码打印

---

## 模板配置结构

```typescript
interface TemplateConfig {
  // 基础信息
  language: 'zh-CN' | 'en' | 'zh-TW';        // 默认语言
  paperWidth: 58 | 76 | 80;                   // 纸张宽度 (mm)
  styleId: 'modern-minimal';                  // 风格 ID (固定值)

  // 显示控制 - 选择要打印的内容
  display: {
    logo: boolean;                            // 显示 Logo
    storeInfo: boolean;                       // 显示店铺信息 (名称、地址、电话)
    customerName: boolean;                    // 显示顾客名称 (KIOSK 使用)
    itemAttributes: boolean;                  // 显示商品属性 (大/中/小杯等)
    itemAddons: boolean;                      // 显示加料
    itemNotes: boolean;                       // 显示备注
    priceBreakdown: boolean;                  // 显示价格明细 (小计、折扣)
    qrCode: boolean;                          // 显示二维码
  };

  // 订单信息字段
  orderFields: Array<
    'orderType' |      // 订单类型 (堂食/外带)
    'tableNumber' |    // 桌号
    'time' |           // 下单时间
    'customerPhone'    // 客户电话
  >;

  // 自定义消息 (感谢语、促销语等)
  customMessage?: {
    'zh-CN': string;
    'en': string;
    'zh-TW': string;
  };

  // 打印密度 - 影响行间距
  printDensity: 'compact' | 'normal' | 'spacious';

  // 二维码配置
  qrCode?: {
    enabled: boolean;
    urlTemplate: string;           // URL 模板，如: "https://example.com/order/{orderId}"
    sizeRatio: number;             // 占纸张宽度的比例 (0.5-0.9)
    errorCorrection: 'L'|'M'|'Q'|'H';  // 纠错级别
    alignment: 'center';           // 对齐方式
  };
}
```

---

## 默认配置示例

```typescript
{
  language: 'zh-CN',
  paperWidth: 58,
  styleId: 'modern-minimal',

  display: {
    logo: false,
    storeInfo: true,
    customerName: false,
    itemAttributes: true,
    itemAddons: true,
    itemNotes: true,
    priceBreakdown: true,
    qrCode: true,
  },

  orderFields: ['orderType', 'time'],

  customMessage: {
    'zh-CN': '感谢您的光临',
    'en': 'Thank you!',
    'zh-TW': '感謝您的光臨',
  },

  printDensity: 'compact',

  qrCode: {
    enabled: true,
    urlTemplate: 'https://example.com/order/{orderId}',
    sizeRatio: 0.7,
    errorCorrection: 'M',
    alignment: 'center',
  },
}
```

---

## 打印示例（58mm 纸张）

```
         泰莫餐厅

     北京市朝阳区测试路123号
         电话: 010-12345678

━━━━━━━━━━━━━━━━━━━━━━━

  订单: #001234
  堂食 | 18:30

━━━━━━━━━━━━━━━━━━━━━━━

美式咖啡 x2         ¥50.00
  大杯
  +加浓缩
  少冰

拿铁咖啡 x1         ¥36.00
  中杯

━━━━━━━━━━━━━━━━━━━━━━━

小计        ¥86.00
折扣        -¥8.60

━━━━━━━━━━━━━━━━━━━━━━━

合计        ¥77.40

━━━━━━━━━━━━━━━━━━━━━━━

   [QR Code]

  感谢您的光临

━━━━━━━━━━━━━━━━━━━━━━━
```

---

## 用户配置指南

在 Portal Frontend 中，用户可以通过 `ModernMinimalConfigForm` 组件配置模板：

### 1. 基础设置
- **默认语言**：选择小票的默认显示语言
- **纸张宽度**：选择打印机使用的纸张尺寸
- **排版密度**：紧凑/标准/宽松（影响行间距和整体排版）

### 2. 显示内容
勾选需要显示的内容项：
- 店铺信息 (推荐启用)
- 商品属性 (推荐启用)
- 加料 (推荐启用)
- 备注 (推荐启用)
- 价格明细 (推荐启用)
- 二维码 (推荐启用)

### 3. 订单信息字段
选择小票上要显示哪些订单信息：
- 订单类型 (堂食/外带)
- 下单时间
- 桌号 (可选)
- 客户电话 (可选)

### 4. 自定义感谢语
为每种语言设置感谢语或促销语 (最多 50 个字符)

### 5. 二维码配置
- **URL 模板**：设置扫描二维码后跳转的链接，使用 `{orderId}` 作为占位符
- **大小**：调整二维码在纸张中的相对大小
- **纠错级别**：M (15%) 推荐用于大多数场景

---

## API 接口

### 1. 获取标准模板 (无需认证)

```
GET /api/order/v1/receipt-templates/pos-print-template
```

**响应**：
```json
{
  "success": true,
  "data": {
    "id": "standard-modern-minimal",
    "name": { "zh-CN": "现代简约模板", ... },
    "description": { "zh-CN": "现代简约风格...", ... },
    "config": { ... },
    "version": "1.0",
    "updatedAt": "2025-12-11T10:00:00Z"
  }
}
```

### 2. 创建自定义模板

```
POST /api/order/v1/receipt-templates
Authorization: Bearer <token>
Content-Type: application/json
```

**请求体**：
```json
{
  "name": "我的自定义模板",
  "description": "为我的店铺定制的小票模板",
  "paperWidth": 58,
  "orderSource": "POS",
  "isDefault": true,
  "config": { ... }
}
```

### 3. 更新模板

```
PUT /api/order/v1/receipt-templates/:templateId
Authorization: Bearer <token>
Content-Type: application/json
```

### 4. 获取租户的所有模板

```
GET /api/order/v1/receipt-templates
Authorization: Bearer <token>
```

---

## 开发集成

### 前端使用

```typescript
// 导入组件
import ModernMinimalConfigForm from '@/pages/ReceiptTemplateManagement/ModernMinimalConfigForm'

// 使用示例
<ModernMinimalConfigForm
  initialConfig={templateConfig}
  onChange={(config) => {
    // 保存配置
    updateTemplate({ ...templateData, config })
  }}
/>
```

### 后端使用

```typescript
// 获取标准模板
import { getStandardTemplate } from '@/templates/receipt-template-standard'

const template = getStandardTemplate()
// 返回完整的 ReceiptTemplatePreset 对象
```

---

## 最佳实践

1. **始终启用店铺信息**：帮助客户识别你的店铺
2. **启用二维码**：方便客户反馈或跳转到评价页面
3. **自定义感谢语**：可以添加促销信息，但保持简洁
4. **选择合适的排版密度**：
   - 内容多时选 `normal` 或 `spacious`
   - 内容少时选 `compact`
5. **根据纸张宽度调整**：58mm 纸张较窄，建议精简显示内容
6. **定期测试打印**：配置完成后，使用测试打印功能验证效果

---

## 常见问题

**Q: 能否完全自定义排版？**
A: 不行。模板使用固定的排版风格，用户只能选择显示哪些内容。这是为了保持一致性和简洁性。

**Q: 支持打印图片/Logo 吗？**
A: 暂不支持。当前版本关注文本排版。如需添加 Logo，请在后续版本中考虑。

**Q: 如何修改字体大小？**
A: 字体大小由模板内部定义，不向用户暴露。如需不同的字体大小方案，可以创建新的模板样式。

**Q: 多个纸张宽度，排版会自动适配吗？**
A: 是的。后端 ESC/POS 生成器会根据 `paperWidth` 自动调整每行字符数和间距。

---

## 版本历史

- **v1.0** (2025-12-11)：现代简约模板首次发布
  - 支持 58mm/76mm/80mm 纸张
  - 支持多语言
  - 用户可配置显示内容
