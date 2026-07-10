# 订单通知系统设计

## 概述

为不同订单来源提供差异化的通知服务，特别是 WEB 订单需要通过邮件和短信通知客户订单状态变化。

---

## 通知策略

### 不同订单来源的通知需求

| 订单来源 | 短信通知 | 邮件通知 | 推送通知 | 叫号屏 |
|---------|---------|---------|---------|--------|
| **POS** | ❌ 不需要 | ❌ 不需要 | ❌ 不需要 | ❌ 不需要 |
| **KIOSK** | ✅ 需要 | ❌ 不需要 | ❌ 不需要 | ✅ 需要 |
| **WEB** | ✅ 需要 | ✅ 需要 | ⚠️ 可选 | ❌ 不需要 |
| **外卖** | ❌ 平台负责 | ❌ 平台负责 | ❌ 平台负责 | ❌ 不需要 |

---

## 通知触发时机

### WEB 订单通知流程

```
订单创建 (PENDING)
    ↓
支付成功 → 📧 邮件: "订单已确认"
    ↓     📱 短信: "订单 #123 已确认，预计20分钟完成"
订单确认 (CONFIRMED)
    ↓
开始制作 (PREPARING)
    ↓
制作完成 → 📧 邮件: "订单已完成，请来取餐"
    ↓     📱 短信: "订单 #123 已完成，请到店取餐"
等待取餐 (READY)
    ↓
客户取餐 (PICKED_UP)
    ↓
订单完成 → 📧 邮件: "感谢您的光临，期待下次再见"
(COMPLETED)
```

### KIOSK 订单通知流程

```
订单创建 (PENDING)
    ↓
支付成功 → 📱 短信: "订单 #123 已确认，取餐号：88"
    ↓     🔔 叫号屏: 显示取餐号
订单确认 (CONFIRMED)
    ↓
开始制作 (PREPARING)
    ↓
制作完成 → 📱 短信: "88号请取餐"
    ↓     🔔 叫号屏: 闪烁显示 88号
    ↓     🔊 语音: "请88号取餐"
等待取餐 (READY)
```

---

## 通知服务架构

### 1. 通知服务接口

```typescript
// src/services/notification/notification.service.ts

export interface NotificationChannel {
  send(recipient: string, message: NotificationMessage): Promise<void>;
}

export interface NotificationMessage {
  subject?: string;
  body: string;
  template?: string;
  data?: Record<string, any>;
}

export class NotificationService {
  private channels: Map<string, NotificationChannel>;

  constructor() {
    this.channels = new Map([
      ['sms', new SMSChannel()],
      ['email', new EmailChannel()],
      ['push', new PushChannel()]
    ]);
  }

  /**
   * 发送通知
   */
  async send(
    channel: 'sms' | 'email' | 'push',
    recipient: string,
    message: NotificationMessage
  ): Promise<void> {
    const sender = this.channels.get(channel);
    if (!sender) {
      throw new Error(`Unknown notification channel: ${channel}`);
    }
    
    await sender.send(recipient, message);
  }

  /**
   * 发送订单状态通知
   */
  async sendOrderStatusNotification(
    order: Order,
    status: OrderStatus
  ): Promise<void> {
    // 根据订单来源决定发送哪些通知
    const notifications = this.getNotificationsForStatus(order, status);
    
    await Promise.allSettled(
      notifications.map(n => this.send(n.channel, n.recipient, n.message))
    );
  }

  /**
   * 获取状态对应的通知配置
   */
  private getNotificationsForStatus(
    order: Order,
    status: OrderStatus
  ): NotificationConfig[] {
    const notifications: NotificationConfig[] = [];

    // WEB 订单通知
    if (order.orderSource === 'WEB') {
      switch (status) {
        case 'CONFIRMED':
          if (order.customerEmail) {
            notifications.push({
              channel: 'email',
              recipient: order.customerEmail,
              message: this.getEmailTemplate('order-confirmed', order)
            });
          }
          if (order.customerPhone) {
            notifications.push({
              channel: 'sms',
              recipient: order.customerPhone,
              message: this.getSMSTemplate('order-confirmed', order)
            });
          }
          break;

        case 'READY':
          if (order.customerEmail) {
            notifications.push({
              channel: 'email',
              recipient: order.customerEmail,
              message: this.getEmailTemplate('order-ready', order)
            });
          }
          if (order.customerPhone) {
            notifications.push({
              channel: 'sms',
              recipient: order.customerPhone,
              message: this.getSMSTemplate('order-ready', order)
            });
          }
          break;

        case 'COMPLETED':
          if (order.customerEmail) {
            notifications.push({
              channel: 'email',
              recipient: order.customerEmail,
              message: this.getEmailTemplate('order-completed', order)
            });
          }
          break;

        case 'CANCELLED':
          if (order.customerEmail) {
            notifications.push({
              channel: 'email',
              recipient: order.customerEmail,
              message: this.getEmailTemplate('order-cancelled', order)
            });
          }
          if (order.customerPhone) {
            notifications.push({
              channel: 'sms',
              recipient: order.customerPhone,
              message: this.getSMSTemplate('order-cancelled', order)
            });
          }
          break;
      }
    }

    // KIOSK 订单通知
    if (order.orderSource === 'KIOSK') {
      switch (status) {
        case 'CONFIRMED':
          if (order.customerPhone) {
            notifications.push({
              channel: 'sms',
              recipient: order.customerPhone,
              message: this.getSMSTemplate('kiosk-confirmed', order)
            });
          }
          break;

        case 'READY':
          if (order.customerPhone) {
            notifications.push({
              channel: 'sms',
              recipient: order.customerPhone,
              message: this.getSMSTemplate('kiosk-ready', order)
            });
          }
          break;
      }
    }

    return notifications;
  }
}
```

---

## 2. 短信服务实现

### 短信渠道 (支持多个短信服务商)

```typescript
// src/services/notification/channels/sms.channel.ts

import { NotificationChannel, NotificationMessage } from '../notification.service';
import logger from '../../../utils/logger';

export class SMSChannel implements NotificationChannel {
  private provider: SMSProvider;

  constructor() {
    // 根据环境变量选择短信服务商
    const providerName = process.env.SMS_PROVIDER || 'twilio';
    this.provider = this.createProvider(providerName);
  }

  async send(recipient: string, message: NotificationMessage): Promise<void> {
    try {
      await this.provider.sendSMS(recipient, message.body);
      logger.info('SMS sent successfully', { recipient, provider: this.provider.name });
    } catch (error) {
      logger.error('Failed to send SMS', { recipient, error });
      throw error;
    }
  }

  private createProvider(name: string): SMSProvider {
    switch (name) {
      case 'twilio':
        return new TwilioProvider();
      case 'aliyun':
        return new AliyunSMSProvider();
      case 'tencent':
        return new TencentSMSProvider();
      default:
        return new MockSMSProvider(); // 开发环境使用
    }
  }
}

// 短信服务商接口
interface SMSProvider {
  name: string;
  sendSMS(phone: string, message: string): Promise<void>;
}

// Twilio 实现
class TwilioProvider implements SMSProvider {
  name = 'twilio';
  private client: any;

  constructor() {
    // 需要安装: npm install twilio
    // const twilio = require('twilio');
    // this.client = twilio(
    //   process.env.TWILIO_ACCOUNT_SID,
    //   process.env.TWILIO_AUTH_TOKEN
    // );
  }

  async sendSMS(phone: string, message: string): Promise<void> {
    // await this.client.messages.create({
    //   body: message,
    //   from: process.env.TWILIO_PHONE_NUMBER,
    //   to: phone
    // });
    logger.info('[Twilio] SMS would be sent', { phone, message });
  }
}

// 阿里云短信实现
class AliyunSMSProvider implements SMSProvider {
  name = 'aliyun';

  async sendSMS(phone: string, message: string): Promise<void> {
    // TODO: 实现阿里云短信 API
    logger.info('[Aliyun] SMS would be sent', { phone, message });
  }
}

// 腾讯云短信实现
class TencentSMSProvider implements SMSProvider {
  name = 'tencent';

  async sendSMS(phone: string, message: string): Promise<void> {
    // TODO: 实现腾讯云短信 API
    logger.info('[Tencent] SMS would be sent', { phone, message });
  }
}

// Mock 实现（开发环境）
class MockSMSProvider implements SMSProvider {
  name = 'mock';

  async sendSMS(phone: string, message: string): Promise<void> {
    logger.info('[Mock SMS]', { phone, message });
    console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📱 SMS Notification (Mock)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
To: ${phone}
Message: ${message}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    `);
  }
}
```

---

## 3. 邮件服务实现

### 邮件渠道 (支持多个邮件服务商)

```typescript
// src/services/notification/channels/email.channel.ts

import { NotificationChannel, NotificationMessage } from '../notification.service';
import logger from '../../../utils/logger';

export class EmailChannel implements NotificationChannel {
  private provider: EmailProvider;

  constructor() {
    const providerName = process.env.EMAIL_PROVIDER || 'sendgrid';
    this.provider = this.createProvider(providerName);
  }

  async send(recipient: string, message: NotificationMessage): Promise<void> {
    try {
      await this.provider.sendEmail(
        recipient,
        message.subject || 'Order Notification',
        message.body
      );
      logger.info('Email sent successfully', { recipient, provider: this.provider.name });
    } catch (error) {
      logger.error('Failed to send email', { recipient, error });
      throw error;
    }
  }

  private createProvider(name: string): EmailProvider {
    switch (name) {
      case 'sendgrid':
        return new SendGridProvider();
      case 'ses':
        return new AmazonSESProvider();
      case 'smtp':
        return new SMTPProvider();
      default:
        return new MockEmailProvider();
    }
  }
}

interface EmailProvider {
  name: string;
  sendEmail(to: string, subject: string, body: string): Promise<void>;
}

// SendGrid 实现
class SendGridProvider implements EmailProvider {
  name = 'sendgrid';

  async sendEmail(to: string, subject: string, body: string): Promise<void> {
    // 需要安装: npm install @sendgrid/mail
    // const sgMail = require('@sendgrid/mail');
    // sgMail.setApiKey(process.env.SENDGRID_API_KEY);
    // 
    // await sgMail.send({
    //   to,
    //   from: process.env.SENDGRID_FROM_EMAIL,
    //   subject,
    //   html: body
    // });
    logger.info('[SendGrid] Email would be sent', { to, subject });
  }
}

// Amazon SES 实现
class AmazonSESProvider implements EmailProvider {
  name = 'ses';

  async sendEmail(to: string, subject: string, body: string): Promise<void> {
    // TODO: 实现 Amazon SES
    logger.info('[Amazon SES] Email would be sent', { to, subject });
  }
}

// SMTP 实现
class SMTPProvider implements EmailProvider {
  name = 'smtp';

  async sendEmail(to: string, subject: string, body: string): Promise<void> {
    // 需要安装: npm install nodemailer
    // const nodemailer = require('nodemailer');
    // const transporter = nodemailer.createTransport({
    //   host: process.env.SMTP_HOST,
    //   port: process.env.SMTP_PORT,
    //   auth: {
    //     user: process.env.SMTP_USER,
    //     pass: process.env.SMTP_PASS
    //   }
    // });
    // 
    // await transporter.sendMail({
    //   from: process.env.SMTP_FROM,
    //   to,
    //   subject,
    //   html: body
    // });
    logger.info('[SMTP] Email would be sent', { to, subject });
  }
}

// Mock 实现
class MockEmailProvider implements EmailProvider {
  name = 'mock';

  async sendEmail(to: string, subject: string, body: string): Promise<void> {
    logger.info('[Mock Email]', { to, subject });
    console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📧 Email Notification (Mock)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
To: ${to}
Subject: ${subject}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${body}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    `);
  }
}
```

---

## 4. 通知模板

### 短信模板

```typescript
// src/services/notification/templates/sms.templates.ts

export const SMS_TEMPLATES = {
  // WEB 订单确认
  'order-confirmed': (order: Order) => 
    `【餐厅名】您的订单 #${order.orderNumber} 已确认，预计${order.estimatedTime || 20}分钟完成。订单金额：$${order.totalAmount}`,

  // WEB 订单完成
  'order-ready': (order: Order) => 
    `【餐厅名】您的订单 #${order.orderNumber} 已完成，请到店取餐。地址：${order.storeAddress}`,

  // WEB 订单取消
  'order-cancelled': (order: Order) => 
    `【餐厅名】您的订单 #${order.orderNumber} 已取消。如有疑问请联系客服。`,

  // KIOSK 订单确认
  'kiosk-confirmed': (order: Order) => 
    `【餐厅名】订单已确认，您的取餐号是：${order.pickupNumber}。请留意叫号屏。`,

  // KIOSK 订单完成
  'kiosk-ready': (order: Order) => 
    `【餐厅名】${order.pickupNumber}号请取餐！`
};
```

### 邮件模板

```typescript
// src/services/notification/templates/email.templates.ts

export const EMAIL_TEMPLATES = {
  // 订单确认邮件
  'order-confirmed': (order: Order) => ({
    subject: `订单确认 - #${order.orderNumber}`,
    body: `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #4CAF50; color: white; padding: 20px; text-align: center; }
          .content { padding: 20px; background: #f9f9f9; }
          .order-details { background: white; padding: 15px; margin: 10px 0; }
          .footer { text-align: center; padding: 20px; color: #666; }
          .button { background: #4CAF50; color: white; padding: 10px 20px; text-decoration: none; display: inline-block; margin: 10px 0; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>✅ 订单已确认</h1>
          </div>
          <div class="content">
            <p>亲爱的 ${order.customerName || '顾客'}，</p>
            <p>感谢您的订单！我们已经收到并确认了您的订单。</p>
            
            <div class="order-details">
              <h3>订单详情</h3>
              <p><strong>订单号：</strong>${order.orderNumber}</p>
              <p><strong>下单时间：</strong>${new Date(order.createdAt).toLocaleString()}</p>
              <p><strong>预计完成时间：</strong>${order.estimatedTime || 20}分钟</p>
              <p><strong>订单金额：</strong>$${order.totalAmount}</p>
              
              <h4>订单商品</h4>
              <ul>
                ${order.orderItems.map(item => `
                  <li>${item.itemName} x${item.quantity} - $${item.totalPrice}</li>
                `).join('')}
              </ul>
            </div>
            
            <p>我们会在订单完成后通知您来取餐。</p>
            
            <a href="${process.env.WEB_URL}/orders/${order.id}" class="button">查看订单详情</a>
          </div>
          <div class="footer">
            <p>如有任何问题，请联系我们</p>
            <p>电话：${order.storePhone} | 地址：${order.storeAddress}</p>
          </div>
        </div>
      </body>
      </html>
    `
  }),

  // 订单完成邮件
  'order-ready': (order: Order) => ({
    subject: `订单已完成 - #${order.orderNumber}`,
    body: `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #2196F3; color: white; padding: 20px; text-align: center; }
          .content { padding: 20px; background: #f9f9f9; }
          .highlight { background: #FFF9C4; padding: 15px; margin: 10px 0; text-align: center; font-size: 18px; }
          .footer { text-align: center; padding: 20px; color: #666; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>🎉 订单已完成</h1>
          </div>
          <div class="content">
            <p>亲爱的 ${order.customerName || '顾客'}，</p>
            <p>您的订单已经制作完成，请尽快到店取餐！</p>
            
            <div class="highlight">
              <strong>订单号：${order.orderNumber}</strong>
            </div>
            
            <p><strong>取餐地址：</strong>${order.storeAddress}</p>
            <p><strong>联系电话：</strong>${order.storePhone}</p>
            
            <p>期待您的光临！</p>
          </div>
          <div class="footer">
            <p>感谢您的惠顾</p>
          </div>
        </div>
      </body>
      </html>
    `
  }),

  // 订单完成感谢邮件
  'order-completed': (order: Order) => ({
    subject: `感谢您的光临 - #${order.orderNumber}`,
    body: `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #FF9800; color: white; padding: 20px; text-align: center; }
          .content { padding: 20px; background: #f9f9f9; }
          .footer { text-align: center; padding: 20px; color: #666; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>💖 感谢您的光临</h1>
          </div>
          <div class="content">
            <p>亲爱的 ${order.customerName || '顾客'}，</p>
            <p>感谢您选择我们！希望您享受美味的一餐。</p>
            <p>期待下次再见！</p>
          </div>
          <div class="footer">
            <p>欢迎再次光临</p>
          </div>
        </div>
      </body>
      </html>
    `
  })
};
```

---

## 5. 环境变量配置

```env
# .env.development

# 通知服务配置
NOTIFICATION_ENABLED=true

# 短信服务配置
SMS_PROVIDER=mock  # twilio, aliyun, tencent, mock
TWILIO_ACCOUNT_SID=your_account_sid
TWILIO_AUTH_TOKEN=your_auth_token
TWILIO_PHONE_NUMBER=+1234567890

# 邮件服务配置
EMAIL_PROVIDER=mock  # sendgrid, ses, smtp, mock
SENDGRID_API_KEY=your_api_key
SENDGRID_FROM_EMAIL=noreply@restaurant.com

# SMTP 配置
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your_email@gmail.com
SMTP_PASS=your_password
SMTP_FROM=noreply@restaurant.com

# 网站地址
WEB_URL=http://localhost:8888
```

---

## 6. 集成到订单状态服务

```typescript
// src/services/order-status.service.ts

import notificationService from './notification/notification.service';

export class OrderStatusService {
  // ... 现有代码

  /**
   * 订单完成时的处理
   */
  private async onOrderReady(order: any) {
    logger.info(`Order ready: ${order.orderNumber}`);

    // 发送通知
    await notificationService.sendOrderStatusNotification(order, 'READY');

    // KIOSK 订单：额外触发叫号
    if (order.orderSource === 'KIOSK') {
      await this.callNumber(order);
    }
  }

  /**
   * 订单确认时的处理
   */
  private async onOrderConfirmed(order: any) {
    logger.info(`Order confirmed: ${order.orderNumber}`);
    
    // 发送通知
    await notificationService.sendOrderStatusNotification(order, 'CONFIRMED');
  }

  /**
   * 订单完成时的处理
   */
  private async onOrderCompleted(order: any) {
    logger.info(`Order completed: ${order.orderNumber}`);
    
    // 发送感谢通知
    await notificationService.sendOrderStatusNotification(order, 'COMPLETED');
  }
}
```

---

## 7. 测试通知

### 测试脚本

```typescript
// test-notification.ts

import notificationService from './src/services/notification/notification.service';

async function testNotifications() {
  const mockOrder = {
    id: 'test-uuid',
    orderNumber: 'TEST-001',
    customerName: '张三',
    customerEmail: 'test@example.com',
    customerPhone: '+1234567890',
    totalAmount: 45.99,
    orderItems: [
      { itemName: '宫保鸡丁', quantity: 1, totalPrice: 38.00 },
      { itemName: '米饭', quantity: 1, totalPrice: 3.00 }
    ],
    createdAt: new Date(),
    estimatedTime: 20,
    storeAddress: '123 Main St',
    storePhone: '555-1234',
    orderSource: 'WEB'
  };

  console.log('Testing WEB order notifications...\n');

  // 测试订单确认通知
  console.log('1. Testing order confirmed notification...');
  await notificationService.sendOrderStatusNotification(mockOrder, 'CONFIRMED');

  // 测试订单完成通知
  console.log('\n2. Testing order ready notification...');
  await notificationService.sendOrderStatusNotification(mockOrder, 'READY');

  // 测试订单完成感谢通知
  console.log('\n3. Testing order completed notification...');
  await notificationService.sendOrderStatusNotification(mockOrder, 'COMPLETED');

  console.log('\n✅ All tests completed!');
}

testNotifications().catch(console.error);
```

---

## 8. 通知失败处理

### 重试机制

```typescript
export class NotificationService {
  async sendWithRetry(
    channel: string,
    recipient: string,
    message: NotificationMessage,
    maxRetries: number = 3
  ): Promise<void> {
    let lastError: Error | null = null;

    for (let i = 0; i < maxRetries; i++) {
      try {
        await this.send(channel, recipient, message);
        return; // 成功，退出
      } catch (error) {
        lastError = error as Error;
        logger.warn(`Notification failed, retry ${i + 1}/${maxRetries}`, {
          channel,
          recipient,
          error
        });
        
        // 等待后重试
        await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
      }
    }

    // 所有重试都失败
    logger.error('Notification failed after all retries', {
      channel,
      recipient,
      error: lastError
    });

    // 记录到失败队列，稍后处理
    await this.logFailedNotification(channel, recipient, message, lastError);
  }

  private async logFailedNotification(
    channel: string,
    recipient: string,
    message: NotificationMessage,
    error: Error | null
  ): Promise<void> {
    // TODO: 存储到数据库或消息队列
    logger.error('Failed notification logged', {
      channel,
      recipient,
      message,
      error
    });
  }
}
```

---

## 总结

### 已实现功能

- ✅ 通知服务架构设计
- ✅ 短信渠道（支持多服务商）
- ✅ 邮件渠道（支持多服务商）
- ✅ 通知模板系统
- ✅ WEB 订单通知流程
- ✅ KIOSK 订单通知流程
- ✅ Mock 实现（开发环境）

### 待实现功能

- [ ] 实际短信服务商集成
- [ ] 实际邮件服务商集成
- [ ] 通知失败重试机制
- [ ] 通知发送记录
- [ ] 用户通知偏好设置
- [ ] 推送通知（App）
- [ ] 通知统计分析

### 使用建议

1. **开发环境**：使用 Mock 实现，在控制台查看通知内容
2. **测试环境**：使用真实服务商的测试账号
3. **生产环境**：使用真实服务商，配置好 API 密钥

### 成本考虑

- 短信：按条收费，建议只在关键状态发送
- 邮件：通常有免费额度，成本较低
- 推送：免费，但需要 App 支持




