/** Names of skill packages distributed and managed by CoAgent8. */
export const COAGENT_SKILL_NAME = /^coagent8-[a-z]+(?:-[a-z]+)*$/;

/** Explicit installed packages and the subset kept outside client discovery. */
export interface SkillSelection {
  installed: string[];
  disabled: string[];
}
