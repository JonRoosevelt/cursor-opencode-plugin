import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type SkillResolution = {
  commandName: string;
  args: string;
  content: string;
};

const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n/;

/**
 * Checks if a message is a slash command (e.g. `/review https://...`) and
 * resolves it to the corresponding skill file in ~/.claude/commands/<name>.md.
 * Returns null if the message is not a slash command or no matching file exists.
 */
export const resolveSkillCommand = (message: string): SkillResolution | null => {
  const trimmed = message.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }

  const spaceIndex = trimmed.indexOf(" ");
  const commandName = spaceIndex === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIndex);
  const args = spaceIndex === -1 ? "" : trimmed.slice(spaceIndex + 1).trim();

  if (!commandName) {
    return null;
  }

  const skillPath = join(homedir(), ".claude", "commands", `${commandName}.md`);
  if (!existsSync(skillPath)) {
    return null;
  }

  const raw = readFileSync(skillPath, "utf8");
  const content = raw.replace(FRONTMATTER_RE, "").trim().replace(/\$ARGUMENTS/g, args);

  return { commandName, args, content };
};
