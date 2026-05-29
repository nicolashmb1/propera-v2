const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveOperationalPolicy,
  POLICY_DEFAULTS,
} = require("../src/brain/policy/resolveOperationalPolicy");

test("resolveOperationalPolicy returns documented default when no rows", async () => {
  const fakeSb = {
    from() {
      return {
        select() {
          const chain = {
            in() {
              return chain;
            },
            then(resolve) {
              return Promise.resolve({ data: [], error: null }).then(resolve);
            },
          };
          return chain;
        },
      };
    },
  };
  const out = await resolveOperationalPolicy("conflict.monitoring_window_days", {
    property: "PENN",
    sb: fakeSb,
  });
  assert.equal(out.ok, true);
  assert.equal(out.value, POLICY_DEFAULTS["conflict.monitoring_window_days"]);
  assert.equal(out.defaulted, true);
});

test("resolveOperationalPolicy rejects missing key", async () => {
  const out = await resolveOperationalPolicy("", { sb: null });
  assert.equal(out.ok, false);
});
