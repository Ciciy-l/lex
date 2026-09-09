import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PLATFORMS = [
  "win32-x64",
  "darwin-arm64",
  "darwin-x64",
  "linux-x64",
];
export const LOCALES = ["zh-CN", "zh-TW", "en", "ja", "ko"];
const VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;
const nonblank = (value) =>
  typeof value === "string" && value.trim().length > 0;
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function validateNotice(notice, version) {
  if (!VERSION.test(version) || !object(notice) || notice.version !== version) {
    throw new Error("Lex notice version must match the release tag");
  }
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(notice.date ?? "") ||
    !Number.isFinite(Date.parse(notice.date)) ||
    new Date(notice.date).toISOString().slice(0, 10) !== notice.date
  ) {
    throw new Error("Lex notice requires a valid YYYY-MM-DD date");
  }
  if (!object(notice.contentByLocale))
    throw new Error("Lex notice requires localized content");
  for (const locale of LOCALES) {
    const content = notice.contentByLocale[locale];
    if (
      !object(content) ||
      !nonblank(content.intro) ||
      !content.intro.includes("Lex") ||
      !Array.isArray(content.topics) ||
      content.topics.length === 0 ||
      content.topics.some(
        (topic) =>
          !object(topic) ||
          !nonblank(topic.title) ||
          !nonblank(topic.text) ||
          (topic.id !== undefined && !nonblank(topic.id)) ||
          (topic.emoji !== undefined && typeof topic.emoji !== "string") ||
          (topic.contributors !== undefined &&
            (!Array.isArray(topic.contributors) ||
              !topic.contributors.every(nonblank))),
      )
    ) {
      throw new Error(
        `Lex notice requires renderable Lex topics for ${locale}`,
      );
    }
  }
  if (
    notice.contributors !== undefined &&
    (!Array.isArray(notice.contributors) ||
      !notice.contributors.every(nonblank))
  ) {
    throw new Error("Invalid Lex notice contributors");
  }
  return notice;
}

export function publishNotices(notice, destination) {
  validateNotice(notice, notice.version);
  const outputs = PLATFORMS.map((platform) => {
    const directory = path.join(destination, "notice", platform);
    const indexPath = path.join(directory, "index.json");
    const existing = fs.existsSync(indexPath)
      ? JSON.parse(fs.readFileSync(indexPath, "utf8"))
      : [];
    if (
      !Array.isArray(existing) ||
      !existing.every(
        (version) => typeof version === "string" && VERSION.test(version),
      )
    ) {
      throw new Error(`Invalid notice index for ${platform}`);
    }
    const index = [...new Set([...existing, notice.version])].sort(
      compareVersions,
    );
    return { directory, indexPath, index };
  });
  for (const { directory, indexPath, index } of outputs) {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, `${notice.version}.json`),
      JSON.stringify(notice, null, 2) + "\n",
    );
    fs.writeFileSync(indexPath, JSON.stringify(index, null, 2) + "\n");
  }
}

export function compareVersions(left, right) {
  const [leftCore, leftPre] = left.split(/-(.*)/s);
  const [rightCore, rightPre] = right.split(/-(.*)/s);
  const leftParts = leftCore.split(".").map(Number);
  const rightParts = rightCore.split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    if (leftParts[index] !== rightParts[index])
      return leftParts[index] - rightParts[index];
  }
  if (leftPre === rightPre) return 0;
  if (leftPre === undefined) return 1;
  if (rightPre === undefined) return -1;
  const leftIds = leftPre.split(".");
  const rightIds = rightPre.split(".");
  for (
    let index = 0;
    index < Math.max(leftIds.length, rightIds.length);
    index++
  ) {
    const first = leftIds[index];
    const second = rightIds[index];
    if (first === undefined) return -1;
    if (second === undefined) return 1;
    if (first === second) continue;
    const firstNumeric = /^\d+$/.test(first);
    const secondNumeric = /^\d+$/.test(second);
    if (firstNumeric && secondNumeric) return Number(first) - Number(second);
    if (firstNumeric !== secondNumeric) return firstNumeric ? -1 : 1;
    return first < second ? -1 : 1;
  }
  return 0;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const version = (process.argv[2] ?? "").replace(/^v/, "");
  if (!VERSION.test(version)) throw new Error("Invalid release version");
  const notice = validateNotice(
    JSON.parse(
      fs.readFileSync(
        new URL(`../release-notices/${version}.json`, import.meta.url),
        "utf8",
      ),
    ),
    version,
  );
  if (process.argv[3]) publishNotices(notice, process.argv[3]);
}
