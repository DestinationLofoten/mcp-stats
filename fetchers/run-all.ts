/**
 * fetchers/run-all.ts
 * Runs all fetchers in sequence.
 * Usage: npm run fetch:all
 */

import { execSync } from "child_process";
import * as path from "path";

const fetchers = ["brreg", "ssb"];
const root = path.resolve(__dirname, "..");

console.log("🚀 Running all fetchers...\n");

for (const fetcher of fetchers) {
  console.log(`\n${"─".repeat(50)}`);
  console.log(`Running: ${fetcher}`);
  console.log("─".repeat(50));

  try {
    execSync(`ts-node fetchers/${fetcher}.ts`, { stdio: "inherit", cwd: root });
  } catch (err) {
    console.error(`❌ Fetcher ${fetcher} failed`);
    process.exit(1);
  }
}

console.log("\n✅ All fetchers complete.");
