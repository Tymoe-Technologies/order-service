/**
 * 票据设置的品牌 / 门店分层。
 *
 * 这里错了不会报错，只会**悄悄失效**：
 *   · 过滤漏了 → 分店一保存就把品牌那套样式抄成自己的覆盖项，分层等于没有
 *   · 合并错了 → 分店没配过的项变成空（页脚变空白、纸宽变 undefined）
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mergeConfig, pickOverrides, STORE_OVERRIDABLE_PATHS } from './print-setting-scope'

const brand = () => ({
  paperWidth: 80,
  language: 'en',
  sections: {
    storeInfo: { showLogo: true, logoUrl: 'https://brand/logo.png', name: '总店', address: '1 Main St', phone: '111' },
    items: { showSku: false, fontSize: 'medium' },
    footer: { showQrCode: true, qrCodeUrl: 'https://brand/qr', customMessage: '谢谢惠顾', showOrderNotes: true },
  },
})

describe('mergeConfig', () => {
  /*
    门店级字段不继承：主店那条记录同时是品牌模板和主店自己的门店设置，
    继承它等于「主店店长改自己店的语言，全品牌跟着变」。
  */
  test('分店没配过 → 拿到品牌的样式，但门店级字段是空的', () => {
    const out = mergeConfig(brand(), null)
    // 样式照常继承
    assert.equal(out.sections.storeInfo.logoUrl, 'https://brand/logo.png')
    assert.equal(out.sections.items.fontSize, 'medium')
    assert.equal(out.sections.footer.showQrCode, true)
    // 门店级的不继承 —— 主店的语言/页脚不该跑到分店单据上
    assert.equal(out.language, undefined)
    assert.equal(out.paperWidth, undefined)
    assert.equal(out.sections.footer.customMessage, undefined)
    assert.equal(out.sections.storeInfo.name, undefined)
  })

  test('主店改自己的语言，不影响没配过的分店', () => {
    const b = brand()
    b.language = 'zh-CN'                       // 主店店长把自己店改成中文
    assert.equal(mergeConfig(b, null).language, undefined)
    assert.equal(mergeConfig(b, { language: 'fr' }).language, 'fr')
  })

  test('只覆盖分店真正配了的项，样式仍跟品牌', () => {
    const out = mergeConfig(brand(), { language: 'zh-CN', sections: { footer: { customMessage: '本店周三会员日' } } })
    assert.equal(out.language, 'zh-CN')
    assert.equal(out.sections.footer.customMessage, '本店周三会员日')
    // 同一个 footer 里**品牌管的**那些不能丢
    assert.equal(out.sections.footer.showQrCode, true)
    // 品牌资产纹丝不动
    assert.equal(out.sections.storeInfo.logoUrl, 'https://brand/logo.png')
    assert.equal(out.sections.items.fontSize, 'medium')
  })

  /* 分店那条里字段不存在 ≠ 要清空。不然分店没写页脚就变成空白小票 */
  /* 分店那条里字段不存在 ≠ 要清空品牌管的项 */
  test('undefined 不覆盖品牌的样式', () => {
    const out = mergeConfig(brand(), { language: undefined, sections: { footer: {} } })
    assert.equal(out.sections.footer.showQrCode, true)
    assert.equal(out.sections.items.fontSize, 'medium')
  })

  /*
    主店改自己的设置**不会动分店已经配好的覆盖**：两边是两条独立记录
    （不同 tenantId），主店的写入只落在主店那条上，分店的覆盖永远盖在最后。
    品牌管的那部分跟着变 —— 那正是品牌级的意义。
  */
  test('主店改动不覆盖分店已配好的那几项', () => {
    const store = { language: 'fr', sections: { footer: { customMessage: 'Merci' } } }
    const before = mergeConfig(brand(), store)

    const changed = brand()
    changed.language = 'zh-CN'                              // 主店改自己店的语言
    changed.sections.footer.customMessage = '总店新文案'      // 主店改自己店的页脚
    changed.sections.footer.showQrCode = false              // 品牌把二维码关了（样式）
    const after = mergeConfig(changed, store)

    // 分店自己配的两项纹丝不动
    assert.equal(after.language, 'fr')
    assert.equal(after.sections.footer.customMessage, 'Merci')
    // 品牌管的那项跟着变了 —— 这是想要的
    assert.equal(before.sections.footer.showQrCode, true)
    assert.equal(after.sections.footer.showQrCode, false)
  })

  test('不改坏品牌那份对象（合并要深拷贝）', () => {
    const b = brand()
    mergeConfig(b, { sections: { footer: { customMessage: 'X' } } })
    assert.equal(b.sections.footer.customMessage, '谢谢惠顾')
  })
})

describe('pickOverrides', () => {
  /*
    后台 UI 现在发的是整份 config。不过滤的话分店保存一次，
    品牌的 logo、字号、显示开关全被抄进分店那条，品牌再改就推不动了。
  */
  test('整份 config 进来，只留分店有权改的那几项', () => {
    const picked = pickOverrides(brand())
    assert.equal(picked.language, 'en')
    assert.equal(picked.paperWidth, 80)
    assert.equal(picked.sections.footer.customMessage, '谢谢惠顾')
    assert.equal(picked.sections.storeInfo.name, '总店')
    // 品牌的东西一个都不能留下
    assert.equal(picked.sections.storeInfo.logoUrl, undefined)
    assert.equal(picked.sections.storeInfo.showLogo, undefined)
    assert.equal(picked.sections.items, undefined)
    assert.equal(picked.sections.footer.showQrCode, undefined)
  })

  test('一项可覆盖的都没有 → null（不写空记录）', () => {
    assert.equal(pickOverrides({ sections: { items: { fontSize: 'large' } } }), null)
    assert.equal(pickOverrides(null), null)
  })

  /* 挑出来的东西必须能原样合并回去 —— 两个函数用的是同一份路径表 */
  test('挑出来再合并 = 原值（往返一致）', () => {
    const b = brand()
    const store = { language: 'fr', sections: { footer: { customMessage: 'Merci' } } }
    const out = mergeConfig(b, pickOverrides(store))
    assert.equal(out.language, 'fr')
    assert.equal(out.sections.footer.customMessage, 'Merci')
  })

  test('路径表里没有 logoUrl / 显示开关这类品牌资产', () => {
    const paths = STORE_OVERRIDABLE_PATHS as readonly string[]
    for (const forbidden of ['sections.storeInfo.logoUrl', 'sections.storeInfo.showLogo', 'sections.items.fontSize']) {
      assert.ok(!paths.includes(forbidden), `${forbidden} 不该让分店改`)
    }
  })
})
