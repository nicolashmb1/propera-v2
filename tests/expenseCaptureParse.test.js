const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isExpenseCaptureMessage,
  stripExpenseMarker,
  extractHumanTicketIdAnywhere,
  parseAmountCents,
  parseVendorAndTenantAmounts,
  isAmbiguousAmountSplit,
  parseExpenseCaptureText,
} = require("../src/brain/staff/expenseCaptureParse");

test("isExpenseCaptureMessage — $$ prefix", () => {
  assert.equal(isExpenseCaptureMessage("$$ apt 205 westgrand 33.40 homedepot"), true);
  assert.equal(isExpenseCaptureMessage("apt 205 33.40"), false);
});

test("stripExpenseMarker", () => {
  assert.equal(
    stripExpenseMarker("$$ 33.40 dryer vent"),
    "33.40 dryer vent"
  );
});

test("extractHumanTicketIdAnywhere", () => {
  assert.equal(
    extractHumanTicketIdAnywhere("$$ PENN-031225-1234 75 plumber"),
    "PENN-031225-1234"
  );
});

test("parseVendorAndTenantAmounts — vendor only", () => {
  const a = parseVendorAndTenantAmounts("parts 33.40 homedepot duct vent");
  assert.equal(a.vendorAmountCents, 3340);
  assert.equal(a.tenantChargeAmountCents, null);
});

test("parseVendorAndTenantAmounts — dual amounts", () => {
  const a = parseVendorAndTenantAmounts(
    "parts 33 from homedepot tenant charge 100 for the service"
  );
  assert.equal(a.vendorAmountCents, 3300);
  assert.equal(a.tenantChargeAmountCents, 10000);
});

test("parseVendorAndTenantAmounts — tenant charged + door cost", () => {
  const a = parseVendorAndTenantAmounts(
    "tenant charged 180 dollars for door replacement door cost 80"
  );
  assert.equal(a.tenantChargeAmountCents, 18000);
  assert.equal(a.vendorAmountCents, 8000);
});

test("parseVendorAndTenantAmounts — tenant only", () => {
  const a = parseVendorAndTenantAmounts("tenant charge 180");
  assert.equal(a.tenantChargeAmountCents, 18000);
  assert.equal(a.vendorAmountCents, 0);
});

test("parseExpenseCaptureText — unit vendor parts", () => {
  const p = parseExpenseCaptureText("$$ apt 205 westgrand 33.40 homedepot duct vent");
  assert.equal(p.vendorAmountCents, 3340);
  assert.equal(p.amountCents, 3340);
  assert.equal(p.tenantChargeAmountCents, null);
  assert.equal(p.vendorName, "Home Depot");
  assert.equal(p.entryType, "parts");
});

test("parseExpenseCaptureText — explicit ticket id", () => {
  const p = parseExpenseCaptureText("$$ PENN-031225-1234 $75 service call");
  assert.equal(p.humanTicketId, "PENN-031225-1234");
  assert.equal(p.vendorAmountCents, 7500);
  assert.equal(p.entryType, "vendor_invoice");
});

test("parseExpenseCaptureText — tenant charge chip phrase", () => {
  const p = parseExpenseCaptureText("$$ parts 33 homedepot tenant charge 100");
  assert.equal(p.hasTenantCharge, true);
  assert.equal(p.tenantChargeAmountCents, 10000);
  assert.equal(p.vendorAmountCents, 3300);
});

test("parseExpenseCaptureText — photo receipt status", () => {
  const p = parseExpenseCaptureText("$$ 12.00 parts", { hasPhoto: true });
  assert.equal(p.receiptStatus, "PHOTO_ATTACHED");
});

test("isAmbiguousAmountSplit — two amounts, no tenant/vendor anchors", () => {
  assert.equal(isAmbiguousAmountSplit("33 and 33"), true);
  assert.equal(isAmbiguousAmountSplit("door 80, service 100"), true);
});

test("isAmbiguousAmountSplit — clear dual-amount anchors", () => {
  assert.equal(
    isAmbiguousAmountSplit("parts 33 from homedepot tenant charge 100 for the service"),
    false
  );
  assert.equal(
    isAmbiguousAmountSplit("tenant charged 180 dollars for door replacement door cost 80"),
    false
  );
});

test("parseExpenseCaptureText — flags ambiguous split", () => {
  const a = parseExpenseCaptureText("$$ 33 and 33");
  assert.equal(a.amountSplitAmbiguous, true);
  assert.equal(a.moneyTokenCount, 2);
  const b = parseExpenseCaptureText("$$ door 80, service 100");
  assert.equal(b.amountSplitAmbiguous, true);
  const c = parseExpenseCaptureText("$$ parts 33 homedepot tenant charge 100");
  assert.equal(c.amountSplitAmbiguous, false);
});
