/**
 * 票据设置的品牌 / 门店分层。
 *
 * ## 为什么分层
 * 票据长什么样是**品牌的事**：一个连锁店的小票不该这家有 logo 那家没有、
 * 这家印明细那家不印。但有几项品牌替分店决定不了 —— 定在这里。
 *
 * ## 分法
 * 主店（parentOrgId 为空的那个 org）那条记录 = **品牌模板**，全量生效。
 * 分店那条只存它覆盖的那几项，读取时盖在模板上。
 *
 * 门店能改的只有这些，其余一律跟品牌：
 *   · `isEnabled`   —— 没有标签机的店必须能关掉标签，这是设备现实不是偏好
 *   · `paperWidth`  —— 58mm 的机器印不了 80mm 的版式，统一了会直接印坏
 *   · `language`    —— 温哥华店中文、多伦多店英文，本来就该按店
 *   · 页脚自定义文案 —— 本店会员活动、营业时间这类
 *   · 店名/地址/电话 —— 它们是门店事实，不是样式（而且本来就由
 *     updateSetting 按 tenantId 自动从 auth-service 填）
 *
 * 剩下的（各 section 的显示开关、字号、版式、logo、二维码）全是品牌说了算。
 */

/** 分店能覆盖的 config 字段路径（点号表示嵌套） */
export const STORE_OVERRIDABLE_PATHS = [
  'paperWidth',
  'language',
  'sections.footer.customMessage',
  'sections.footer.qrCodeUrl',
  'sections.footer.qrCodeText',
  'sections.storeInfo.name',
  'sections.storeInfo.address',
  'sections.storeInfo.phone',
] as const;

const get = (o: any, path: string): any =>
  path.split('.').reduce((cur, k) => (cur == null ? cur : cur[k]), o);

const set = (o: any, path: string, v: any): void => {
  const keys = path.split('.');
  const last = keys.pop()!;
  let cur = o;
  for (const k of keys) {
    if (cur[k] == null || typeof cur[k] !== 'object') cur[k] = {};
    cur = cur[k];
  }
  cur[last] = v;
};

/**
 * 品牌模板 + 门店覆盖 = 这家店实际用的配置。
 *
 * 门店那条里**没有的字段就不覆盖** —— 分店没配过页脚时用品牌那句，
 * 而不是变成空字符串。
 */
export function mergeConfig(brandConfig: any, storeConfig: any): any {
  if (!storeConfig) return brandConfig;
  const out = JSON.parse(JSON.stringify(brandConfig ?? {}));
  for (const path of STORE_OVERRIDABLE_PATHS) {
    const v = get(storeConfig, path);
    if (v !== undefined && v !== null) set(out, path, v);
  }
  return out;
}

/**
 * 从分店提交的整份 config 里**只挑出它有权改的那几项**。
 *
 * 后台那边现在发的是全量（UI 还没分层），不过滤的话分店一保存就把整套样式
 * 抄成自己的，品牌级等于没有。返回 null 表示这次提交没有任何可覆盖项。
 */
export function pickOverrides(config: any): any | null {
  if (!config) return null;
  const out: any = {};
  let has = false;
  for (const path of STORE_OVERRIDABLE_PATHS) {
    const v = get(config, path);
    if (v !== undefined && v !== null) { set(out, path, v); has = true; }
  }
  return has ? out : null;
}
