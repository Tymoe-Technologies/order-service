/**
 * 订单手机号规范化。
 *
 * 两件事都要验：**能解析的统一成 E.164**，和**解析不了的原样保留**。
 * 只验前者的话，写成"解析失败返回 null"也能过 —— 那会把顾客的联系方式弄丢，
 * 而且是静默的。订单上的手机号是配送和退款联系人，丢了比格式怪严重得多。
 */
import { toE164 } from '../src/utils/phone';

const rows: Array<[string, boolean, string]> = [];
const T = (n: string, ok: boolean, note = '') => rows.push([n, ok, note]);

// ── 各种输入都收敛到同一个 E.164 ──
const same = ['6725529511', '672-552-9511', '(672) 552 9511', '+1 672 552 9511', '+16725529511'];
const out = same.map(s => toE164(s));
T('★ 同一个号的各种写法都收敛成同一个 E.164（POS 传的那种没有国家码的也是）',
  out.every(v => v === '+16725529511'),
  same.map((s, i) => `${s}→${out[i]}`).join('  '));

// ── 其他国家 ──
T('  带国家码的国际号照常（不是只会 +1）',
  toE164('+8613800138000') === '+8613800138000', String(toE164('+8613800138000')));

// ── ★ 解析不了不能丢 ──
const junk = toE164('分机 8801');
T('★ 解析不出来时**原样保留**，不返回 null（订单上的号是配送/退款联系人，丢了更严重）',
  junk === '分机 8801', JSON.stringify(junk));

const tooShort = toE164('123');
T('  明显不合法的也保留原值，不静默丢弃', tooShort === '123', JSON.stringify(tooShort));

// ── 空值仍是空 ──
T('  空输入返回 null（本来就没有，不是丢了）',
  toE164('') === null && toE164(null) === null && toE164(undefined) === null, '');

let fail = 0;
for (const [n, ok, note] of rows) { if (!ok) fail++; console.log(`  ${ok ? '✓' : '✗'} ${n.padEnd(58)} ${note}`); }
console.log(`\n  ${fail === 0 ? '✅' : '❌'} ${rows.length - fail}/${rows.length} 通过`);
process.exit(fail === 0 ? 0 : 1);
