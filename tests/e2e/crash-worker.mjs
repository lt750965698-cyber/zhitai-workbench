/**
 * A deliberately short-lived worker used to prove recovery from a real Node
 * process exit. It is only started by suite.mjs and inherits the offline
 * network preload before it imports the chain harness.
 */
import { createDeterministicMedia } from "./synthetic-media.mjs";
import { createFakePlatforms, FaultPlan, FAULT_CODES } from "./fakes.mjs";
import { createChainHarness } from "./chain-harness.mjs";

const CRASH_EXIT_CODE = 86;

function sendAndExit(message, exitCode) {
  if (typeof process.send !== "function") process.exit(exitCode);
  process.send(message, () => process.exit(exitCode));
}

function exitWhileAwaiting(message, exitCode) {
  return new Promise(() => {
    if (typeof process.send !== "function") process.exit(exitCode);
    process.send(message, () => process.exit(exitCode));
  });
}

if (globalThis.__ZHITAI_E2E_NETWORK_LOCKDOWN__ !== true
  || process.env.ZHITAI_E2E_NETWORK_POLICY !== "deny_all") {
  sendAndExit({ type: "worker_bootstrap_failed", code: "offline_network_lockdown_not_preloaded" }, 2);
} else {
  process.once("message", async (configuration = {}) => {
    const mode = configuration.mode || "stage";
    const faultPoint = configuration.faultPoint || "generate";
    const input = {
      deliveryId: configuration.deliveryId || "delivery-process-crash",
      sourceId: configuration.sourceId || "synthetic-process-crash",
      prompt: "offline synthetic crash recovery prompt",
      media: createDeterministicMedia({ seed: configuration.mediaSeed || "process-crash" }),
      provenance: { authorized: true, synthetic: true, networkAccess: false },
    };
    const platforms = createFakePlatforms(configuration.platformNames || ["fake-alpha", "fake-beta"]);
    const faults = mode === "publish"
      ? new FaultPlan()
      : new FaultPlan({ [faultPoint]: { code: FAULT_CODES.PROCESS_CRASH, times: 1 } });
    if (mode === "publish") {
      const crashPlatform = configuration.crashPlatform || Object.keys(platforms)[0];
      platforms[crashPlatform].publish = async (request) => exitWhileAwaiting({
        type: "worker_publishing_crashed",
        correlationId: request.correlationId,
        platform: crashPlatform,
        code: FAULT_CODES.PROCESS_CRASH,
      }, CRASH_EXIT_CODE);
    }

    try {
      const harness = await createChainHarness({
        rootDir: configuration.rootDir,
        dbPath: configuration.dbPath,
        bootId: configuration.bootId || "boot-before-crash",
        clock: () => new Date(configuration.now || "2030-01-01T00:00:00.000Z"),
        platforms,
        platformAdapters: platforms,
        faults,
      });
      const received = await harness.receive(input);
      const correlationId = received.correlationId;
      if (typeof process.send === "function") {
        process.send({ type: "worker_armed", correlationId, faultPoint, mode });
      }
      if (mode === "publish") {
        await harness.runUntilReview(correlationId);
        await harness.review(correlationId, { approved: true, reviewer: "offline-crash-worker" });
        await harness.createDraft(correlationId);
        await harness.schedule(correlationId, {
          scheduledFor: configuration.now || "2030-01-01T00:00:00.000Z",
          platforms: configuration.platformNames || ["fake-alpha", "fake-beta"],
        });
        await harness.dispatchDue({
          correlationId,
          now: configuration.now || "2030-01-01T00:00:00.000Z",
        });
      } else {
        await harness.run(correlationId);
      }
      sendAndExit({
        type: "worker_unexpected_completion",
        correlationId,
        code: "PROCESS_CRASH_NOT_RAISED",
      }, 3);
    } catch (error) {
      if (error?.code === FAULT_CODES.PROCESS_CRASH || error?.name === "SimulatedProcessCrash") {
        sendAndExit({
          type: "worker_crashed",
          correlationId: error?.details?.correlationId || null,
          code: FAULT_CODES.PROCESS_CRASH,
          faultPoint,
        }, CRASH_EXIT_CODE);
      } else {
        sendAndExit({
          type: "worker_unexpected_error",
          code: String(error?.code || error?.name || "UNKNOWN_ERROR").slice(0, 80),
        }, 2);
      }
    }
  });
}

export { CRASH_EXIT_CODE };
