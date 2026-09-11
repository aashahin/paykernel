import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function aggregateCoverage(lcov: string): { lines: number; functions: number } {
  const totals = { LF: 0, LH: 0, FNF: 0, FNH: 0 };
  const records = lcov.split("end_of_record").filter((record) => record.trim());
  if (records.length === 0) throw new Error("Coverage report is empty.");
  for (const record of records) {
    const counts = new Map<string, number>();
    for (const line of record.trim().split("\n")) {
      const match = /^(LF|LH|FNF|FNH):(\d+)$/.exec(line.trim());
      if (match) counts.set(match[1]!, Number(match[2]));
    }
    for (const key of Object.keys(totals) as Array<keyof typeof totals>) {
      const count = counts.get(key);
      if (count === undefined || !Number.isSafeInteger(count)) {
        throw new Error(`Missing or invalid coverage counter: ${key}`);
      }
      totals[key] += count;
    }
    if (counts.get("LH")! > counts.get("LF")! || counts.get("FNH")! > counts.get("FNF")!) {
      throw new Error("Covered counts exceed total counts.");
    }
  }
  if (totals.LF === 0 || totals.FNF === 0) throw new Error("Coverage report has no executable code.");
  return { lines: totals.LH / totals.LF, functions: totals.FNH / totals.FNF };
}

export function meetsThresholds(
  coverage: { lines: number; functions: number },
  thresholds: { lines: number; functions: number },
): boolean {
  return coverage.lines >= thresholds.lines && coverage.functions >= thresholds.functions;
}

if (import.meta.main) {
  const root = join(import.meta.dir, "..");
  const config = Bun.TOML.parse(readFileSync(join(root, "bunfig.toml"), "utf8")) as {
    test: { coverageThreshold: { lines: number; functions: number } };
  };
  const directory = mkdtempSync(join(tmpdir(), "paykernel-coverage-"));
  try {
    // Disable Bun's per-file gate only in the measurement process. The aggregate
    // gate below retains the repository's thresholds and propagates test failures.
    const measurementConfig = join(directory, "bunfig.toml");
    writeFileSync(measurementConfig, '[test]\ncoverageSkipTestFiles = true\ncoverageReporter = ["lcov"]\n');
    const child = Bun.spawn([
      process.execPath, "test", `--config=${measurementConfig}`, "--coverage", "--coverage-reporter=lcov",
      `--coverage-dir=${directory}`, "packages/core",
    ], { cwd: root, stdout: "inherit", stderr: "inherit" });
    const code = await child.exited;
    if (code !== 0) process.exitCode = code;
    else {
      const coverage = aggregateCoverage(readFileSync(join(directory, "lcov.info"), "utf8"));
      console.log(`Aggregate coverage: ${(coverage.lines * 100).toFixed(2)}% lines, ${(coverage.functions * 100).toFixed(2)}% functions`);
      if (!meetsThresholds(coverage, config.test.coverageThreshold)) {
        console.error("Aggregate coverage is below the thresholds in bunfig.toml.");
        process.exitCode = 1;
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
