/**
 * PII（个人身份信息）脱敏：日志落盘前统一打码手机号/邮箱，不改任何业务代码的打日志方式。
 *
 * 只做"高频、格式规整"的两类字段（手机号/邮箱），这是脱敏能覆盖到的主要场景，不追求
 * 100% 覆盖所有可能出现在日志里的敏感信息（比如自定义备注文字里夹带的信息规则覆盖不到）。
 * 保留足够信息用于核对（邮箱首字符+域名、手机号后4位），只是不再完整暴露。
 */

const EMAIL_RE = /([a-zA-Z0-9._%+-])[a-zA-Z0-9._%+-]*(@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
// 匹配 7 位及以上的连续数字（可带 +国家码前缀），只留最后 4 位
const PHONE_RE = /(\+?\d{1,3}[-\s]?)?(\d{3,})(\d{4})(?!\d)/g;

function maskString(s: string): string {
  let out = s.replace(EMAIL_RE, '$1***$2');
  out = out.replace(PHONE_RE, (match, prefix = '', mid, last4) => {
    // 避免误伤订单号/取餐号等非手机号的长数字——只在数字总长度像手机号（10~15位）时才打码
    const digits = (prefix || '').replace(/\D/g, '') + mid + last4;
    if (digits.length < 10 || digits.length > 15) return match;
    return `${prefix}***${last4}`;
  });
  return out;
}

const SKIP_KEYS = new Set(['timestamp', 'level', 'service', 'requestId']);

function deepScrub(value: unknown, depth = 0): unknown {
  if (depth > 6) return value; // 防止极端嵌套/循环引用拖慢日志写入
  if (typeof value === 'string') return maskString(value);
  if (Array.isArray(value)) return value.map((v) => deepScrub(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SKIP_KEYS.has(k) ? v : deepScrub(v, depth + 1);
    }
    return out;
  }
  return value;
}

import winston from 'winston';

/** winston format：脱敏 info.message 及其余所有字段（timestamp/level/service/requestId 除外） */
export const scrubPII = winston.format((info) => {
  for (const [k, v] of Object.entries(info)) {
    if (SKIP_KEYS.has(k)) continue;
    (info as Record<string, unknown>)[k] = deepScrub(v);
  }
  return info;
});
