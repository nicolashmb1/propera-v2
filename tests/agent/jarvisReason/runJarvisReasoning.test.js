"use strict";

process.env.PROPERA_TEST_INJECT_SB = "1";
process.env.JARVIS_REASON_MAX_STEPS = "2";

const { test, describe, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const {
  setSupabaseClientForTests,
  clearSupabaseClientForTests,
} = require("../../../src/db/supabase");
const {
  runJarvisReasoning,
  setReasonChatForTests,
  clearReasonChatForTests,
} = require("../../../src/agent/jarvisReason");

// Same minimal chainable Supabase stub used by ticketLookupTool tests.
function makeSb(rows) {
  return {
    from() {
      const eqs = [];
      const builder = {
        select: () => builder,
        eq: (c, v) => (eqs.push([c, v]), builder),
        gte: () => builder,
        order: () => builder,
        limit: () => builder,
        then(resolve) {
          let out = rows.slice();
          for (const [c, v] of eqs) out = out.filter((r) => String(r[c]) === String(v));
          resolve({ data: out, error: null });
        },
      };
      return builder;
    },
  };
}

function seedPenn() {
  return [
    { ticket_row_id: "r1", ticket_id: "PENN-1", property_code: "PENN", status: "Open", category_final: "Plumbing", priority: "urgent", message_raw: "leak", created_at: "2026-05-01T00:00:00Z", updated_at: "2026-06-01T00:00:00Z" },
    { ticket_row_id: "r2", ticket_id: "PENN-2", property_code: "PENN", status: "Open", category_final: "HVAC", priority: "high", message_raw: "ac", created_at: "2026-05-02T00:00:00Z", updated_at: "2026-06-02T00:00:00Z" },
    { ticket_row_id: "r3", ticket_id: "PENN-3", property_code: "PENN", status: "Completed", category_final: "Plumbing", priority: "normal", message_raw: "drip", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-06-03T00:00:00Z" },
  ];
}

function toolCallMessage(args) {
  return {
    ok: true,
    data: {
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "lookup_tickets", arguments: JSON.stringify(args) },
              },
            ],
          },
        },
      ],
    },
  };
}

function finalMessage(text) {
  return { ok: true, data: { choices: [{ message: { role: "assistant", content: text } }] } };
}

describe("runJarvisReasoning", () => {
  afterEach(() => {
    clearReasonChatForTests();
    clearSupabaseClientForTests();
  });

  test("executes a tool call, feeds results back, then answers", async () => {
    setSupabaseClientForTests(makeSb(seedPenn()));
    let turn = 0;
    let sawToolResult = false;
    setReasonChatForTests((body) => {
      turn += 1;
      if (turn === 1) return toolCallMessage({ propertyCode: "PENN", status: "open" });
      // second turn: the tool result must be present in the message history
      sawToolResult = body.messages.some((m) => m.role === "tool");
      return finalMessage("Penn has 2 open tickets.");
    });

    const res = await runJarvisReasoning({
      question: "what's going on at penn?",
      scope: { story: "Property PENN.", anchor: { propertyCode: "PENN" } },
    });

    assert.equal(res.ok, true);
    assert.equal(res.reply, "Penn has 2 open tickets.");
    assert.equal(res.steps, 2);
    assert.equal(sawToolResult, true);
    assert.equal(res.trace.length, 1);
    assert.equal(res.trace[0].tool, "lookup_tickets");
    assert.equal(res.trace[0].total, 2); // 2 open PENN tickets
  });

  test("different question drives a different lookup (not a canned answer)", async () => {
    setSupabaseClientForTests(makeSb(seedPenn()));
    let captured = null;
    let turn = 0;
    setReasonChatForTests((body) => {
      turn += 1;
      if (turn === 1)
        return toolCallMessage({
          propertyCode: "PENN",
          priorityIn: ["urgent", "high"],
          status: "any",
          groupBy: "category",
          countOnly: true,
        });
      captured = body;
      return finalMessage("Two emergencies: 1 plumbing, 1 hvac.");
    });

    const res = await runJarvisReasoning({ question: "why so many emergencies at penn?" });
    assert.equal(res.ok, true);
    assert.equal(res.trace[0].total, 2);
    // the breakdown made it into the tool result fed back to the model
    const toolMsg = captured.messages.find((m) => m.role === "tool");
    assert.match(toolMsg.content, /"breakdown"/);
  });

  test("exhausting max steps still forces a grounded summary", async () => {
    setSupabaseClientForTests(makeSb(seedPenn()));
    setReasonChatForTests((body) => {
      if (body.tool_choice === "none") return finalMessage("Here is what I found so far.");
      return toolCallMessage({ propertyCode: "PENN", status: "open" });
    });

    const res = await runJarvisReasoning({ question: "tell me everything" });
    assert.equal(res.ok, true);
    assert.equal(res.exhausted, true);
    assert.equal(res.trace.length, 2); // one tool call per step, max 2 steps
  });

  test("no api key and no test seam degrades gracefully", async () => {
    clearReasonChatForTests();
    delete process.env.OPENAI_API_KEY;
    const res = await runJarvisReasoning({ question: "anything" });
    assert.equal(res.ok, false);
    assert.equal(res.err, "no_api_key");
  });
});
