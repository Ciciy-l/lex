/**
 * i18nBrandPlaceholder.test.ts —— {{appName}} 品牌插值的运行时断言。
 *
 * 品牌展示名收敛分两层校验:
 *  - 静态层:locale JSON 不得硬编码品牌名 → scripts/brand-terminology-guard.mjs
 *    (PR #767 建立的品牌治理 CI 入口,错拼检查与 locale 占位符检查同脚本);
 *  - 运行时层(本文件):i18next 的 interpolation.defaultVariables 真的把
 *    {{appName}} 注入为 BRAND_NAME——静态扫描保证"写了占位符",这里保证
 *    "占位符渲染得出来"(defaultVariables 配置被误删时静态扫描不会红)。
 */
import { describe, it, expect } from 'vitest';

import { BRAND_NAME } from '@cindy/maker-shared/branding';
import { i18n } from '../i18n';

describe('locale 品牌名插值', () => {
  it.each(['en', 'zh-CN', 'zh-TW', 'ja', 'ko'])('%s keeps new upstream host copy separate from Cindy services', (lng) => {
    for (const key of [
      'ipcError.MODEL_CONTEXT_USAGE_UNKNOWN',
      'settings.remote.add.displayNamePlaceholder',
      'settings.auxiliaryModels.customHint',
      'settings.shortcuts.workLouderCodex.models.creatorMicro2.connection.descriptions.connecting',
      'chatgptAuthRecovery.reloginRiskTitle',
    ]) {
      const rendered = i18n.t(key, { lng });
      expect(rendered).not.toBe(key);
      expect(rendered).not.toContain('Cindy');
      expect(rendered).not.toContain('{{appName}}');
      if (lng === 'en') expect(rendered).toContain(BRAND_NAME);
    }
    for (const key of [
      'settings.auxiliaryModels.signInHint',
      'onboarding.homeZeroModel.title',
      'onboarding.homeZeroModel.desc',
      'onboarding.homeZeroModel.cta',
      'onboarding.homeZeroModel.cloudTitle',
    ]) {
      expect(i18n.t(key, { lng })).toContain('Cindy');
    }
  });

  it('{{appName}} 由 defaultVariables 注入为 BRAND_NAME(端到端)', () => {
    // update.moveToApplications.message 是含 {{appName}} 的真实 key(main 迷你 i18n 也消费它)。
    const rendered = i18n.t('update.moveToApplications.message');
    expect(rendered).toContain(BRAND_NAME);
    expect(rendered).not.toContain('{{appName}}');
  });
});
