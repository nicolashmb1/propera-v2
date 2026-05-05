const test = require("node:test");
const assert = require("node:assert/strict");
const {
  resolveCanonicalBrainActorKey,
  canonicalForNonStaff,
} = require("../src/signal/resolveCanonicalBrainActorKey");

test("canonicalForNonStaff — preserves TG: for non-staff", () => {
  assert.equal(canonicalForNonStaff("TG:12345"), "TG:12345");
});

test("canonicalForNonStaff — normalizes US SMS", () => {
  assert.equal(canonicalForNonStaff("+1 (555) 123-4567"), "+15551234567");
});

test("resolveCanonicalBrainActorKey — staff: contact phone wins", async () => {
  const sb = {
    from(table) {
      if (table === "contacts") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { phone_e164: "+15551234000" },
              }),
            }),
          }),
        };
      }
      throw new Error("unexpected table " + table);
    },
  };
  const key = await resolveCanonicalBrainActorKey({
    sb,
    routerParameter: {},
    staffRow: { contact_id: "c1", staff_id: "s1" },
    transportActorKey: "TG:999888777",
    isStaff: true,
  });
  assert.equal(key, "+15551234000");
});

test("resolveCanonicalBrainActorKey — staff: STAFF:id when no contact phone", async () => {
  const sb = {
    from(table) {
      if (table === "contacts") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: null }),
            }),
          }),
        };
      }
      if (table === "telegram_chat_link") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: null }),
              order: () => ({
                limit: async () => ({ data: [] }),
              }),
            }),
            order: () => ({
              limit: async () => ({ data: [] }),
            }),
          }),
        };
      }
      throw new Error("unexpected table " + table);
    },
  };
  const key = await resolveCanonicalBrainActorKey({
    sb,
    routerParameter: {},
    staffRow: { staff_id: "staff-uuid-1" },
    transportActorKey: "TG:111",
    isStaff: true,
  });
  assert.equal(key, "STAFF:staff-uuid-1");
});

test("resolveCanonicalBrainActorKey — staff: telegram_chat_link by chat id", async () => {
  let chatQuery = false;
  const sb = {
    from(table) {
      if (table === "contacts") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: null }),
            }),
          }),
        };
      }
      if (table === "telegram_chat_link") {
        return {
          select: () => ({
            eq: (col, val) => {
              if (col === "telegram_chat_id") {
                chatQuery = val === "999";
                return {
                  maybeSingle: async () =>
                    chatQuery
                      ? { data: { phone_e164: "+15559998888" } }
                      : { data: null },
                };
              }
              if (col === "telegram_user_id") {
                return {
                  order: () => ({
                    limit: async () => ({ data: [], error: null }),
                  }),
                };
              }
              return {
                maybeSingle: async () => ({ data: null }),
                order: () => ({
                  limit: async () => ({ data: [] }),
                }),
              };
            },
            order: () => ({
              limit: async () => ({ data: [] }),
            }),
          }),
        };
      }
      throw new Error("unexpected table " + table);
    },
  };
  const key = await resolveCanonicalBrainActorKey({
    sb,
    routerParameter: { _telegramChatId: "999" },
    staffRow: { staff_id: "s1" },
    transportActorKey: "TG:1",
    isStaff: true,
  });
  assert.equal(key, "+15559998888");
});

test("resolveCanonicalBrainActorKey — same canonical for TG vs SMS (integration shape)", async () => {
  const sb = {
    from(table) {
      if (table === "contacts") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { phone_e164: "+15550001112" },
              }),
            }),
          }),
        };
      }
      throw new Error("unexpected table " + table);
    },
  };
  const staffRow = { contact_id: "cid", staff_id: "sid" };
  const a = await resolveCanonicalBrainActorKey({
    sb,
    routerParameter: {},
    staffRow,
    transportActorKey: "TG:305305305",
    isStaff: true,
  });
  const b = await resolveCanonicalBrainActorKey({
    sb,
    routerParameter: {},
    staffRow,
    transportActorKey: "+15550001112",
    isStaff: true,
  });
  assert.equal(a, "+15550001112");
  assert.equal(b, "+15550001112");
  assert.equal(a, b);
});
