import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC_DIR = join(__dirname, "..", "src");

// Banned because they are non-deterministic or implementation-defined across
// JS engines (and the sim must run bit-for-bit identically on client/server).
const BANNED = ["Math.sin", "Math.cos", "Math.tan", "Math.atan2", "Math.random", "Date", "performance", "three"];

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("purity guard", () => {
  it("sim/src never references banned non-deterministic identifiers", () => {
    const offenders: string[] = [];
    for (const file of listFiles(SRC_DIR)) {
      const contents = readFileSync(file, "utf8");
      for (const token of BANNED) {
        if (contents.includes(token)) {
          offenders.push(`${file}: contains "${token}"`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
