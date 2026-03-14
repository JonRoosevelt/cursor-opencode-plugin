import { loadConfig } from "../src/config/config.js";
import { parseCursorOutput } from "../src/cursor/parseOutput.js";
import { runCursor } from "../src/cursor/runCursor.js";

const main = async (): Promise<void> => {
  const config = loadConfig();
  const prompt =
    process.argv.slice(2).join(" ").trim() ||
    "Say hello from Cursor in one short sentence.";

  const result = await runCursor({
    prompt,
    cwd: config.defaultCwd,
    config
  });

  const normalized = parseCursorOutput(result.stdout, result.stderr);

  // Keep this script intentionally simple for phase-0 validation.
  console.log(
    JSON.stringify(
      {
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        normalized
      },
      null,
      2
    )
  );
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
