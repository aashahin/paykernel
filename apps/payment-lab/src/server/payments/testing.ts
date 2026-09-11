import type { D1DatabaseLike, LabClock, SimulatorRow, TestRunRow } from "./db";
import {
  auditInsertSql,
  batchChanges,
  newLabId,
  requireNonEmptyText,
  systemClock,
} from "./db";
import { LabConflictError, LabNotFoundError, LabValidationError } from "./errors";
import type {
  CreateTestRunRequest,
  LabGateway,
  LabTestRun,
  LabTestVerdict,
  PutSimulatorStateRequest,
  SimulatorState,
  UpdateTestRunRequest,
} from "./types";
import {
  assertGateway,
  assertNonEmptyString,
  assertSimulatorMode,
  sanitizeDetailJson,
  sanitizeEvidenceJson,
} from "./validate";

const TEST_RUN_COLS = `id, scenario, gateway, mode, verdict, evidence_json, created_at, updated_at`;
const VERDICTS: readonly LabTestVerdict[] = ["running", "passed", "failed", "blocked", "unsupported"];
const AUDIT_KINDS: readonly string[] = ["order", "attempt", "operation", "refund", "webhook", "test_run"];

export type LabAuditEntry = {
  id: number;
  entityKind: string;
  entityId: string;
  action: string;
  detailJson: string;
  createdAt: string;
};

export function mapTestRunRow(row: TestRunRow): LabTestRun {
  return {
    id: requireNonEmptyText(row.id, "id"),
    scenario: requireNonEmptyText(row.scenario, "scenario"),
    gateway: requireNonEmptyText(row.gateway, "gateway") as LabGateway,
    mode: requireNonEmptyText(row.mode, "mode") as LabTestRun["mode"],
    verdict: requireNonEmptyText(row.verdict, "verdict") as LabTestVerdict,
    evidenceJson: requireNonEmptyText(row.evidence_json, "evidence_json"),
    createdAt: requireNonEmptyText(row.created_at, "created_at"),
    updatedAt: requireNonEmptyText(row.updated_at, "updated_at"),
  };
}

export function mapSimulatorRow(row: SimulatorRow): SimulatorState {
  const mode = requireNonEmptyText(row.mode, "mode");
  if (mode !== "simulator") throw new LabValidationError("corrupt row: simulator mode mismatch");
  return {
    gateway: requireNonEmptyText(row.gateway, "gateway") as LabGateway,
    mode: "simulator",
    stateKey: requireNonEmptyText(row.state_key, "state_key"),
    stateJson: requireNonEmptyText(row.state_json, "state_json"),
    updatedAt: requireNonEmptyText(row.updated_at, "updated_at"),
  };
}

export async function createTestRun(
  db: D1DatabaseLike,
  input: CreateTestRunRequest,
  clock: LabClock = systemClock(),
): Promise<LabTestRun> {
  assertNonEmptyString(input.scenario, "scenario", 200);
  assertGateway(input.gateway);
  if (input.mode !== "sandbox" && input.mode !== "simulator") throw new LabValidationError(`unknown mode: ${input.mode}`);
  const now = clock.nowIso();
  const id = input.id ?? newLabId("tst");
  const detail = sanitizeDetailJson({ scenario: input.scenario, gateway: input.gateway, mode: input.mode });
  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO lab_test_runs (id, scenario, gateway, mode, verdict, evidence_json, created_at, updated_at) VALUES (?, ?, ?, ?, 'running', '{}', ?, ?)`,
      )
      .bind(id, input.scenario, input.gateway, input.mode, now, now),
    db.prepare(auditInsertSql()).bind("test_run", id, "create", detail, now),
  ]);
  if (batchChanges(results, 0) !== 1) throw new LabConflictError(`test run create lost a concurrent write: ${id}`);
  return getTestRun(db, id);
}

export async function getTestRun(db: D1DatabaseLike, testRunId: string): Promise<LabTestRun> {
  const row = await db.prepare(`SELECT ${TEST_RUN_COLS} FROM lab_test_runs WHERE id = ?`).bind(testRunId).first<TestRunRow>();
  if (row === null) throw new LabNotFoundError(`test run not found: ${testRunId}`);
  return mapTestRunRow(row);
}

export async function listTestRuns(db: D1DatabaseLike, limit = 50): Promise<LabTestRun[]> {
  const bounded = Math.min(Math.max(limit, 1), 200);
  const { results } = await db
    .prepare(`SELECT ${TEST_RUN_COLS} FROM lab_test_runs ORDER BY created_at DESC LIMIT ?`)
    .bind(bounded)
    .all<TestRunRow>();
  return results.map((r) => mapTestRunRow(r));
}

export async function listTestRunsByScenario(
  db: D1DatabaseLike,
  scenario: string,
  limit = 50,
): Promise<LabTestRun[]> {
  assertNonEmptyString(scenario, "scenario", 200);
  const bounded = Math.min(Math.max(limit, 1), 200);
  const { results } = await db
    .prepare(`SELECT ${TEST_RUN_COLS} FROM lab_test_runs WHERE scenario = ? ORDER BY created_at DESC LIMIT ?`)
    .bind(scenario, bounded)
    .all<TestRunRow>();
  return results.map((r) => mapTestRunRow(r));
}

export async function updateTestRun(
  db: D1DatabaseLike,
  input: UpdateTestRunRequest,
  clock: LabClock = systemClock(),
): Promise<LabTestRun> {
  if (!VERDICTS.includes(input.verdict)) throw new LabValidationError(`unknown verdict: ${input.verdict}`);
  const evidenceJson = sanitizeEvidenceJson(input.evidenceJson);
  await getTestRun(db, input.id);
  const now = clock.nowIso();
  const detail = sanitizeDetailJson({ verdict: input.verdict });
  const results = await db.batch([
    db
      .prepare(`UPDATE lab_test_runs SET verdict = ?, evidence_json = ?, updated_at = ? WHERE id = ?`)
      .bind(input.verdict, evidenceJson, now, input.id),
    db.prepare(auditInsertSql()).bind("test_run", input.id, "verdict", detail, now),
  ]);
  if (batchChanges(results, 0) !== 1) throw new LabConflictError("test run update lost a concurrent write; retry");
  return getTestRun(db, input.id);
}

export async function getSimulatorState(
  db: D1DatabaseLike,
  gateway: LabGateway,
  stateKey: string,
): Promise<SimulatorState | null>;
export async function getSimulatorState(
  db: D1DatabaseLike,
  input: { gateway: LabGateway; stateKey: string },
): Promise<SimulatorState | null>;
export async function getSimulatorState(
  db: D1DatabaseLike,
  gatewayOrInput: LabGateway | { gateway: LabGateway; stateKey: string },
  stateKeyArg?: string,
): Promise<SimulatorState | null> {
  const gateway = typeof gatewayOrInput === "string" ? gatewayOrInput : gatewayOrInput.gateway;
  const stateKey = typeof gatewayOrInput === "string" ? (stateKeyArg as string) : gatewayOrInput.stateKey;
  assertGateway(gateway);
  assertNonEmptyString(stateKey, "stateKey", 256);
  const row = await db
    .prepare(`SELECT gateway, mode, state_key, state_json, updated_at FROM lab_simulator_state WHERE gateway = ? AND mode = 'simulator' AND state_key = ?`)
    .bind(gateway, stateKey)
    .first<SimulatorRow>();
  return row === null ? null : mapSimulatorRow(row);
}

export async function putSimulatorState(
  db: D1DatabaseLike,
  input: PutSimulatorStateRequest,
  clock: LabClock = systemClock(),
): Promise<SimulatorState> {
  assertGateway(input.gateway);
  assertSimulatorMode(input.mode);
  assertNonEmptyString(input.stateKey, "stateKey", 256);
  const stateJson = sanitizeEvidenceJson(input.stateJson);
  const now = clock.nowIso();
  await db
    .prepare(
      `INSERT INTO lab_simulator_state (gateway, mode, state_key, state_json, updated_at) VALUES (?, 'simulator', ?, ?, ?) ON CONFLICT (gateway, mode, state_key) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`,
    )
    .bind(input.gateway, input.stateKey, stateJson, now)
    .run();
  const row = await db
    .prepare(`SELECT gateway, mode, state_key, state_json, updated_at FROM lab_simulator_state WHERE gateway = ? AND mode = 'simulator' AND state_key = ?`)
    .bind(input.gateway, input.stateKey)
    .first<SimulatorRow>();
  if (row === null) throw new LabConflictError("simulator state write lost a concurrent write; retry");
  return mapSimulatorRow(row);
}

export async function listAuditByEntity(
  db: D1DatabaseLike,
  entityKind: string,
  entityId: string,
  limit = 50,
): Promise<LabAuditEntry[]> {
  if (!AUDIT_KINDS.includes(entityKind)) throw new LabValidationError(`unknown entity kind: ${entityKind}`);
  assertNonEmptyString(entityId, "entityId", 256);
  const bounded = Math.min(Math.max(limit, 1), 200);
  const { results } = await db
    .prepare(
      `SELECT id, entity_kind, entity_id, action, detail_json, created_at FROM lab_audit WHERE entity_kind = ? AND entity_id = ? ORDER BY id ASC LIMIT ?`,
    )
    .bind(entityKind, entityId, bounded)
    .all<{ id: unknown; entity_kind: unknown; entity_id: unknown; action: unknown; detail_json: unknown; created_at: unknown }>();
  return results.map((r) => {
    const id = r.id;
    if (typeof id !== "number" || !Number.isSafeInteger(id)) throw new LabValidationError("corrupt row: id is not an integer");
    return {
      id,
      entityKind: requireNonEmptyText(r.entity_kind, "entity_kind"),
      entityId: requireNonEmptyText(r.entity_id, "entity_id"),
      action: requireNonEmptyText(r.action, "action"),
      detailJson: requireNonEmptyText(r.detail_json, "detail_json"),
      createdAt: requireNonEmptyText(r.created_at, "created_at"),
    };
  });
}
