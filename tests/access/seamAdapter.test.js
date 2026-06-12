const { describe, test, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const { seamAdapter, parseSeamAccessCode } = require("../../src/access/lockAdapter/seamAdapter");
const { setSeamClientForTests } = require("../../src/access/lockAdapter/seamClient");

describe("seamAdapter", () => {
  afterEach(() => {
    setSeamClientForTests(null);
  });

  test("parseSeamAccessCode reads nested and flat shapes", () => {
    assert.deepEqual(
      parseSeamAccessCode({
        access_code_id: "ac_1",
        code: "1234",
      }),
      { accessCodeId: "ac_1", code: "1234" }
    );
    assert.deepEqual(
      parseSeamAccessCode({
        access_code: { access_code_id: "ac_2", code: "5678" },
      }),
      { accessCodeId: "ac_2", code: "5678" }
    );
  });

  test("issueCredential creates time-bound code on Seam device", async () => {
    const calls = [];
    setSeamClientForTests({
      accessCodes: {
        create: async (payload) => {
          calls.push(payload);
          return {
            access_code_id: "ac_test_1",
            code: payload.code,
            device_id: payload.device_id,
          };
        },
      },
    });

    const from = new Date("2026-06-11T15:00:00.000Z");
    const until = new Date("2026-06-11T17:00:00.000Z");
    const issued = await seamAdapter.issueCredential(
      { external_lock_id: "device-uuid-1" },
      from,
      until,
      { reservationId: "res-abc", name: "propera-res-abc" }
    );

    assert.equal(issued.credentialType, "pin");
    assert.match(issued.credentialValue, /^\d{4}$/);
    assert.equal(issued.externalCredentialId, "ac_test_1");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].device_id, "device-uuid-1");
    assert.equal(calls[0].starts_at, from.toISOString());
    assert.equal(calls[0].ends_at, until.toISOString());
    assert.equal(calls[0].code, issued.credentialValue);
    assert.equal(calls[0].prefer_native_scheduling, true);
  });

  test("revokeCredential deletes Seam access code", async () => {
    const deleted = [];
    setSeamClientForTests({
      accessCodes: {
        delete: async (payload) => {
          deleted.push(payload);
        },
      },
    });

    const result = await seamAdapter.revokeCredential(
      { external_lock_id: "device-uuid-1" },
      { externalCredentialId: "ac_test_1" }
    );

    assert.equal(result.ok, true);
    assert.deepEqual(deleted, [{ access_code_id: "ac_test_1" }]);
  });

  test("revokeCredential skips when external id missing", async () => {
    setSeamClientForTests({
      accessCodes: {
        delete: async () => {
          throw new Error("should_not_call");
        },
      },
    });

    const result = await seamAdapter.revokeCredential({}, {});
    assert.equal(result.skipped, true);
  });
});
