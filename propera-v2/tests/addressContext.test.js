const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isAddressInContext_,
  isBlockedAsAddress_,
} = require("../src/brain/gas/addressContext");

test("isAddressInContext_ — GAS examples: 618 westfield", () => {
  const addr = {
    num: "618",
    hints: ["westfield"],
    suffixes: ["ave"],
  };
  assert.equal(
    isAddressInContext_("leaking at 618 westfield ave", addr),
    true
  );
});
