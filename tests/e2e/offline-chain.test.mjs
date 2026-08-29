import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

test("offline chain scenarios and coverage report", async () => {
  assert.equal(globalThis.__ZHITAI_E2E_NETWORK_LOCKDOWN__, true,
    "preload tests/e2e/network-lockdown.mjs with node --import before running this test");
  assert.equal(process.env.ZHITAI_E2E_NETWORK_POLICY, "deny_all");

  const sessionRoot = await mkdtemp(join(tmpdir(), "zhitai-offline-e2e-test-"));
  const temporaryHome = join(sessionRoot, "home");
  const temporaryTmp = join(sessionRoot, "tmp");
  const temporaryAppData = join(temporaryHome, "AppData", "Roaming");
  const temporaryLocalAppData = join(temporaryHome, "AppData", "Local");
  const priorEnvironment = { ...process.env };
  const windowsSystemEnvironment = process.platform === "win32"
    ? Object.fromEntries(["SystemRoot", "SystemDrive", "ComSpec", "PATHEXT"]
      .flatMap((name) => priorEnvironment[name] ? [[name, priorEnvironment[name]]] : []))
    : {};
  for (const name of Object.keys(process.env)) delete process.env[name];
  Object.assign(process.env, {
    HOME: temporaryHome,
    USERPROFILE: temporaryHome,
    APPDATA: temporaryAppData,
    LOCALAPPDATA: temporaryLocalAppData,
    TMPDIR: temporaryTmp,
    TEMP: temporaryTmp,
    TMP: temporaryTmp,
    XDG_CONFIG_HOME: join(temporaryHome, ".config"),
    XDG_DATA_HOME: join(temporaryHome, ".local", "share"),
    XDG_CACHE_HOME: join(temporaryHome, ".cache"),
    USER: "zhitai-e2e",
    LOGNAME: "zhitai-e2e",
    PATH: dirname(process.execPath),
    LANG: "C.UTF-8",
    TZ: "UTC",
    CI: "false",
    ZHITAI_E2E_OFFLINE: "1",
    ZHITAI_E2E_NETWORK_POLICY: "deny_all",
    ZHITAI_E2E_ENV_SANITIZED: "1",
    ...windowsSystemEnvironment,
  });
  try {
    await Promise.all([
      mkdir(temporaryHome, { recursive: true, mode: 0o700 }),
      mkdir(temporaryTmp, { recursive: true, mode: 0o700 }),
      mkdir(temporaryAppData, { recursive: true, mode: 0o700 }),
      mkdir(temporaryLocalAppData, { recursive: true, mode: 0o700 }),
      mkdir(process.env.XDG_CONFIG_HOME, { recursive: true, mode: 0o700 }),
      mkdir(process.env.XDG_DATA_HOME, { recursive: true, mode: 0o700 }),
      mkdir(process.env.XDG_CACHE_HOME, { recursive: true, mode: 0o700 }),
    ]);
    const {
      coverageIsComplete,
      determineSuiteStatus,
      runOfflineE2ESuite,
    } = await import("./suite.mjs");
    const report = await runOfflineE2ESuite({
      runId: "offline-e2e-node-test",
      sessionRoot,
      keepSandbox: false,
    });
    assert.equal(report.status, "passed", JSON.stringify(
      report.scenarios.filter((scenario) => scenario.status === "failed"), null, 2));
    assert.equal(report.summary.failed, 0);
    assert.ok(report.summary.assertions >= 100);
    assert.equal(report.summary.coverageComplete, true);
    assert.equal(report.environment.credentialEnvironmentSanitized, true);
    for (const category of ["stages", "faults", "invariants"]) {
      assert.ok(report.coverage[category].every((entry) => entry.covered),
        `${category} coverage must be complete`);
    }
    const serialized = JSON.stringify(report);
    assert.ok(!serialized.includes(sessionRoot), "report must not expose its temporary root");
    assert.ok(!serialized.includes("/Users/"), "report must not expose a user path");
    assert.ok(!serialized.includes("E2E_ENV_SECRET_SENTINEL_9c40a7"),
      "report must not contain a parent-shell credential sentinel");
    const traceProof = report.scenarios.find((scenario) => scenario.id === "full_chain_success")?.evidence?.traceProof;
    assert.ok(traceProof?.source?.sha256, "report must retain source trace proof after sandbox deletion");
    assert.ok(traceProof?.prompt?.promptId && traceProof?.prompt?.promptHash);
    assert.equal(traceProof?.receiptHashes?.length, 2);
    assert.deepEqual(traceProof?.metricReceiptLinks, traceProof?.receiptHashes);

    const incompleteCoverage = {
      ...report.coverage,
      faults: report.coverage.faults.map((entry, index) => index === 0 ? { ...entry, covered: false } : entry),
    };
    assert.equal(coverageIsComplete(incompleteCoverage), false);
    assert.equal(determineSuiteStatus(report.scenarios, incompleteCoverage), "failed",
      "suite status must fail even when scenarios pass if a required coverage item is missing");
  } finally {
    for (const name of Object.keys(process.env)) delete process.env[name];
    Object.assign(process.env, priorEnvironment);
    await rm(sessionRoot, { recursive: true, force: true });
  }
});
