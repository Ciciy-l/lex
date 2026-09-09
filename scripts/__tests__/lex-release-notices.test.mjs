import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";
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
