import { resolve } from "node:path";
import ts from "typescript";

const packageDirectory = resolve(import.meta.dir, "..");
const diagnosticHost: ts.FormatDiagnosticsHost = {
  getCurrentDirectory: () => packageDirectory,
  getCanonicalFileName: (filename) => filename,
  getNewLine: () => "\n",
};

function failOnDiagnostics(diagnostics: readonly ts.Diagnostic[]): void {
  if (diagnostics.length === 0) return;
  console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, diagnosticHost));
  process.exit(1);
}

const config = ts.readConfigFile(resolve(packageDirectory, "tsconfig.json"), ts.sys.readFile);
if (config.error) failOnDiagnostics([config.error]);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, packageDirectory);
failOnDiagnostics(parsed.errors);

// Native Bun checks the project before this script runs; TypeScript only emits declarations.
const program = ts.createProgram({
  rootNames: parsed.fileNames,
  options: { ...parsed.options, noCheck: true, declaration: true, emitDeclarationOnly: true },
});
const emitted = program.emit();
failOnDiagnostics(emitted.diagnostics);
if (emitted.emitSkipped) throw new Error("Hesabe declaration emission was skipped");
