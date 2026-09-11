import { request } from "@playwright/test";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
const passwordPath = process.env.PAYKERNEL_TEST_PASSWORD_FILE;
if (!passwordPath) throw new Error("PAYKERNEL_TEST_PASSWORD_FILE is required.");
const context = await request.newContext({ baseURL, extraHTTPHeaders: { origin: baseURL } });
const login = await context.post("/api/auth/sign-in/email", { data: {
  email: process.env.PAYKERNEL_TEST_EMAIL ?? "lab-tester@example.com", password: (await readFile(passwordPath, "utf8")).trim(),
} });
if (!login.ok()) throw new Error(`Seller login failed: ${login.status()}`);
const definitions = z.object({ scenarios: z.array(z.object({ id: z.string(), label: z.string() })) }).parse(await (await context.get("/api/seller/scenarios")).json());
const runSchema = z.object({ id: z.string(), scenario: z.string(), gateway: z.string(), mode: z.string(), verdict: z.enum(["running", "passed", "failed", "blocked", "unsupported"]), evidenceJson: z.string() });
const results: z.infer<typeof runSchema>[] = [];
const gateways = process.env.PAYKERNEL_TEST_GATEWAYS?.split(",") ?? ["stripe", "paypal", "paymob", "moyasar", "tap", "myfatoorah", "hesabe"];
for (const gateway of gateways) {
  for (const scenario of definitions.scenarios) {
    const response = await context.post("/api/seller/scenarios", { data: { gateway, scenario: scenario.id, mode: "simulator" }, timeout: 60_000 });
    if (!response.ok()) throw new Error(`Scenario request failed: ${gateway}/${scenario.id}: ${response.status()}`);
    const body = z.object({ run: runSchema }).parse(await response.json());
    results.push(body.run);
    console.log(`${gateway}/${scenario.id}: ${body.run.verdict}`);
  }
}
const reportPath = process.env.PAYKERNEL_TEST_REPORT ?? "validation-results/scenarios.json";
await mkdir(dirname(reportPath), { recursive: true });
for (let check = 0; check < 18 && results.some(run => run.verdict === "running"); check++) {
  await new Promise(resolve => setTimeout(resolve, process.env.PAYKERNEL_TEST_CRON === "1" ? 10_000 : 2000));
  if (process.env.PAYKERNEL_TEST_CRON !== "1") {
    const retry = await context.post("/api/seller/webhooks/retry");
    if (!retry.ok()) throw new Error(`Retry failed: ${retry.status()}`);
  }
  const recent = z.object({ runs: z.array(runSchema) }).parse(await (await context.get("/api/seller/runs")).json());
  for (let index = 0; index < results.length; index++) {
    const updated = recent.runs.find(run => run.id === results[index]?.id);
    if (updated) results[index] = updated;
  }
  console.log(`Awaiting retries: ${results.filter(run => run.verdict === "running").length}`);
}
const report = { origin: baseURL, testedAt: new Date().toISOString(), layer: "simulator over signed HTTP", results };
await writeFile(reportPath, JSON.stringify(report, null, 2));
await context.dispose();
if (results.some(run => run.verdict === "failed" || run.verdict === "running")) process.exitCode = 1;
