import { createHash } from 'node:crypto';
import {
  NOTIFY_BODY_MAX_LENGTH,
  NOTIFY_DEEP_LINK_MAX_LENGTH,
  NOTIFY_TITLE_MAX_LENGTH,
  type NotifyCategory,
  type NotifyPayload,
} from '@cindy/device-link';

/**
 * 手机推送(notify 帧)的纯逻辑:payload 组装 + 短窗去重。
 * 接线(client 持有、订阅注册表防打扰)在 ./index.ts 的 sendMobileSessionNotify;
 * 本文件无 Electron / client 依赖,可直接单测。
 */

export type MobileSessionEventKind = 'done' | 'error' | 'needs-reply';

const CATEGORY_BY_KIND: Record<MobileSessionEventKind, NotifyCategory> = {
  done: 'session-done',
  error: 'session-error',
  'needs-reply': 'session-needs-reply',
};

/** Keep push bodies plain and bounded; no host path or Markdown payload reaches the wire. */
function notificationPreview(value: string, maxLength: number): string {
  const plain = value
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[\*_~`>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(plain).slice(0, maxLength).join('');
}

/**
 * 组装 notify payload。deepLink 用 scheme 无关的应用内路径(手机端点击通知后自行
 * router.push),规避 cn/global 两条构建线 scheme 不同的问题。
 * 正文取 detail(该会话最近一条 assistant 内容 / 定时任务结果摘要)——2026-07 产品
 * 决策:体验优先,推送带实际内容,让用户不打开 App 就能看到结果;detail 缺省时
 * 回退终态短文案。
 */
export function buildSessionNotifyPayload(opts: {
  sessionId: string;
  title: string;
  kind: MobileSessionEventKind;
  selfDeviceId: string;
  /** 由 main host 按发送时的当前 locale 解析；本纯模块不依赖 Electron i18n。 */
  fallbackBody: string;
  /** 内容摘要(可选):折叠空白后按协议上限截断 */
  detail?: string;
  /** 伙伴主任务的 Bot id；未提供时保留普通任务深链。 */
  teammateBotId?: string;
}): NotifyPayload {
  const safeTitle = (opts.title.trim() || opts.sessionId.slice(0, 8)).slice(
    0,
    NOTIFY_TITLE_MAX_LENGTH,
  );
  const detail = opts.detail ? notificationPreview(opts.detail, NOTIFY_BODY_MAX_LENGTH) : '';
  return {
    category: CATEGORY_BY_KIND[opts.kind],
    title: safeTitle,
    body: detail || opts.fallbackBody.slice(0, NOTIFY_BODY_MAX_LENGTH),
    deepLink: sessionDeepLink(opts.sessionId, opts.selfDeviceId, opts.teammateBotId),
    // 同会话的通知在系统层合并(APNs collapse-id / thread-id);混入 srcDeviceId,
    // 多台桌面推同名会话时互不顶替。原样拼接不可行:deviceId 可能是 64 位
    // machineId,拼出 100+ 字符会被 APNs 的 64 字节 collapse-id 上限截断成
    // 设备级合并键(该设备所有会话的通知互相顶替)。取 sha256 前 32 hex:
    // 确定性、每(设备,会话)唯一、稳低于协议与 APNs 双上限。
    collapseId: createHash('sha256')
      .update(`${opts.selfDeviceId}:${opts.sessionId}`)
      .digest('hex')
      .slice(0, 32),
  };
}

/** 手机端分工步骤等待用户操作时复用既有 session-needs-reply 通知类别。 */
export function buildBotGroupNotifyPayload(opts: {
  groupId: string;
  title: string;
  body: string;
  selfDeviceId: string;
}): NotifyPayload {
  const title = (opts.title.trim() || opts.groupId.slice(0, 8)).slice(0, NOTIFY_TITLE_MAX_LENGTH);
  return {
    category: 'session-needs-reply',
    title,
    body: notificationPreview(opts.body, NOTIFY_BODY_MAX_LENGTH),
    deepLink: `/companions/groups/${encodeURIComponent(opts.groupId)}?deviceId=${encodeURIComponent(opts.selfDeviceId)}`
      .slice(0, NOTIFY_DEEP_LINK_MAX_LENGTH),
    collapseId: createHash('sha256')
      .update(`${opts.selfDeviceId}:bot-group:${opts.groupId}`)
      .digest('hex')
      .slice(0, 32),
  };
}

function sessionDeepLink(sessionId: string, deviceId: string, teammateBotId?: string): string {
  const base = `/sessions/${encodeURIComponent(sessionId)}?deviceId=${encodeURIComponent(deviceId)}`;
  if (!teammateBotId) return base;
  const teammate = `${base}&resourceCollectionId=teammates&resourceId=${encodeURIComponent(teammateBotId)}&resourceKind=bot`;
  return teammate.length <= NOTIFY_DEEP_LINK_MAX_LENGTH ? teammate : base;
}

/**
 * 短窗去重:同 session + 同 kind 在窗口内只发一条。覆盖 renderer 事件源的重复触发
 * (如 needs-reply 连续弹多个审批);不同 kind 不互压 —— done 紧跟 error 各有信息量,
 * 系统层还有 collapseId 合并兜底。
 */
export class MobileNotifyDeduper {
  private readonly lastEvent = new Map<string, string>();
  private readonly lastSentAt = new Map<string, number>();
  private readonly lastAnonymousSentAt = new Map<string, number>();

  constructor(private readonly windowMs = 5_000) {}

  shouldSend(sessionId: string, kind: MobileSessionEventKind, now = Date.now(), eventId?: string): boolean {
    const key = `${sessionId}:${kind}`;
    if (eventId) {
      if (this.lastEvent.get(key) === eventId) return false;
      const anonymousAt = this.lastAnonymousSentAt.get(key);
      if (anonymousAt !== undefined) {
        const endedAt = /^turn:\d+:(\d+)(?::signal-\d+)?$/.exec(eventId)?.[1];
        if (endedAt ? Number(endedAt) <= anonymousAt : now - anonymousAt < this.windowMs) {
          this.lastEvent.set(key, eventId);
          return false;
        }
      }
      return true;
    }
    const last = this.lastSentAt.get(key);
    if (last !== undefined && now - last < this.windowMs) return false;
    this.lastSentAt.set(key, now);
    this.sweep(now);
    return true;
  }

  /** 仅在 relay 接受帧后记录带稳定事件身份的通知。 */
  recordSent(sessionId: string, kind: MobileSessionEventKind, now = Date.now(), eventId?: string): void {
    const key = `${sessionId}:${kind}`;
    this.lastSentAt.set(key, now);
    if (eventId) this.lastEvent.set(key, eventId);
    else this.lastAnonymousSentAt.set(key, now);
    this.sweep(now);
  }

  /** 顺路清理过期条目(记录量 = 活跃会话数,轻量,无需独立定时器)。 */
  private sweep(now: number): void {
    for (const [key, at] of this.lastSentAt) {
      if (now - at >= this.windowMs) this.lastSentAt.delete(key);
    }
  }
}
