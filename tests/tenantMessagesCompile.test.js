/**
 * Golden tenant messages — layer A (compileTurn, deterministic, no LLM).
 * Fixture: tests/fixtures/tenant-messages.json (Claude core set + metadata).
 *
 * Many rows encode product intent (NO_TICKET, SPLIT, UPDATE) that only
 * full pipeline tests can enforce — those are counted as pipeline_pending, not failures.
 */
const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const {
  testLayerForRow,
  assertCompileLayer,
} = require("./helpers/tenantMessageExpectations");

const FIXTURE_PATH = path.join(__dirname, "fixtures", "tenant-messages.json");
const fixture = require(FIXTURE_PATH);
const rows = fixture.messages || fixture;

const KNOWN_PROPERTIES = new Set(["PENN", "MURR", "MORRIS", "MURRAY"]);
const TENANT_PHONE = "+15559876543";

/** Known compile-layer gaps — lower as intake improves. STRICT=1 requires 0. */
const COMPILE_BASELINE_MAX_FAIL = 0;

describe("tenant golden messages — compile layer", () => {
  let prevCompile;
  let prevLlm;

  beforeEach(() => {
    prevCompile = process.env.INTAKE_COMPILE_TURN;
    prevLlm = process.env.INTAKE_LLM_ENABLED;
    process.env.INTAKE_COMPILE_TURN = "1";
    process.env.INTAKE_LLM_ENABLED = "0";
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    if (prevCompile === undefined) delete process.env.INTAKE_COMPILE_TURN;
    else process.env.INTAKE_COMPILE_TURN = prevCompile;
    if (prevLlm === undefined) delete process.env.INTAKE_LLM_ENABLED;
    else process.env.INTAKE_LLM_ENABLED = prevLlm;
  });

  test(`fixture loads (${rows.length} messages)`, () => {
    assert.ok(rows.length >= 60, `expected ~61 rows, got ${rows.length}`);
    assert.ok(fixture.schemaVersion >= 2);
  });

  test("compileTurn assertions per row (strict compile rows only)", async () => {
    const { compileTurn } = require("../src/brain/intake/compileTurn");
    const strict = String(process.env.TENANT_GOLDEN_STRICT || "").trim() === "1";

    let compilePass = 0;
    let compileFail = 0;
    let pipelinePending = 0;
    let skipped = 0;
    const failures = [];

    for (const row of rows) {
      const layer = testLayerForRow(row);
      if (layer === "skip") {
        skipped++;
        continue;
      }
      if (layer === "pipeline" || layer === "compile_soft") {
        pipelinePending++;
        if (strict && layer === "compile_soft") {
          const tf = await compileTurn(
            row.message,
            TENANT_PHONE,
            "en",
            {},
            null,
            { knownPropertyCodesUpper: KNOWN_PROPERTIES }
          );
          const errs = assertCompileLayer(row, tf);
          if (errs.length) {
            compileFail++;
            failures.push({ id: row.id, errs });
          } else compilePass++;
        }
        continue;
      }

      const tf = await compileTurn(
        row.message,
        TENANT_PHONE,
        "en",
        {},
        null,
        { knownPropertyCodesUpper: KNOWN_PROPERTIES }
      );
      const errs = assertCompileLayer(row, tf);
      if (errs.length) {
        compileFail++;
        failures.push({ id: row.id, category: row.category, errs, issue: tf.issue });
      } else compilePass++;
    }

    if (failures.length) {
      console.error(
        "tenant golden compile failures:\n" +
          failures
            .slice(0, 15)
            .map((f) => `  ${f.id}: ${f.errs.join("; ")}`)
            .join("\n") +
          (failures.length > 15 ? `\n  ... +${failures.length - 15} more` : "")
      );
    }

    console.log(
      JSON.stringify({
        total: rows.length,
        compilePass,
        compileFail,
        pipelinePending,
        skipped,
      })
    );

    if (strict) {
      assert.equal(
        compileFail,
        0,
        `${compileFail} compile-layer golden failures (see log). Set TENANT_GOLDEN_STRICT=0 for baseline mode.`
      );
    } else {
      assert.ok(
        compileFail <= COMPILE_BASELINE_MAX_FAIL,
        `${compileFail} compile failures exceeds baseline ${COMPILE_BASELINE_MAX_FAIL} — fix or raise baseline intentionally`
      );
    }
  });
});
