import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";
import { androidVersionCode } from "../shared/lex-mobile-config.cjs";
import {
  compareVersions,
  LOCALES,
  PLATFORMS,
  publishNotices,
  validateNotice,
} from "../lex-release-notices.mjs";

function notice(version = "1.2.3-rc.2") {
  return {
    version,
    date: "2026-09-09",
    contentByLocale: Object.fromEntries(
      LOCALES.map((locale) => [
        locale,
        {
          intro: "Lex version information",
          topics: [
            {
              title: "Login isolation",
              text: "Lex uses its own device session.",
            },
          ],
        },
      ]),
    ),
  };
}

test("validates all supported locales, versions, dates, and renderable topics", () => {
  assert.equal(validateNotice(notice(), "1.2.3-rc.2").version, "1.2.3-rc.2");
  assert.throws(() => validateNotice(notice(), "1.2.4"));
  for (const mutate of [
    (value) => {
      value.date = "2026-02-30";
    },
    (value) => {
      delete value.contentByLocale.ko;
    },
    (value) => {
      value.contentByLocale.en.topics[0].text = " ";
    },
    (value) => {
      value.contentByLocale.en.intro = "Cindy release";
    },
    (value) => {
      value.contentByLocale.en.topics[0].contributors = [null];
    },
    (value) => {
      value.version = "../unsafe";
    },
  ]) {
    const value = notice();
    mutate(value);
    assert.throws(() => validateNotice(value, value.version));
  }
});

test("publishes notices and sorted, deduplicated indexes for every desktop platform", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lex-notices-"));
  try {
    publishNotices(notice("1.2.3"), directory);
    publishNotices(notice("1.2.3-rc.10"), directory);
    publishNotices(notice(), directory);
    publishNotices(notice(), directory);
    for (const platform of PLATFORMS) {
      const base = path.join(directory, "notice", platform);
      assert.deepEqual(
        JSON.parse(fs.readFileSync(path.join(base, "index.json"))),
        ["1.2.3-rc.2", "1.2.3-rc.10", "1.2.3"],
      );
      assert.deepEqual(
        JSON.parse(fs.readFileSync(path.join(base, "1.2.3-rc.2.json"))),
        notice(),
      );
    }
    fs.writeFileSync(
      path.join(directory, "notice", "linux-x64", "index.json"),
      "{}",
    );
    assert.throws(() => publishNotices(notice("1.2.4"), directory));
    assert.equal(
      fs.existsSync(path.join(directory, "notice", "win32-x64", "1.2.4.json")),
      false,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("orders release and prerelease versions without platform or lexical drift", () => {
  assert.ok(compareVersions("1.2.3-rc.2", "1.2.3-rc.10") < 0);
  assert.ok(compareVersions("1.2.3", "1.2.3-rc.10") > 0);
  assert.ok(compareVersions("1.2.3", "1.10.0") < 0);
});

test("release workflows validate tagged structured notices before publishing anything", () => {
  const updates = YAML.parse(
    fs.readFileSync(
      new URL("../../.github/workflows/lex-updates.yml", import.meta.url),
      "utf8",
    ),
  );
  const steps = updates.jobs.publish.steps;
  const validation = steps.findIndex(
    (step) => step.name === "Validate tagged Lex version notices",
  );
  const publication = steps.findIndex(
    (step) => step.name === "Publish manifests to the Lex updates branch",
  );
  assert.ok(validation >= 0 && validation < publication);
  assert.equal(
    steps[0].with.ref,
    "${{ github.event.release.tag_name || inputs.tag }}",
  );
  assert.match(
    steps[validation].run,
    /node scripts\/lex-release-notices\.mjs "\$RELEASE_TAG"/,
  );
  const publish = steps[publication].run;
  assert.ok(
    publish.indexOf("node scripts/lex-release-notices.mjs") <
      publish.indexOf('git -C "$worktree/repo" add .'),
  );
  assert.ok(
    publish.indexOf('git -C "$worktree/repo" add .') <
      publish.indexOf("push origin HEAD:updates"),
  );
  assert.match(publish, /set -euo pipefail/);
  const release = YAML.parse(
    fs.readFileSync(
      new URL("../../.github/workflows/desktop-release.yml", import.meta.url),
      "utf8",
    ),
  );
  assert.ok(
    release.jobs["resolve-release"].steps.some(
      (step) =>
        step.run === 'node scripts/lex-release-notices.mjs "$RELEASE_VERSION"',
    ),
  );
  const notesGate = release.jobs["resolve-release"].steps.find(
    (step) => step.name === "Require Lex release notes",
  );
  assert.ok(notesGate);
  assert.ok(notesGate.run.includes('[ ! -s "release-notices/${RELEASE_VERSION}.md" ]'));
  const draftSteps = release.jobs.publish.steps;
  const checkout = draftSteps.find((step) => step.uses?.startsWith("actions/checkout@"));
  assert.equal(checkout.with.ref, "${{ needs.resolve-release.outputs.release_commit }}");
  assert.equal(checkout.with["persist-credentials"], false);
  const draft = draftSteps.find((step) => step.name === "Create or update draft release").run;
  assert.ok(draft.includes('cp "release-notices/${VERSION}.md" "$notes_file"'));
  assert.ok(draft.includes('--notes-file "$notes_file"'));
  assert.ok(draft.includes('--draft --title "Lex ${tag}"'));
  assert.ok(draft.includes('if [[ "$VERSION" == *-* ]]; then'));
  assert.ok(draft.includes('release_flags+=(--prerelease)'));
  assert.ok(draft.includes('桌面构建：**%s**。%s'));
  assert.ok(draft.includes("signing_label='已签名'"));
  assert.ok(draft.includes("signing_label='未使用发行证书签名'"));
  assert.ok(!draft.includes('Build and signing /'));
});

test("0.1.5-rc.1 has concise Chinese release notes and complete localized app notices", () => {
  const rc = JSON.parse(fs.readFileSync(
    new URL("../../release-notices/0.1.5-rc.1.json", import.meta.url), "utf8",
  ));
  const body = fs.readFileSync(
    new URL("../../release-notices/0.1.5-rc.1.md", import.meta.url), "utf8",
  );
  validateNotice(rc, "0.1.5-rc.1");
  assert.ok(compareVersions(rc.version, "0.1.4") > 0);
  assert.ok(compareVersions(rc.version, "0.1.5") < 0);
  assert.equal(androidVersionCode(rc.version), 1000561);
  assert.ok(androidVersionCode(rc.version) > androidVersionCode("0.1.4"));
  assert.ok(androidVersionCode(rc.version) < androidVersionCode("0.1.5"));
  const topicIds = rc.contentByLocale["zh-CN"].topics.map((topic) => topic.id);
  assert.equal(new Set(topicIds).size, topicIds.length);
  for (const locale of LOCALES) {
    assert.deepEqual(rc.contentByLocale[locale].topics.map((topic) => topic.id), topicIds);
  }
  assert.ok(body.length < 1400, "Keep the public release body concise");
  assert.match(body, /预发布/);
  assert.match(body, /beta/);
  assert.match(body, /0\.1\.4/);
  assert.doesNotMatch(body, /English|日本語|한국어|繁體中文/);
  const ci = YAML.parse(fs.readFileSync(
    new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8",
  ));
  assert.ok(Object.values(ci.jobs).some((job) => job.steps?.some((step) =>
    step.run?.includes("scripts/__tests__/lex-release-notices.test.mjs"))));
});

test("0.1.4 stable notices cover every locale and match the detailed release body", () => {
  const stable = JSON.parse(fs.readFileSync(
    new URL("../../release-notices/0.1.4.json", import.meta.url), "utf8",
  ));
  const body = fs.readFileSync(
    new URL("../../release-notices/0.1.4.md", import.meta.url), "utf8",
  );
  validateNotice(stable, "0.1.4");
  assert.ok(compareVersions(stable.version, "0.1.4-rc.2") > 0);
  const topicIds = stable.contentByLocale.en.topics.map((topic) => topic.id);
  for (const locale of LOCALES) {
    const content = stable.contentByLocale[locale];
    assert.deepEqual(content.topics.map((topic) => topic.id), topicIds);
    assert.ok(body.includes(content.intro), locale);
    for (const topic of content.topics) {
      assert.ok(body.includes(topic.title), locale + ":" + topic.id);
      assert.ok(body.includes(topic.text), locale + ":" + topic.id);
    }
  }
});

test("the checked-in authoring template renders in every locale after choosing a release version", () => {
  const template = JSON.parse(
    fs.readFileSync(
      new URL("../../release-notices/template.json", import.meta.url),
      "utf8",
    ),
  );
  assert.throws(() => validateNotice(template, template.version));
  template.version = "1.2.3";
  assert.equal(validateNotice(template, "1.2.3"), template);
});
