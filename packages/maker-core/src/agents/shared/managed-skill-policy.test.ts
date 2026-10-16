import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { resolveAllowedManagedSkills } from "./managed-skill-policy.js";
import { prepareManagedSkillPlugins } from "../claude-code/managed-skill-plugins.js";

describe("managed skill physical paths", () => {
  it("mounts the selected physical source if a discovery alias moves before loading", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "cindy-managed-grants-"),
    );
    try {
      const approved = path.join(root, "approved");
      const replaced = path.join(root, "replaced");
      const alias = path.join(root, "discovery");
      for (const dir of [approved, replaced]) {
        fs.mkdirSync(dir);
        fs.writeFileSync(path.join(dir, "SKILL.md"), "# Fixture");
      }
      fs.symlinkSync(
        approved,
        alias,
        process.platform === "win32" ? "junction" : "dir",
      );
      const discovered = [
        {
          kind: "agent-skill" as const,
          name: "learn",
          source: "skill" as const,
          claudeCommandName: "cindy:learn",
          path: path.join(alias, "SKILL.md"),
        },
      ];
      const selected = resolveAllowedManagedSkills(discovered, []);
      // Pi receives these exact physical paths as --skill arguments.
      expect(selected[0]?.path).toBe(
        fs.realpathSync(path.join(approved, "SKILL.md")),
      );
      fs.unlinkSync(alias);
      fs.symlinkSync(
        replaced,
        alias,
        process.platform === "win32" ? "junction" : "dir",
      );
      expect(resolveAllowedManagedSkills(discovered, [])[0]?.path).toBe(fs.realpathSync(path.join(replaced, "SKILL.md")));
      const mounted = await prepareManagedSkillPlugins(selected);
      try {
        expect(
          fs.realpathSync.native(path.join(mounted.roots[0]!, "skills", "learn")),
        ).toBe(fs.realpathSync.native(approved));
      } finally {
        await mounted.dispose();
      }
      expect(resolveAllowedManagedSkills(selected, [approved])).toEqual(
        [],
      );
      fs.rmSync(approved, { recursive: true });
      expect(resolveAllowedManagedSkills(selected, [])).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
