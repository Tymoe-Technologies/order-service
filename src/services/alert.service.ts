import logger from '../utils/logger';

// Twilio 告警服务：只打电话（不发短信），英文播报。直接打 Twilio REST API
//（Basic Auth + x-www-form-urlencoded），不引入 twilio npm SDK，减少依赖体积，
// 也避免本次改动需要跑 npm install 才能验证。
// 负责方：order-service（编排方），触发场景见 delivery-confirmation-watchdog.ts 和
// auto-delivery-confirmation.ts 里对 sendOverdueUnconfirmedAlert / sendAutoConfirmFailedAlert 的调用

// Account SID（AC 开头）永远用于 URL 路径；Basic Auth 的用户名/密码可以是
// Auth Token（Account SID + Auth Token）或 API Key（API Key SID + Secret，SK 开头）两种之一。
// 优先用 API Key（更容易单独吊销、权限可控），没配置 API Key 时回退 Auth Token
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_API_KEY_SID = process.env.TWILIO_API_KEY_SID || '';
const TWILIO_API_KEY_SECRET = process.env.TWILIO_API_KEY_SECRET || '';
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER || '';
// 按 tenantId 映射值班号码，格式 "tenantIdA:+1xxx,tenantIdB:+1yyy"；先放 env，后续可迁 DB 做门店自助配置
const TWILIO_ALERT_TO_NUMBERS = process.env.TWILIO_ALERT_TO_NUMBERS || '';
// Twilio 试用账号不允许内联传 TwiML 内容（Twiml 参数），只能给一个公网可访问的 Url
// 让 Twilio 自己回调获取 TwiML；正式账号也推荐这种方式（内容变更不用改 Twilio 侧配置）
const ORDER_SERVICE_PUBLIC_URL = process.env.ORDER_SERVICE_PUBLIC_URL || '';
const TWILIO_VOICE_WEBHOOK_TOKEN = process.env.TWILIO_VOICE_WEBHOOK_TOKEN || '';

// 同订单同告警类型 30 分钟内只告警一次，防止 job 反复失败打爆配额
const ALERT_COOLDOWN_MS = 30 * 60 * 1000;
const lastAlertedAt = new Map<string, number>();

function resolveToNumber(tenantId: string): string | null {
  const entries = TWILIO_ALERT_TO_NUMBERS.split(',').map(s => s.trim()).filter(Boolean);
  // 不含 ":" 的纯号码（如只配了一个门店/测试阶段）当全局默认号码，不强制要求按 tenantId 配置
  if (entries.length === 1 && !entries[0].includes(':')) {
    return entries[0];
  }
  const map = new Map(entries.map(pair => pair.split(':').map(s => s.trim()) as [string, string]));
  return map.get(tenantId) || map.get('default') || null;
}

function getBasicAuthHeader(): string {
  const username = TWILIO_API_KEY_SID || TWILIO_ACCOUNT_SID;
  const password = TWILIO_API_KEY_SID ? TWILIO_API_KEY_SECRET : TWILIO_AUTH_TOKEN;
  return Buffer.from(`${username}:${password}`).toString('base64');
}

function isConfigured(): boolean {
  const hasCredential = (TWILIO_API_KEY_SID && TWILIO_API_KEY_SECRET) || TWILIO_AUTH_TOKEN;
  return !!(TWILIO_ACCOUNT_SID && hasCredential && TWILIO_FROM_NUMBER && ORDER_SERVICE_PUBLIC_URL && TWILIO_VOICE_WEBHOOK_TOKEN);
}

function shouldAlert(key: string): boolean {
  const now = Date.now();
  const last = lastAlertedAt.get(key);
  if (last && now - last < ALERT_COOLDOWN_MS) return false;
  lastAlertedAt.set(key, now);
  return true;
}

async function makeCall(to: string, message: string): Promise<void> {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls.json`;
  const twimlUrl = `${ORDER_SERVICE_PUBLIC_URL}/public/twilio/voice-alert?token=${encodeURIComponent(TWILIO_VOICE_WEBHOOK_TOKEN)}&text=${encodeURIComponent(message)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${getBasicAuthHeader()}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ To: to, From: TWILIO_FROM_NUMBER, Url: twimlUrl }).toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Twilio 呼叫发起失败: ${res.status} ${text}`);
  }
}

/** A3 watchdog 场景：超时未确认，作为"自动接单 job 本身失效"的双保险，打电话（英文播报） */
export async function sendOverdueUnconfirmedAlert(params: {
  orderId: string;
  tenantId: string;
  orderNumber: string | null;
}): Promise<void> {
  const key = `${params.orderId}:OVERDUE_UNCONFIRMED`;
  if (!shouldAlert(key)) return;
  if (!isConfigured()) {
    logger.warn('[AlertService] Twilio 未配置，跳过超时未确认电话告警', params);
    return;
  }
  const to = resolveToNumber(params.tenantId);
  if (!to) {
    logger.warn('[AlertService] 未配置该商家的值班号码，跳过超时未确认电话告警', params);
    return;
  }
  const orderRef = params.orderNumber || params.orderId;
  try {
    await makeCall(to, `Alert from Reall P O S. Order ${orderRef} has not been accepted for over 15 minutes. Please check it immediately.`);
  } catch (err: any) {
    logger.error('[AlertService] 超时未确认电话告警发起失败', { ...params, error: err.message });
  }
}

/**
 * C2 自动接单彻底失败场景：打电话（英文播报，顾客已扣款、订单要黄，最高优先级）。
 * refundOk=false 时文案升级为"取消成功但退款失败，需人工核实"
 */
export async function sendAutoConfirmFailedAlert(params: {
  orderId: string;
  tenantId: string;
  orderNumber: string | null;
  refundOk: boolean;
}): Promise<void> {
  const key = `${params.orderId}:AUTO_CONFIRM_FAILED`;
  if (!shouldAlert(key)) return;
  if (!isConfigured()) {
    logger.warn('[AlertService] Twilio 未配置，跳过自动接单失败电话告警', params);
    return;
  }
  const to = resolveToNumber(params.tenantId);
  if (!to) {
    logger.warn('[AlertService] 未配置该商家的值班号码，跳过自动接单失败电话告警', params);
    return;
  }

  const orderRef = params.orderNumber || params.orderId;
  const message = params.refundOk
    ? `Alert from Reall P O S. Automatic delivery creation failed for order ${orderRef}. The order has been cancelled and refunded. Please review.`
    : `Urgent alert from Reall P O S. Automatic delivery creation failed for order ${orderRef}. The order was cancelled but the refund also failed. Manual action is required immediately.`;

  try {
    await makeCall(to, message);
  } catch (err: any) {
    logger.error('[AlertService] 自动接单失败电话告警发起失败', { ...params, error: err.message });
  }
}
