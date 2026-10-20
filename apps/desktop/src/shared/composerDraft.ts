/** Durable composer content. No routing, focus, or pending capability intents. */
import type { JSONContent } from '@tiptap/core';
import type { BrowserCommentStyleChange, BrowserCommentTargetInfo } from './browserComment';
import type { DataOwnerPushStamp } from './dataOwnerPush';

export type FileCategory = 'image' | 'pdf' | 'text' | 'office' | 'file';

export interface AttachedFile {
  id: string;
  name: string;
  path: string;
  ext: string;
  size: number;
  category: FileCategory;
  mimeType: string;
  /**
   * image-local-cache: xdt-image:// url to the cached file. The primary
   * source for image rendering and SDK send. Undefined only when the
   * cache write failed and we fell back to in-memory base64 (F6).
   */
  url?: string;
  /**
   * image-local-cache: original filename (used by the missing-image
   * placeholder UI and as `originalName` in persisted ImageRef).
   */
  originalName?: string;
  /**
   * image: present only as F6 fallback after a failed cache write.
   *
   * @deprecated for file attachments: as of attachment-path-passthrough, new
   * attachments no longer carry base64 — only the path is forwarded to the
   * model. Field kept optional so historical messages loaded from the
   * server still type-check on render/resend paths.
   */
  base64?: string;
  /**
   * @deprecated as of attachment-path-passthrough: new text attachments no
   * longer carry inline content — 新消息走 composePromptText 路径透传
   * (buildContentBlocks 把路径追加到末尾 text block,由 Agent 主动用 Read
   * 工具按需读取)。Kept optional for backward-compat with historical
   * messages persisted in older format.
   */
  textContent?: string;
  /**
   * @deprecated companion to {@link textContent}. 同上,新消息走
   * composePromptText 路径透传,此字段仅为兼容历史消息保留。
   */
  truncated?: boolean;
  /**
   * 图片带用户手绘标注(lightbox 标注模式烧录产物)。发送时随 wire 契约透传,
   * buildMakerUserMessage 据此给模型注入"红色笔迹是用户标注"的固定说明。
   */
  annotated?: boolean;
  /**
   * 非破坏性标注:未烧录**原图**的 xdt-image:// 缓存 url。`annotated` 为真时
   * 存在;托盘预览用它(而非烧录位图)+ `annotationStrokes` 矢量叠加显示,
   * 使标注可继续编辑 / 撤销。仅编辑期数据,不进 SerializedAttachedFile。
   */
  annotationSourceUrl?: string;
  /** 非破坏性标注:归一化笔迹(0..1 相对原图自然尺寸)。托盘期唯一事实源;
   *  发送时据此烧录位图,烧录前的原图 url 记入 annotationSourceUrl。 */
  annotationStrokes?: ImageAnnotationStroke[];
  /**
   * url 指向的缓存文件是**共享引用**(如历史消息的原图),不归本附件所有:
   * 删除附件时不清理该文件。缺省(false)为附件私有,删除时照常清理。
   */
  cacheUrlShared?: boolean;
  /**
   * @deprecated image-local-cache removed blob-URL thumbnails. Setting this
   * is now a compile error so any leftover code path surfaces immediately.
   */
  thumbnailUrl?: never;
}

/**
 * 图片标注的一条手绘笔迹(归一化坐标)。定义放在附件类型域,组件层
 * (lightboxAnnotations)以别名复用,避免 lib → components 的反向依赖。
 */
export interface ImageAnnotationStroke {
  points: Array<{ x: number; y: number }>;
}

/** 草稿里的一条页面评论(提交后、发送前的中间态)。 */
export interface BrowserCommentDraftItem {
  /** 稳定 id(逐条删除用)。 */
  id: string;
  /** marker 编号(1 起,与页面上的蓝色圆点、截图文件名一致)。 */
  markerNumber: number;
  /** 评论时刻的页面 URL(不可信页面证据)。 */
  pageUrl: string;
  /** guest 采集的目标信息(kind / 坐标 / selector / 选区文本等)。 */
  target: BrowserCommentTargetInfo;
  /** 用户评论文字;「立即添加」时为空串。 */
  comment: string;
  /**
   * 带 marker 的页面截图,已缓存为会话私有 xdt-image://,形态即 AttachedFile
   * —— 发送时直接并入 filesToSend,无需再转换。
   */
  screenshot: AttachedFile;
  /**
   * 样式反馈(Phase 3 styling feedback):气泡样式编辑器里改过的属性
   * (old → new,已在页面上实时预览过,截图即预览后效果)。非空时该评论
   * 序列化为 `## Requested annotation N` 块。
   */
  styleChanges?: BrowserCommentStyleChange[];
}

export interface ComposerDraftContent {
  text: JSONContent | null;
  attachments: AttachedFile[];
  browserComments?: BrowserCommentDraftItem[];
}

export interface ComposerDraftEntry {
  key: string;
  content: ComposerDraftContent;
}

export interface ComposerDraftSnapshot extends DataOwnerPushStamp {
  entries: ComposerDraftEntry[];
}

export interface ComposerDraftWrite extends DataOwnerPushStamp {
  key: string;
  content: ComposerDraftContent | null;
}

export const COMPOSER_DRAFT_LOAD = 'composer-drafts:load-sync';
export const COMPOSER_DRAFT_SAVE = 'composer-drafts:save';
