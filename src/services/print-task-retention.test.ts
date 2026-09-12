/**
 * 打印任务保留期。
 *
 * 真正的删除要连库，这里钉的是**两条容易改错、改错了没人发现的事**：
 *   1. 两档保留期的相对关系（未结束的必须留得更久）
 *   2. 清理真的被挂上了定时器 —— 写了个 purge 函数但没人调，
 *      是这类「后台任务」最常见的漏（表照样涨，日志里也看不出）
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FINISHED_RETENTION_MS, UNFINISHED_RETENTION_MS } from './print-task-retention'
import { MAX_REPRINT_AGE_MS } from '../websocket/pending-task-selection'

describe('保留期', () => {
  /*
    未结束的（PENDING / SENT）要留得更久：它们本不该积压，
    留着是为了「一直没打出来」这种问题还查得到现场。
    反过来设的话，最该留的证据反而先被删掉。
  */
  test('未结束的比已结束的留得久', () => {
    assert.ok(UNFINISHED_RETENTION_MS > FINISHED_RETENTION_MS)
  })

  /*
    保留期必须远大于补印窗口，否则会出现「任务还能被补印、但记录已经删了」
    的空档 —— 那时候补拉查不到，表现是「有些单莫名其妙不补打」。
  */
  test('两档都远大于补印窗口', () => {
    assert.ok(FINISHED_RETENTION_MS > MAX_REPRINT_AGE_MS * 10)
    assert.ok(UNFINISHED_RETENTION_MS > MAX_REPRINT_AGE_MS * 10)
  })

  test('清理挂上了定时器，不是写完没人调', () => {
    const src = readFileSync(join(__dirname, '..', 'index.ts'), 'utf8')
    assert.match(src, /purgeOldPrintTasks/)
    assert.match(src, /setInterval\(\(\) => \{ void purgeOldPrintTasks\(\)/)
  })
})
