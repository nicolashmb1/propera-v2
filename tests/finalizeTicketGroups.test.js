const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const {
  reconcileFinalizeTicketRows,
  issueAtomFromProblemText,
  groupIssueAtomsIntoTicketGroups,
  pickStructuredIssuesForFinalizeAtoms,
  rawFromStructuredIssue,
} = require("../src/brain/core/finalizeTicketGroups");

describe("finalizeTicketGroups — GAS reconcileTicketGroupsForFinalize_ parity", () => {
  test("merged free text with periods but no structured issues → single fallback atom (not split by .)", () => {
    const merged =
      "#apt 205 Westgrand. Order and replace shower track master bathroom";
    const { rows } = reconcileFinalizeTicketRows({
      structuredIssues: null,
      mergedIssueText: merged,
      issueBufferLines: [],
      effectiveBody: merged,
    });
    assert.equal(rows.length, 1);
    assert.ok(rows[0].issueText.toLowerCase().includes("shower"));
  });

  test("pipe-separated merged text, no LLM issues → one combined ticket (no thin split)", () => {
    const { rows } = reconcileFinalizeTicketRows({
      structuredIssues: null,
      mergedIssueText:
        "kitchen sink is clogged | bedroom ac will not turn on",
      issueBufferLines: [],
      effectiveBody: "",
    });
    assert.equal(rows.length, 1);
    const t = rows[0].issueText.toLowerCase();
    assert.ok(t.includes("sink") && t.includes("ac"));
  });

  test("two structured rows with clear problems (AC + ice maker) → two tickets", () => {
    const { rows } = reconcileFinalizeTicketRows({
      structuredIssues: [
        {
          summary: "AC not working",
          tenantDescription: "",
          category: "HVAC",
          locationType: "UNIT",
          urgency: "normal",
        },
        {
          summary: "Ice maker not working",
          tenantDescription: "",
          category: "Appliance",
          locationType: "UNIT",
          urgency: "normal",
        },
      ],
      mergedIssueText:
        "#apt 305 westgrand icemaker and ac not working",
      issueBufferLines: [],
      effectiveBody: "",
    });
    assert.equal(rows.length, 2);
    const joined = rows.map((r) => r.issueText.toLowerCase()).join(" ");
    assert.ok(joined.includes("ice") && joined.includes("ac"));
  });

  test("structured category + fixture counts when shared symptom is omitted from one issue title", () => {
    const { rows } = reconcileFinalizeTicketRows({
      structuredIssues: [
        {
          summary: "AC not working",
          tenantDescription: "",
          category: "HVAC",
          locationType: "UNIT",
          urgency: "normal",
        },
        {
          summary: "Ice maker",
          tenantDescription: "",
          category: "Appliance",
          locationType: "UNIT",
          urgency: "normal",
        },
      ],
      mergedIssueText:
        "#apt 305 westgrand icemaker and ac not working",
      issueBufferLines: [],
      effectiveBody: "",
    });
    assert.equal(rows.length, 2);
  });

  test("two clear structured issues ignore fallback pipe/buffer atoms → no third junk ticket", () => {
    const { rows } = reconcileFinalizeTicketRows({
      structuredIssues: [
        {
          summary: "AC not working",
          tenantDescription: "",
          category: "HVAC",
          locationType: "UNIT",
          urgency: "normal",
        },
        {
          summary: "Ice maker not working",
          tenantDescription: "",
          category: "Appliance",
          locationType: "UNIT",
          urgency: "normal",
        },
      ],
      mergedIssueText:
        "Westgrand 305 | AC not working | Ice maker not working | call tenant",
      issueBufferLines: ["Westgrand 305", "call tenant"],
      effectiveBody: "",
    });
    assert.equal(rows.length, 2);
    const joined = rows.map((r) => r.issueText.toLowerCase()).join(" ");
    assert.ok(!joined.includes("westgrand"));
    assert.ok(!joined.includes("call tenant"));
  });

  test("bad split: address/unit-only row + real problem → one ticket (problem row only; no junk ticket)", () => {
    const { rows } = reconcileFinalizeTicketRows({
      structuredIssues: [
        {
          summary: "Westgrand 205",
          tenantDescription: "",
          category: "General",
          locationType: "UNIT",
          urgency: "normal",
        },
        {
          summary: "Ice maker not working",
          tenantDescription: "",
          category: "Appliance",
          locationType: "UNIT",
          urgency: "normal",
        },
      ],
      mergedIssueText: "Westgrand 205 | Ice maker not working",
      issueBufferLines: [],
      effectiveBody: "",
    });
    assert.equal(rows.length, 1);
    assert.ok(rows[0].issueText.toLowerCase().includes("ice"));
    assert.ok(!rows[0].issueText.toLowerCase().includes("westgrand"));
  });

  test("two structured rows without clear problem signals → collapse to one ticket", () => {
    const { rows } = reconcileFinalizeTicketRows({
      structuredIssues: [
        {
          summary: "follow up item one",
          tenantDescription: "",
          category: "General",
          locationType: "UNIT",
          urgency: "normal",
        },
        {
          summary: "follow up item two",
          tenantDescription: "",
          category: "General",
          locationType: "UNIT",
          urgency: "normal",
        },
      ],
      mergedIssueText: "follow up item one | follow up item two",
      issueBufferLines: [],
      effectiveBody: "",
    });
    assert.equal(rows.length, 1);
  });
});

describe("pickStructuredIssuesForFinalizeAtoms", () => {
  test("≥2 rows with hasProblemSignal → keep those rows and allow multi", () => {
    const { issues, allowMultiFinalizeTickets } = pickStructuredIssuesForFinalizeAtoms([
      { summary: "AC not working", tenantDescription: "" },
      { summary: "Ice maker not working", tenantDescription: "" },
    ]);
    assert.equal(issues.length, 2);
    assert.equal(allowMultiFinalizeTickets, true);
  });

  test("one problem row + one metadata row → problem row only, no multi", () => {
    const { issues, allowMultiFinalizeTickets } = pickStructuredIssuesForFinalizeAtoms([
      { summary: "Westgrand apt 205", tenantDescription: "" },
      { summary: "Ice maker not working", tenantDescription: "" },
    ]);
    assert.equal(issues.length, 1);
    assert.equal(rawFromStructuredIssue(issues[0]).toLowerCase().includes("ice"), true);
    assert.equal(allowMultiFinalizeTickets, false);
  });

  test("single row → unchanged", () => {
    const one = [{ summary: "Leak under sink", tenantDescription: "" }];
    const { issues, allowMultiFinalizeTickets } =
      pickStructuredIssuesForFinalizeAtoms(one);
    assert.deepEqual(issues, one);
    assert.equal(allowMultiFinalizeTickets, false);
  });
});

describe("finalizeTicketGroups — helpers", () => {
  test("issueAtomFromProblemText rejects schedule-only lines", () => {
    assert.equal(issueAtomFromProblemText("tomorrow morning 9-11am", "t"), null);
  });

  test("groupIssueAtomsIntoTicketGroups merges same trade+fixture+fault into one ticket body", () => {
    const a = issueAtomFromProblemText("kitchen sink clogged", "x");
    const b = issueAtomFromProblemText("bathroom sink slow drain", "y");
    const groups = groupIssueAtomsIntoTicketGroups([a, b]);
    assert.ok(groups.length >= 1);
  });
});
