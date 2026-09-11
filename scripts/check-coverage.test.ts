import { expect, test } from "bun:test";
import { aggregateCoverage, meetsThresholds } from "./check-coverage";

const record = (lines: number, hit: number, functions: number, called: number) =>
  `SF:file.ts\nLF:${lines}\nLH:${hit}\nFNF:${functions}\nFNH:${called}\nend_of_record\n`;

test("weights aggregate coverage by executable counts, allowing individual files below the global floor", () => {
  const coverage = aggregateCoverage(record(90, 90, 9, 9) + record(10, 0, 1, 0));
  expect(coverage).toEqual({ lines: 0.9, functions: 0.9 });
  expect(meetsThresholds(coverage, { lines: 0.9, functions: 0.85 })).toBe(true);
});

test("rejects either metric below its threshold without rounding up", () => {
  const thresholds = { lines: 0.9, functions: 0.85 };
  expect(meetsThresholds({ lines: 0.89999, functions: 1 }, thresholds)).toBe(false);
  expect(meetsThresholds({ lines: 1, functions: 0.84999 }, thresholds)).toBe(false);
});

test("fails closed on empty, incomplete, and impossible coverage reports", () => {
  for (const report of ["", "SF:file.ts\nLF:1\nend_of_record", record(0, 0, 0, 0), record(1, 2, 1, 1)]) {
    expect(() => aggregateCoverage(report)).toThrow();
  }
});
