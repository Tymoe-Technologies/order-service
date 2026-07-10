/**
 * POS端打印渲染示例代码
 * 
 * 这个文件展示了POS端如何:
 * 1. 下载并缓存小票模板
 * 2. 结合订单数据渲染小票
 * 3. 发送到热敏打印机
 */

// ============================================
// 1. 模板管理器
// ============================================

class ReceiptTemplateManager {
  private template: any = null;
  private templateVersion: number = 0;

  /**
   * 初始化 - POS启动时调用
   */
  async initialize(token: string) {
    // 从localStorage加载缓存的模板
    const cached = this.loadFromCache();
    if (cached) {
      this.template = cached.template;
      this.templateVersion = cached.version;
      console.log(`Loaded template from cache, version: ${this.templateVersion}`);
    }

    // 检查是否有更新
    await this.checkForUpdates(token);
  }

  /**
   * 检查模板更新
   */
  async checkForUpdates(token: string) {
    try {
      const response = await fetch(
        `http://localhost:3002/api/order/v1/receipt-templates/check-version?version=${this.templateVersion}`,
        {
          headers: {
            'Authorization': `Bearer ${token}`,
          },
        }
      );

      const result = await response.json();

      if (result.data.needsUpdate) {
        console.log(`New template version available: ${result.data.version}`);
        
        // 下载新模板
        if (result.data.template) {
          this.template = result.data.template;
          this.templateVersion = result.data.version;
          this.saveToCache();
          console.log('Template updated and cached');
        } else {
          // 如果没有返回完整模板,单独下载
          await this.downloadTemplate(result.data.id, token);
        }
      } else {
        console.log('Template is up to date');
      }
    } catch (error) {
      console.error('Failed to check template updates:', error);
    }
  }

  /**
   * 下载模板
   */
  async downloadTemplate(templateId: string, token: string) {
    try {
      const response = await fetch(
        `http://localhost:3002/api/order/v1/receipt-templates/${templateId}`,
        {
          headers: {
            'Authorization': `Bearer ${token}`,
          },
        }
      );

      const result = await response.json();
      this.template = result.data;
      this.templateVersion = result.data.version;
      this.saveToCache();
      console.log('Template downloaded and cached');
    } catch (error) {
      console.error('Failed to download template:', error);
    }
  }

  /**
   * 获取当前模板
   */
  getTemplate() {
    if (!this.template) {
      throw new Error('Template not loaded');
    }
    return this.template;
  }

  /**
   * 保存到缓存
   */
  private saveToCache() {
    const data = {
      template: this.template,
      version: this.templateVersion,
      cachedAt: new Date().toISOString(),
    };
    localStorage.setItem('receipt_template', JSON.stringify(data));
  }

  /**
   * 从缓存加载
   */
  private loadFromCache() {
    const cached = localStorage.getItem('receipt_template');
    if (cached) {
      return JSON.parse(cached);
    }
    return null;
  }
}

// ============================================
// 2. 小票渲染器
// ============================================

class ReceiptRenderer {
  private paperWidth: number;
  private charWidth: number;

  constructor(paperWidth: number = 80) {
    this.paperWidth = paperWidth;
    // 80mm约48字符,58mm约32字符
    this.charWidth = paperWidth === 80 ? 48 : 32;
  }

  /**
   * 渲染小票
   */
  render(order: any, template: any): string {
    const config = template.config;
    let output = '';

    // Header
    output += this.renderHeader(order, config.header);

    // Body
    output += this.renderBody(order, config.body);

    // Footer
    output += this.renderFooter(order, config.footer);

    // Style
    output += this.renderStyle(config.style);

    return output;
  }

  /**
   * 渲染头部
   */
  private renderHeader(order: any, config: any): string {
    let output = '';

    // Logo (实际打印时需要转换为位图)
    if (config.logo?.enabled && config.logo.imageUrl) {
      output += `[LOGO: ${config.logo.imageUrl}]\n`;
    }

    // 店铺名称
    if (config.storeName?.enabled) {
      const text = config.storeName.text;
      output += this.formatText(
        text,
        config.storeName.alignment,
        config.storeName.fontSize,
        config.storeName.bold
      );
    }

    // 店铺信息
    if (config.storeInfo?.enabled) {
      if (config.storeInfo.showAddress) {
        output += this.formatText(order.tenant?.address || '地址未设置', 'center', 'small');
      }
      if (config.storeInfo.showPhone) {
        output += this.formatText(order.tenant?.phone || '电话未设置', 'center', 'small');
      }
    }

    // 分隔线
    if (config.separator?.enabled) {
      output += this.formatSeparator(config.separator.char);
    }

    output += '\n';
    return output;
  }

  /**
   * 渲染主体
   */
  private renderBody(order: any, config: any): string {
    let output = '';

    // 订单信息
    if (config.orderInfo?.enabled && config.orderInfo.fields) {
      for (const field of config.orderInfo.fields) {
        if (field.enabled !== false) {
          const value = this.getFieldValue(order, field.field, field.format);
          output += this.formatText(
            `${field.label}: ${value}`,
            'left',
            field.fontSize,
            field.bold
          );
        }
      }
      output += '\n';
    }

    // 商品列表
    if (config.items?.enabled) {
      if (config.items.showHeader) {
        output += this.formatSeparator('-');
        output += this.formatText(config.items.headerText || '商品明细', 'center', 'medium', true);
        output += this.formatSeparator('-');
      }

      for (const item of order.items) {
        // 商品行
        const line = this.formatItemLine(
          item.itemName,
          `x${item.quantity}`,
          `¥${item.totalPrice}`
        );
        output += line + '\n';

        // 属性
        if (config.items.showAttributes && item.attributes) {
          output += `  规格: ${JSON.stringify(item.attributes)}\n`;
        }

        // 附加项
        if (config.items.showAddons && item.addons) {
          for (const addon of item.addons) {
            output += `  +${addon.name}  ¥${addon.price}\n`;
          }
        }

        // 备注
        if (config.items.showNotes && item.specialNotes) {
          output += `  备注: ${item.specialNotes}\n`;
        }
      }

      output += this.formatSeparator('-');
    }

    return output;
  }

  /**
   * 渲染底部
   */
  private renderFooter(order: any, config: any): string {
    let output = '';

    // 金额汇总
    if (config.summary?.enabled) {
      if (config.summary.showSubtotal) {
        output += this.formatSummaryLine('小计', order.subtotal);
      }
      if (config.summary.showDiscount && parseFloat(order.discountAmount) > 0) {
        output += this.formatSummaryLine('折扣', `-${order.discountAmount}`);
      }
      if (config.summary.showTax && parseFloat(order.taxAmount) > 0) {
        output += this.formatSummaryLine('税费', order.taxAmount);
      }
      if (config.summary.showTotal) {
        output += this.formatSeparator('-');
        output += this.formatText(
          this.formatSummaryLine('总计', order.totalAmount),
          'left',
          'large',
          true
        );
      }
      output += this.formatSeparator('=');
    }

    // 二维码
    if (config.qrcode?.enabled) {
      output += '\n';
      output += this.formatText('[二维码]', config.qrcode.alignment);
      output += this.formatText(order.orderNumber, config.qrcode.alignment);
      output += '\n';
    }

    // 自定义消息
    if (config.customMessage) {
      output += this.formatText(config.customMessage, 'center', 'small');
      output += '\n';
    }

    // WiFi信息
    if (config.wifi?.enabled) {
      output += this.formatText(`WiFi: ${config.wifi.ssid}`, 'center', 'small');
      output += this.formatText(`密码: ${config.wifi.password}`, 'center', 'small');
      output += '\n';
    }

    output += this.formatSeparator('=');

    return output;
  }

  /**
   * 渲染样式
   */
  private renderStyle(config: any): string {
    let output = '';
    
    // 底部留白
    const feedLines = config.feedLines || 3;
    output += '\n'.repeat(feedLines);

    // 切纸标记
    if (config.cutPaper) {
      output += '[CUT]\n';
    }

    return output;
  }

  // ============================================
  // 辅助方法
  // ============================================

  private formatText(
    text: string,
    align: string = 'left',
    size: string = 'medium',
    bold: boolean = false
  ): string {
    const prefix = bold ? '**' : '';
    const suffix = bold ? '**' : '';
    
    let formattedText = '';
    
    switch (align) {
      case 'center':
        const padding = Math.floor((this.charWidth - this.getDisplayLength(text)) / 2);
        formattedText = ' '.repeat(Math.max(0, padding)) + text;
        break;
      case 'right':
        const rightPadding = this.charWidth - this.getDisplayLength(text);
        formattedText = ' '.repeat(Math.max(0, rightPadding)) + text;
        break;
      default:
        formattedText = text;
    }

    return `${prefix}${formattedText}${suffix}\n`;
  }

  private formatSeparator(char: string = '='): string {
    return char.repeat(this.charWidth) + '\n';
  }

  private formatItemLine(name: string, quantity: string, price: string): string {
    const nameWidth = this.charWidth - 12;
    const truncatedName = this.truncateText(name, nameWidth);
    const spaces = this.charWidth - this.getDisplayLength(truncatedName) - 
                    this.getDisplayLength(quantity) - this.getDisplayLength(price);
    
    return truncatedName + ' '.repeat(Math.max(1, spaces)) + quantity + 
           ' '.repeat(4) + price;
  }

  private formatSummaryLine(label: string, value: any): string {
    const valueStr = `¥${value}`;
    const spaces = this.charWidth - this.getDisplayLength(label) - 
                    this.getDisplayLength(valueStr) - 2;
    return label + ': ' + ' '.repeat(Math.max(1, spaces)) + valueStr + '\n';
  }

  private getFieldValue(obj: any, field: string, format?: string): string {
    const value = field.split('.').reduce((o, k) => o?.[k], obj);
    
    if (format && value instanceof Date) {
      // 简单的日期格式化
      return value.toLocaleString('zh-CN');
    }
    
    return value?.toString() || '';
  }

  private getDisplayLength(str: string): number {
    let len = 0;
    for (const char of str) {
      // 中文字符占2个位置,英文占1个
      len += /[\u4e00-\u9fa5]/.test(char) ? 2 : 1;
    }
    return len;
  }

  private truncateText(text: string, maxWidth: number): string {
    let width = 0;
    let result = '';
    
    for (const char of text) {
      const charWidth = /[\u4e00-\u9fa5]/.test(char) ? 2 : 1;
      if (width + charWidth > maxWidth) break;
      result += char;
      width += charWidth;
    }
    
    return result;
  }
}

// ============================================
// 3. 使用示例
// ============================================

// POS启动时初始化
const templateManager = new ReceiptTemplateManager();
await templateManager.initialize(userToken);

// 打印订单
async function printOrder(orderId: string) {
  try {
    // 1. 获取订单数据
    const orderResponse = await fetch(
      `http://localhost:3002/api/order/v1/orders/${orderId}`,
      {
        headers: { 'Authorization': `Bearer ${userToken}` },
      }
    );
    const orderData = await orderResponse.json();
    const order = orderData.data;

    // 2. 获取模板
    const template = templateManager.getTemplate();

    // 3. 渲染小票
    const renderer = new ReceiptRenderer(template.paperWidth);
    const receiptText = renderer.render(order, template);

    // 4. 发送到打印机
    console.log('=== 小票内容 ===');
    console.log(receiptText);
    console.log('=== 发送到打印机 ===');
    
    // 实际打印代码(根据打印机类型)
    // await sendToPrinter(receiptText);
    
    console.log('打印成功!');
  } catch (error) {
    console.error('打印失败:', error);
  }
}

// 定期检查模板更新(例如每小时)
setInterval(async () => {
  await templateManager.checkForUpdates(userToken);
}, 3600000);

export { ReceiptTemplateManager, ReceiptRenderer };
