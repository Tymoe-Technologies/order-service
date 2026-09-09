/**
 * `validateMerchantId` 的跳过白名单和路由注册的对齐检查。
 *
 * ## 这个坑
 * `validateMerchantId` 挂在 app 级别（app.ts），对**所有**请求生效，
 * 靠一份硬编码的 `skipPaths` 正则清单放行「走 JWT 认证的路由」。
 *
 * 白名单漏一条的后果不是「少了个请求头」，而是那条路由**整个 400**，
 * 报 `MISSING_MERCHANT_ID` —— 看起来像客户端漏传请求头，实际上
 * 路由处理函数压根没被执行到。前端那边表现成「后端不在线」。
 *
 * 已经栽过一次：`print-routing` / `print-results` 上线后 POS 的备餐站页面
 * 一直显示后端不在线，而 order-service 在正常运行。
 *
 * ## 所以这里直接比对两份清单
 * 从 `routes/index.ts` 抠出所有 `router.use('/前缀', xxxRoutes)`，
 * 对每个前缀去看它对应的路由文件有没有在**路由级**挂 `authenticate`
 * （`router.use(authenticate)`）。挂了的就必须被 skipPaths 放行。
 *
 * 只查路由级的 `authenticate`：逐个端点挂认证的路由文件（比如 print.routes）
 * 里可能混着服务间调用的公开端点，那种情况白名单反而不该整段放行。
 */

import { test } from 'node:test';
import assert from 'assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const HERE = __dirname;
const index = readFileSync(join(HERE, 'index.ts'), 'utf8');
const middleware = readFileSync(join(HERE, '..', 'middleware', 'validateMerchantId.ts'), 'utf8');

/** `router.use('/print-routing', printRoutingRoutes)` -> ['/print-routing', 'printRoutingRoutes'] */
function mounts(): Array<{ prefix: string; ident: string }> {
  const out: Array<{ prefix: string; ident: string }> = [];
  const re = /router\.use\(\s*'([^']+)'\s*,\s*(\w+)\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(index))) out.push({ prefix: m[1], ident: m[2] });
  return out;
}

/** `import printRoutingRoutes from './print-routing.routes'` -> 'print-routing.routes' */
function importPath(ident: string): string | null {
  const m = new RegExp(`import\\s+${ident}\\s+from\\s+'\\./([\\w.-]+)'`).exec(index);
  return m ? m[1] : null;
}

/** 抠出 skipPaths 里的正则，编译回来用于实际匹配 */
function skipPatterns(): RegExp[] {
  const block = /const skipPaths = \[([\s\S]*?)\n\s*\]/.exec(middleware);
  assert.ok(block, '找不到 skipPaths（正则可能失效了）');
  const out: RegExp[] = [];
  for (const line of block![1].split('\n')) {
    const m = /^\s*(\/(?:\\.|[^/\\])+\/[gimsuy]*)\s*,/.exec(line);
    if (!m) continue;
    // eslint-disable-next-line no-eval
    out.push(eval(m[1]) as RegExp);
  }
  assert.ok(out.length > 5, `skipPaths 只抠到 ${out.length} 条，正则大概失效了`);
  return out;
}

test('每个走 JWT 认证的路由前缀都在 validateMerchantId 的白名单里', () => {
  const patterns = skipPatterns();
  const missing: string[] = [];

  for (const { prefix, ident } of mounts()) {
    // 挂在根上的（'/'）不是一个可判断的前缀，跳过
    if (prefix === '/') continue;
    const file = importPath(ident);
    if (!file) continue;
    const path = join(HERE, `${file}.ts`);
    if (!existsSync(path)) continue;

    const src = readFileSync(path, 'utf8');
    // 只看路由级挂载（router.use(authenticate) / router.use(authMiddleware)）
    if (!/router\.use\(\s*auth(enticate|Middleware)\s*\)/.test(src)) continue;

    if (!patterns.some((p) => p.test(prefix))) missing.push(`${prefix}  (${file}.ts)`);
  }

  assert.deepEqual(
    missing, [],
    '这些路由整段走 JWT 认证，但 validateMerchantId 的 skipPaths 没放行它们：\n'
    + missing.map((x) => '   · ' + x).join('\n')
    + '\n   后果不是「少了个请求头」，而是那条路由**整个 400**（MISSING_MERCHANT_ID），\n'
    + '   路由处理函数压根不会被执行到 —— 前端表现成「后端不在线」。',
  );
});

/*
  上面是源码比对，只能证明「前缀都在名单里」。这两条是拿真正的
  skipPaths 正则去跑一遍实际请求路径 —— 正则写错（比如漏了开头的 ^\/）
  的话名单比对照样是绿的。
*/
test('新加的两条真的能放行对应的请求路径', () => {
  const patterns = skipPatterns();
  const pass = (p: string) => patterns.some((r) => r.test(p));
  for (const p of ['/print-routing', '/print-routing/assignments', '/print-routing/assignments/station%3Aabc', '/print-results']) {
    assert.ok(pass(p), `${p} 应该被放行，但没有任何 skipPaths 匹配它`);
  }
});

test('白名单不会顺手放行不该放行的路径', () => {
  /*
    正则漏了开头的 `^\/` 就会变成子串匹配，把别的路由一起放过去。
    最容易撞的是 `/orders/:id/print`（打印记录上报）—— 一条裸的 `/print/`
    就能把它放行，而它**需要** X-Merchant-Id（POS 的 orderService 确实在发这个头）。
    放行了不会报错，只会让那条路的商家解析被跳过。
  */
  const patterns = skipPatterns();
  const pass = (p: string) => patterns.some((r) => r.test(p));
  for (const p of [
    '/orders',
    '/orders/11111111-1111-4111-8111-111111111111/print',
    '/orders/11111111-1111-4111-8111-111111111111/print-records',
    '/merchants/abc/config',
  ]) {
    assert.ok(!pass(p), `${p} 不该被放行（它需要 X-Merchant-Id），但被 skipPaths 匹配到了`);
  }
});
