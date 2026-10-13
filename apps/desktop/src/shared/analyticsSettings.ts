/**
 * 使用统计(TapDB)同意闸的跨进程协议类型。
 *
 * 真相在 main(<userData>/analytics-settings.json),renderer 只消费 `allowed`
 * 这个结论,不自行推导「同意 && 开关」。
 */

export interface AnalyticsSettingsPayload {
  /** 用户是否已明示同意《隐私政策》。 */
  privacyConsentAccepted: boolean;
  /** 兼容旧版开关；Lex 固定关闭。 */
  analyticsEnabled: boolean;
  /** 用户是否显式设置过开关(盘上有 override)。false = 跟随当前默认值。 */
  analyticsEnabledCustomized: boolean;
  /**
   * Lex 固定为 false，不允许初始化 TapDB 或继续上报。
   */
  allowed: boolean;
}

export const ANALYTICS_SETTINGS_CHANGE_CHANNEL = 'analytics:settings-change';
