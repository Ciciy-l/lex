import fs from "node:fs";
import type { AgentDeps } from "../base-agent.js";
import { isSkillDisabled } from "./skill-activation.js";

/** Check and mount the same physical file, even if a discovery alias moves later. */
export function resolveAllowedManagedSkills(
  skills: Awaited<ReturnType<NonNullable<AgentDeps["getManagedSkills"]>>>,
  disabledPaths: readonly string[],
) {
  return skills.flatMap((skill) => {
    if (!skill.path) return [];
    let source: string;
    try {
      source = fs.realpathSync(skill.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    if (
      isSkillDisabled(source, disabledPaths)
    )
      return [];
    return [{ ...skill, path: source }];
  });
}
