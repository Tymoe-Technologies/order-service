/**
 * 品牌模板 + 门店覆盖的合并边界。
 *
 * 守的是「分店存了什么都不该动到品牌样式」—— 库里三家分店的收据 config
 * 现在就躺着 `showLogo:false, logoUrl:''`（分店登录时查不到品牌 profile，
 * 保存时写进去的）。白名单要是漏了一格，这三家的小票当场没 logo，
 * 而且只有打出来才看得见。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mergeConfig, pickOverrides } from './print-setting-scope';

// 形状照着库里真实记录写：主店 MIXUE 有 logo，分店那条是空 logo + 自己的店名
const brand = {
  language: 'zh-CN',
  paperWidth: 80,
  sections: {
    storeInfo: { showLogo: true, logoUrl: 'https://x/main-logo.png', name: 'MIXUE', phone: '604-000-0000' },
    footer: { showQrCode: true, customMessage: '谢谢惠顾' },
  },
};
const branch = {
  language: 'en',
  paperWidth: 58,
  sections: {
    storeInfo: { showLogo: false, logoUrl: '', name: 'MIXUE Surrey', phone: '604-111-1111' },
    footer: { showQrCode: false, customMessage: 'Surrey 会员日 8 折' },
  },
};

describe('票据配置的品牌/门店分层', () => {
  it('分店的空 logo 盖不掉主店的', () => {
    const si = mergeConfig(brand, branch).sections.storeInfo;
    assert.equal(si.logoUrl, 'https://x/main-logo.png');
    assert.equal(si.showLogo, true);
  });

  it('样式类的开关一律跟品牌', () => {
    assert.equal(mergeConfig(brand, branch).sections.footer.showQrCode, true);
    assert.equal(mergeConfig(brand, branch).paperWidth, 80);
  });

  it('语言、页脚文案、店铺信息跟分店', () => {
    const m = mergeConfig(brand, branch);
    assert.equal(m.language, 'en');
    assert.equal(m.sections.footer.customMessage, 'Surrey 会员日 8 折');
    assert.equal(m.sections.storeInfo.name, 'MIXUE Surrey');
    assert.equal(m.sections.storeInfo.phone, '604-111-1111');
  });

  it('分店没配语言时不继承主店的 —— 主店改自己那家店不该波及全品牌', () => {
    const m = mergeConfig(brand, { sections: {} });
    assert.equal(m.language, undefined);
  });

  it('pickOverrides 只放行白名单，且保留显式 null（= 清除覆盖）', () => {
    const o = pickOverrides({ ...branch, language: null });
    assert.equal(o.language, null);
    assert.equal(o.sections.storeInfo.name, 'MIXUE Surrey');
    assert.equal(o.sections.storeInfo.logoUrl, undefined);
    assert.equal(o.paperWidth, undefined);
  });
});
