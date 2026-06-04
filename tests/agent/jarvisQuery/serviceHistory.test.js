const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { parseServiceHistoryQuestion } = require("../../../src/agent/jarvisQuery/parseServiceHistoryQuestion");
const {
  ticketMatchesKeywords,
  ticketSearchText,
} = require("../../../src/agent/jarvisQuery/queryServiceHistory");
const { expandIssueKeywords } = require("../../../src/agent/jarvisQuery/issueKeywordSynonyms");
const { formatServiceHistoryReply } = require("../../../src/agent/jarvisQuery/formatServiceHistoryReply");
const { classifyJarvisIntent } = require("../../../src/agent/jarvisAsk/classifyJarvisIntent");
const { analyzeUnitsFromTickets } = require("../../../src/agent/jarvisQuery/analyzeServiceHistoryUnits");
const { parseServiceHistoryAnalysis } = require("../../../src/agent/jarvisQuery/parseServiceHistoryAnalysis");

describe("analyzeUnitsFromTickets", () => {
  it("counts distinct units and repeats", () => {
    const ua = analyzeUnitsFromTickets([
      { propertyCode: "PENN", unitLabel: "502", humanTicketId: "A" },
      { propertyCode: "PENN", unitLabel: "502", humanTicketId: "B" },
      { propertyCode: "PENN", unitLabel: "303", humanTicketId: "C" },
    ]);
    assert.equal(ua.totalTickets, 3);
    assert.equal(ua.distinctUnitCount, 2);
    assert.equal(ua.repeatUnitCount, 1);
    assert.equal(ua.repeatUnits[0].count, 2);
  });
});

describe("parseServiceHistoryAnalysis", () => {
  it("detects distinct units question", () => {
    assert.equal(
      parseServiceHistoryAnalysis("how many different units had refrigerator issues"),
      "distinct_units"
    );
  });

  it("detects repeat units question", () => {
    assert.equal(
      parseServiceHistoryAnalysis("how many units had repeat refrigerator problems"),
      "repeat_units"
    );
  });
});

describe("formatServiceHistoryReply analysis modes", () => {
  it("formats distinct units", () => {
    const text = formatServiceHistoryReply({
      ok: true,
      count: 5,
      daysBack: 30,
      issueLabel: "refrigerator",
      analysisMode: "distinct_units",
      unitAnalysis: {
        distinctUnitCount: 4,
        repeatUnitCount: 1,
        unitBreakdown: [],
      },
    });
    assert.match(text, /span 4 different units/);
  });

  it("formats repeat units", () => {
    const text = formatServiceHistoryReply({
      ok: true,
      count: 4,
      daysBack: 30,
      issueLabel: "refrigerator",
      analysisMode: "repeat_units",
      unitAnalysis: {
        distinctUnitCount: 2,
        repeatUnitCount: 1,
        repeatUnits: [{ propertyCode: "PENN", unitLabel: "502", count: 3 }],
      },
    });
    assert.match(text, /1 unit.*repeat/i);
    assert.match(text, /502/);
  });
});

describe("parseServiceHistoryQuestion", () => {
  it("parses refrigerator last 30 days", () => {
    const p = parseServiceHistoryQuestion(
      "how many refrigerator issues we had last 30 days"
    );
    assert.ok(p);
    assert.equal(p.daysBack, 30);
    assert.ok(p.keywords.includes("refrigerator") || p.keywords.includes("fridge"));
  });

  it("parses property filter", () => {
    const p = parseServiceHistoryQuestion("how many dishwasher tickets last 14 days at PENN");
    assert.ok(p);
    assert.equal(p.daysBack, 14);
    assert.equal(p.propertyCode, "PENN");
  });
});

describe("ticketMatchesKeywords", () => {
  it("matches category and message text", () => {
    const row = {
      category_final: "Appliance",
      category: "General",
      message_raw: "Refrigerator not cooling",
      service_notes: "",
    };
    assert.equal(ticketMatchesKeywords(row, ["refrigerator"]), true);
    assert.equal(ticketMatchesKeywords(row, ["dishwasher"]), false);
    assert.equal(ticketSearchText(row).includes("refrigerator"), true);
  });

  it("expandIssueKeywords includes fridge synonyms", () => {
    const kws = expandIssueKeywords("refrigerator");
    assert.ok(kws.includes("fridge"));
  });
});

describe("formatServiceHistoryReply", () => {
  it("formats count and scope", () => {
    const text = formatServiceHistoryReply({
      ok: true,
      count: 3,
      daysBack: 30,
      issueLabel: "refrigerator",
      tickets: [{ humanTicketId: "PENN-1", propertyCode: "PENN", unitLabel: "502" }],
    });
    assert.match(text, /3 refrigerator/);
    assert.match(text, /30 days/);
    assert.match(text, /PENN-1/);
  });
});

describe("classifyJarvisIntent SERVICE_HISTORY", () => {
  it("tags historical count questions", () => {
    const intents = classifyJarvisIntent("how many refrigerator issues last 30 days");
    assert.ok(intents.has("SERVICE_HISTORY"));
  });
});
