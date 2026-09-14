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
 *   · `language` / `secondaryLanguage` —— 温哥华店中文、多伦多店英文；
 *     厨房单的第二语言取决于这家店后厨是谁在看
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
  // 第二语言和主语言同理：厨房里是谁在看，只有这家店知道
  'secondaryLanguage',
  'sections.footer.customMessage',
  'sections.footer.qrCodeUrl',
  'sections.footer.qrCodeText',
  'sections.storeInfo.name',
  'sections.storeInfo.address',
  'sections.storeInfo.phone',
  /*
    标签纸的规格和打印浓度：和纸宽同理，是**这台机器/这卷纸**的事实。
    分店用 40×30 的纸而品牌模板写着 50×30，统一了就是印歪或印不下。
    浓度同理 —— 不同标签纸的显色不一样，要按机器调。
  */
  'labelWidth',
  'labelHeight',
  'labelGap',
  'style.printDensity',
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

const del = (o: any, path: string): void => {
  const keys = path.split('.');
  const last = keys.pop()!;
  const parent = keys.reduce((cur, k) => (cur == null ? cur : cur[k]), o);
  if (parent && typeof parent === 'object') delete parent[last];
};

/**
 * 品牌模板 + 门店覆盖 = 这家店实际用的配置。
 *
 * ## 门店级字段**不从品牌继承**
 * 主店那条记录同时是两样东西：品牌模板，和主店自己那家店的设置。
 * 如果分店去继承它的 language / 页脚，主店店长把自己店改成中文，
 * 所有没单独配过的分店就跟着变中文了 —— 他改的是自己那家店，不是全品牌。
 *
 * 所以这几项只认门店自己那条；没配过就是「没有」，由下游各自兜底
 * （language 为空 → 商品名走界面语言，见 ticketLocale；
 *  paperWidth 为空 → 用打印机自身的纸宽）。
 * 品牌规定的是**样式**：显示开关、字号、版式、logo、二维码，那些照常继承。
 */
export function mergeConfig(brandConfig: any, storeConfig: any): any {
  const out = JSON.parse(JSON.stringify(brandConfig ?? {}));
  for (const path of STORE_OVERRIDABLE_PATHS) del(out, path);
  if (!storeConfig) return out;
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
    /*
      null 要**保留**，它和「没提交这个字段」不是一回事：
      门店把纸张从 58 改回「跟随打印机」时发的就是 null，过滤掉的话
      分店那条里的旧值 58 原地不动，界面上改了却没生效。
      写进去之后 mergeConfig 那边遇到 null 不覆盖 —— 等于没配，正是想要的。
    */
    if (v !== undefined) { set(out, path, v); has = true; }
  }
  return has ? out : null;
}
