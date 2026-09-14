/**
 * 列表接口也要合并品牌模板。
 *
 * 单条接口（getSettingByType）加了合并，列表（getAllSettings）漏了 ——
 * 后台打印设置页读的正是列表，于是分店进去看到**整页开关全是关的**：
 * 分店那条记录只装覆盖项（pickOverrides 砍过），sections 里只剩
 * footer 和 storeInfo，后台把没有的键一律渲染成「关」。
 *
 * 这里钉的是「两个接口用同一套合并」，免得下次只改一边。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = readFileSync(join(__dirname, 'print-setting.service.ts'), 'utf8')

/** 抠出某个方法体（到下一个 `  async ` 或 `  /**` 为止） */
function methodBody(name: string): string {
  const start = src.indexOf(`async ${name}(`)
  assert.ok(start > 0, `找不到 ${name}`)
  const rest = src.slice(start)
  const end = rest.search(/\n  \/\*\*/)
  return end > 0 ? rest.slice(0, end) : rest
}

describe('品牌模板合并', () => {
  for (const m of ['getAllSettings', 'getSettingByType']) {
    test(`${m} 会解析主店`, () => {
      assert.match(methodBody(m), /resolveMainOrgId/)
    })
    test(`${m} 会合并品牌配置`, () => {
      assert.match(methodBody(m), /mergeConfig\(/)
    })
    /* 品牌那条不存在（老数据）时不能返回空，要退回门店自己那条 */
    test(`${m} 留了「品牌没配过」的退路`, () => {
      assert.match(methodBody(m), /brand/i)
    })
  }

  /* 主店自己那条就是模板，不该再去合并一次（会白查一次库） */
  test('主店走直读，不进合并分支', () => {
    assert.match(methodBody('getAllSettings'), /mainOrgId === tenantId/)
  })
})
