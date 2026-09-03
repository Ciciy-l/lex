import { describe, expect, it } from 'vitest';
import { BRAND_NAME } from '../branding.js';
import {
  BRAND_IDENTITY,
  DEFAULT_CINDY_REGION,
  allDeepLinkSchemes,
  allUserDataDirNames,
  brandAppId,
  brandBundleIdPrefix,
  brandExecutableName,
  brandUserDataDirName,
  legacyBrandUserDataDirNames,
  legacyDialogueUserDataDirNames,
  resolveCindyRegion,
} from '../brandIdentity.js';

/**
 * brand-identity 是标识符层单点,消费方(forge / main 常量 / release 脚本)
 * 对格式有硬约束。这里锁住形状与不变量,防止改名/改值时把非法字符或自相
 * 矛盾的配置带上线——这类错误 typecheck 拦不住,只有到 OS 注册/更新链路
 * 运行时才爆炸。
 */
describe('BRAND_IDENTITY invariants', () => {
  it('displayName 与 branding.ts 的 BRAND_NAME 同源', () => {
    expect(BRAND_IDENTITY.displayName).toBe(BRAND_NAME);
  });

  it('cdnPrefix / dbFilePrefix / updaterName 是安全的小写文件名段', () => {
    // 要进 OSS key(大小写敏感)与文件路径,统一小写规避平台差异。
    const fileSafe = /^[a-z0-9][a-z0-9-]*$/;
    expect(BRAND_IDENTITY.cdnPrefix).toMatch(fileSafe);
    expect(BRAND_IDENTITY.dbFilePrefix).toMatch(fileSafe);
    for (const prefix of BRAND_IDENTITY.legacyDbFilePrefixes) {
      expect(prefix).toMatch(fileSafe);
    }
    expect(BRAND_IDENTITY.updaterName).toMatch(fileSafe);
  });

  it('executableName / userDataDirName 是安全的文件名段(允许首字母大写)', () => {
    // executableName 首字母大写是产品决策(Lex.exe,同 Discord/Slack 惯例):
    // Windows 进程匹配大小写不敏感,mac Mach-O 名对用户不可见;OSS key 等大小写
    // 敏感场景一律走小写的 cdnPrefix,不用本字段。userDataDirName 同理
    // (Electron productName 惯例)。区域值不含空格(owner 决策,双装路径安全)。
    const dirSafe = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
    expect(BRAND_IDENTITY.executableName).toMatch(dirSafe);
    expect(BRAND_IDENTITY.userDataDirName).toMatch(dirSafe);
    for (const region of ['cn', 'global'] as const) {
      expect(BRAND_IDENTITY.executableNameByRegion[region]).toMatch(dirSafe);
      expect(BRAND_IDENTITY.userDataDirNameByRegion[region]).toMatch(dirSafe);
    }
    for (const dir of BRAND_IDENTITY.legacyUserDataDirNames) {
      expect(dir).toMatch(dirSafe);
    }
  });

  it('Lex 正式服务区参数共享一个系统身份与数据目录，dev 保持隔离', () => {
    expect(BRAND_IDENTITY.executableNameByRegion.cn)
      .toBe(BRAND_IDENTITY.executableNameByRegion.global);
    expect(BRAND_IDENTITY.userDataDirNameByRegion.cn)
      .toBe(BRAND_IDENTITY.userDataDirNameByRegion.global);
    expect(BRAND_IDENTITY.appIdByRegion.cn).toBe(BRAND_IDENTITY.appIdByRegion.global);
    expect(BRAND_IDENTITY.appIdByRegion.dev).not.toBe(BRAND_IDENTITY.appIdByRegion.global);
    expect(BRAND_IDENTITY.userDataDirNameByRegion.dev)
      .not.toBe(BRAND_IDENTITY.userDataDirNameByRegion.global);
  });

  it('产品可执行名与正式区域同值；正式 userData 使用已验证的共享目录', () => {
    expect(BRAND_IDENTITY.executableNameByRegion.cn).toBe(BRAND_IDENTITY.executableName);
    expect(BRAND_IDENTITY.userDataDirName).toBe('Lex');
    expect(BRAND_IDENTITY.userDataDirNameByRegion.cn).toBe('LexGlobal');
    expect(BRAND_IDENTITY.userDataDirNameByRegion.global).toBe('LexGlobal');
  });

  it('scheme 符合 RFC 3986(字母开头,字母/数字/+/-/. 组成)且主 scheme 不在 legacy 里', () => {
    const schemeRe = /^[a-z][a-z0-9+.-]*$/;
    expect(BRAND_IDENTITY.primaryScheme).toMatch(schemeRe);
    for (const s of BRAND_IDENTITY.legacySchemes) {
      expect(s).toMatch(schemeRe);
    }
    expect(BRAND_IDENTITY.legacySchemes).not.toContain(BRAND_IDENTITY.primaryScheme);
  });

  it('正式 appId 是单一反向域名，dev 使用独立反向域名', () => {
    const rdnRe = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*)+$/;
    expect(BRAND_IDENTITY.appIdByRegion.cn).toMatch(rdnRe);
    expect(BRAND_IDENTITY.appIdByRegion.global).toMatch(rdnRe);
    expect(BRAND_IDENTITY.appIdByRegion.dev).toMatch(rdnRe);
    expect(BRAND_IDENTITY.appIdByRegion.cn).toBe(BRAND_IDENTITY.appIdByRegion.global);
    expect(BRAND_IDENTITY.appIdByRegion.dev).not.toBe(BRAND_IDENTITY.appIdByRegion.global);
  });

  it('legacy userData / DB 前缀不含当前值(历史表只放旧值)', () => {
    expect(BRAND_IDENTITY.legacyUserDataDirNames).not.toContain(
      BRAND_IDENTITY.userDataDirName,
    );
    expect(BRAND_IDENTITY.legacyDbFilePrefixes).not.toContain(
      BRAND_IDENTITY.dbFilePrefix,
    );
  });

  it('身份翻转后 legacy 数组必须携带 xdt-maker 旧值(兼容锚,只增不减)', () => {
    expect(BRAND_IDENTITY.legacySchemes).toContain('xdt-maker');
    expect(BRAND_IDENTITY.legacyUserDataDirNames).toContain('xdt-maker');
    expect(BRAND_IDENTITY.legacyDbFilePrefixes).toContain('xdt-maker');
  });

  it('档案与内嵌数组已冻结,消费方无法运行时篡改', () => {
    expect(Object.isFrozen(BRAND_IDENTITY)).toBe(true);
    expect(Object.isFrozen(BRAND_IDENTITY.appIdByRegion)).toBe(true);
    expect(Object.isFrozen(BRAND_IDENTITY.executableNameByRegion)).toBe(true);
    expect(Object.isFrozen(BRAND_IDENTITY.userDataDirNameByRegion)).toBe(true);
    expect(Object.isFrozen(BRAND_IDENTITY.legacyUserDataDirNamesByRegion)).toBe(true);
    for (const names of Object.values(BRAND_IDENTITY.legacyUserDataDirNamesByRegion)) {
      expect(Object.isFrozen(names)).toBe(true);
    }
    expect(Object.isFrozen(BRAND_IDENTITY.legacyDialogueUserDataDirNamesByRegion)).toBe(true);
    for (const names of Object.values(BRAND_IDENTITY.legacyDialogueUserDataDirNamesByRegion)) {
      expect(Object.isFrozen(names)).toBe(true);
    }
    expect(Object.isFrozen(BRAND_IDENTITY.legacySchemes)).toBe(true);
    expect(Object.isFrozen(BRAND_IDENTITY.legacyUserDataDirNames)).toBe(true);
    expect(Object.isFrozen(BRAND_IDENTITY.legacyDbFilePrefixes)).toBe(true);
  });
});

describe('区域解析与派生', () => {
  it('resolveCindyRegion:空值 → 默认 global;合法值归一化;非法值抛错', () => {
    expect(resolveCindyRegion(undefined)).toBe('global');
    expect(resolveCindyRegion(null)).toBe('global');
    expect(resolveCindyRegion('')).toBe('global');
    expect(resolveCindyRegion('  ')).toBe('global');
    expect(resolveCindyRegion('cn')).toBe('cn');
    expect(resolveCindyRegion('global')).toBe('global');
    expect(resolveCindyRegion('GLOBAL')).toBe('global');
    expect(() => resolveCindyRegion('us')).toThrow(/Invalid Cindy region/);
  });

  it('brandAppId / brandBundleIdPrefix 按区域取值,默认 global', () => {
    expect(DEFAULT_CINDY_REGION).toBe('global');
    expect(brandAppId()).toBe('com.ciciy.lex');
    expect(brandAppId('global')).toBe('com.ciciy.lex');
    expect(brandBundleIdPrefix('cn')).toBe('com.ciciy.lex');
    expect(brandBundleIdPrefix('global')).toBe('com.ciciy.lex');
  });

  it('brandExecutableName / brandUserDataDirName 按区域取值,默认 global', () => {
    expect(brandExecutableName()).toBe('Lex');
    // global 与 cn 同值(2026-07-26 显示名统一决策);dev 仍独立。
    expect(brandExecutableName('global')).toBe('Lex');
    expect(brandExecutableName('dev')).toBe('LexDev');
    expect(brandUserDataDirName()).toBe('LexGlobal');
    expect(brandUserDataDirName('global')).toBe('LexGlobal');
    expect(brandUserDataDirName('cn')).toBe('LexGlobal');
  });
});

describe('派生 helper', () => {
  it('allDeepLinkSchemes 主 scheme 恒为首位且包含全部 legacy', () => {
    expect(allDeepLinkSchemes()).toEqual(['cindy', 'xdt-maker']);
  });

  it('allUserDataDirNames 本区域目录名恒为首位 + 全部历史值,且不含另一区域', () => {
    expect(allUserDataDirNames()).toEqual(['LexGlobal']);
    expect(allUserDataDirNames('cn')).toEqual(['LexGlobal', 'xdt-maker']);
    // Lex 正式身份两区相同；CN 仍保留旧 xdt-maker 迁移来源。
    expect(allUserDataDirNames('global')).toEqual(['LexGlobal']);
  });

  it('legacyBrandUserDataDirNames 只返回品牌翻转前的共享 mToc 来源', () => {
    expect(legacyBrandUserDataDirNames()).toEqual(['xdt-maker']);
  });

  it('dialogue cwd 迁移来源按区域保留旧品牌目录', () => {
    expect(legacyDialogueUserDataDirNames()).toEqual([]);
    expect(legacyDialogueUserDataDirNames('cn')).toEqual(['xdt-maker']);
    expect(legacyDialogueUserDataDirNames('global')).toEqual([]);
    expect(legacyDialogueUserDataDirNames('dev')).toEqual([]);
  });

  it('helper 接受显式档案参数(历史身份回放用)', () => {
    const legacyLike = {
      ...BRAND_IDENTITY,
      primaryScheme: 'xdt-maker',
      legacySchemes: [],
      userDataDirNameByRegion: { cn: 'xdt-maker', global: 'xdt-maker', dev: 'xdt-maker-dev' },
      legacyUserDataDirNames: [],
      legacyUserDataDirNamesByRegion: { cn: [], global: [], dev: [] },
      legacyDialogueUserDataDirNamesByRegion: { cn: [], global: [], dev: [] },
      dbFilePrefix: 'xdt-maker',
      legacyDbFilePrefixes: [],
    };
    expect(allDeepLinkSchemes(legacyLike)).toEqual(['xdt-maker']);
    expect(allUserDataDirNames('cn', legacyLike)).toEqual(['xdt-maker']);
  });
});
