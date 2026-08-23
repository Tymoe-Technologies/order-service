/**
 * 订单上顾客手机号的规范化。
 *
 * ## 为什么要有这一步
 * 同一个人的号在三个服务里长得不一样：auth 存 `+16725529511`（E.164）、
 * member 拆成 `+1` + `6725529511`、而订单里存的是**调用方传什么就是什么** ——
 * POS 传过 `6725529511`，国家码整个丢了。跨系统对身份只能靠猜。
 *
 * 统一成 E.164：ITU 标准、全球唯一无歧义，下游（发短信、支付渠道）本来也只吃这个。
 * 显示成什么样是渲染时的事。
 *
 * ## ⚠️ 这里**不能**加数据库 CHECK 约束
 * member 和 auth 那两处加了（那是我们自己控制的注册入口，格式不对就该拒）。
 * 订单不行：它来自 POS、网单、UberEats，一笔订单**绝不能因为手机号格式不合而建不成**
 * —— 那是把数据质量问题换成丢钱问题。和「客户端提供的可疑数据一律降级留痕、
 * 绝不拒绝请求」是同一条纪律。
 *
 * 所以策略是**尽力而为**：解析得出就存 E.164，解析不出就原样留着并记一条日志。
 * 宁可留一个格式怪的号，也不能把顾客的联系方式弄丢。
 */

import { parsePhoneNumberWithError, type CountryCode } from 'libphonenumber-js';
import logger from './logger';

/** 默认区域。将来商家有 region 设置时从租户配置取 */
const DEFAULT_COUNTRY: CountryCode = 'US';

/**
 * @returns E.164（如 `+16725529511`）；解析不出时返回**原值**（可能为 null）
 */
export function toE164(
  raw: string | null | undefined,
  defaultCountry: CountryCode = DEFAULT_COUNTRY,
): string | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  try {
    const parsed = parsePhoneNumberWithError(s, s.startsWith('+') ? undefined : defaultCountry);
    if (parsed.isValid()) return parsed.number;   // .number 就是 E.164
    logger.warn('[Phone] 手机号看起来不合法，原样保留', { raw: s });
    return s;
  } catch {
    logger.warn('[Phone] 手机号解析失败，原样保留', { raw: s });
    return s;
  }
}
