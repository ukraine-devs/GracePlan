import test from "node:test";
import assert from "node:assert/strict";
import { createExecutionLog } from "../lib/executionLog.js";

test("only observed commands are retained with completion and failure across serialization", () => {
  let now = Date.UTC(2026, 9, 15), visible = [];
  const log = createExecutionLog((rows) => { visible = rows; }, () => now);
  assert.deepEqual(log.snapshot(), []);
  log.stage("read", "Read source plan");
  now += 800;
  log.stage("read", "Source plan preserved", "done");
  log.stage("render", "Creating render");
  now += 200;
  log.stage("render", "Render failed: insufficient credits", "failed");
  const restored = JSON.parse(JSON.stringify(log.snapshot()));
  assert.equal(restored.length, 2);
  assert.equal(restored[0].completedAt - restored[0].startedAt, 800);
  assert.match(restored[1].label, /insufficient credits/);
  assert.equal(restored[1].status, "failed");
  assert.equal(restored.some((row) => row.id === "pdf"), false, "an unexecuted PDF export is never claimed");
  assert.equal(visible.length, 2);
});
