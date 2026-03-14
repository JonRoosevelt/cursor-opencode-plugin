import { AdapterError } from "../errors/adapterError.js";

const FINAL_START = "<<<CURSOR_FINAL>>>";
const FINAL_END = "<<<END_CURSOR_FINAL>>>";

const clip = (value: string, maxLength = 400): string => {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}...`;
};

export const parseCursorOutput = (stdout: string, stderr: string): string => {
  const normalizedStdout = stdout.replace(/\r\n/g, "\n").trim();

  const hasFinalBlock =
    normalizedStdout.includes(FINAL_START) && normalizedStdout.includes(FINAL_END);

  if (hasFinalBlock) {
    const startIndex = normalizedStdout.indexOf(FINAL_START);
    const endIndex = normalizedStdout.indexOf(FINAL_END);
    if (startIndex >= 0 && endIndex > startIndex) {
      const inside = normalizedStdout
        .slice(startIndex + FINAL_START.length, endIndex)
        .trim();
      if (inside.length > 0) {
        return inside;
      }
    }
  }

  if (normalizedStdout.length > 0) {
    return normalizedStdout;
  }

  throw new AdapterError(
    "CURSOR_MALFORMED_OUTPUT",
    "Cursor returned no parseable assistant output.",
    502,
    { stderr: clip(stderr) }
  );
};
