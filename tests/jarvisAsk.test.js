const test = require("node:test");
const assert = require("node:assert/strict");
const { formatJarvisAskReply } = require("../src/agent/jarvisAsk/formatJarvisAskReply");
const { isPortalJarvisAskMode } = require("../src/agent/jarvisAsk/jarvisAskMode");
const { classifyJarvisIntent } = require("../src/agent/jarvisAsk/classifyJarvisIntent");
const {
  extractUnitHintFromQuestion,
  resolveTicketTargetFromQuestion,
} = require("../src/agent/jarvisAsk/resolveQuestionTargets");

test("formatJarvisAskReply empty question shows help", () => {
  const reply = formatJarvisAskReply({ scopeStory: "Property PENN." }, "");
  assert.match(reply, /Ask about/);
});

test("formatJarvisAskReply unit 423 — verdict and timeline, no open dump", () => {
  const reply = formatJarvisAskReply(
    {
      resolvedFromQuestion: true,
      intents: ["TICKET_DETAIL"],
      focusTicket: {
        humanTicketId: "PENN-051926-7149",
        unit: "423",
        property: "Penn",
        status: "Open",
        category: "Plumbing",
        messagePreview: "Leak under sink",
        assignee: "Mike",
        updatedAt: new Date(Date.now() - 86400000 * 2).toISOString(),
        timeline: [
          { action: "Assigned: Mike", by: "System", age: "1d ago" },
          { action: "Status: Waiting on vendor", by: "Mike", age: "2d ago" },
        ],
      },
      openTicketsAtProperty: [
        {
          humanTicketId: "PENN-051926-7149",
          unitLabel: "423",
          status: "Open",
          summary: "Plumbing",
        },
      ],
      activeWork: [],
    },
    "what is 423 ticket about?"
  );
  assert.match(reply, /Unit 423/);
  assert.match(reply, /PENN-051926-7149/);
  assert.match(reply, /Leak under sink/);
  assert.match(reply, /Recent activity/);
  assert.doesNotMatch(reply, /^Open tickets \(/m);
});

test("formatJarvisAskReply property situation brief", () => {
  const reply = formatJarvisAskReply(
    {
      propertySituation: {
        propertyCode: "PENN",
        name: "Penn",
        openTicketCount: 5,
        urgentTicketCount: 1,
        unitCount: 40,
        occupiedCount: 38,
        companyCentsMonth: 0,
        entryCountMonth: 0,
        companyCentsYtd: 0,
        entryCountYtd: 0,
        monthLabel: "current UTC month",
      },
      openTicketsAtProperty: [
        {
          humanTicketId: "PENN-1",
          unitLabel: "101",
          status: "Open",
          summary: "Heat",
        },
      ],
      activeWork: [],
    },
    "what's the situation at this property?"
  );
  assert.match(reply, /PENN/);
  assert.match(reply, /5 open/);
  assert.match(reply, /1 urgent/);
  assert.match(reply, /Open tickets/);
});

test("formatJarvisAskReply property maintenance spend", () => {
  const reply = formatJarvisAskReply(
    {
      intents: ["PROPERTY_SPEND"],
      propertySituation: {
        propertyCode: "PENN",
        monthLabel: "current UTC month",
        companyCentsMonth: 125000,
        tenantCentsMonth: 0,
        entryCountMonth: 4,
        companyCentsYtd: 890000,
        tenantCentsYtd: 0,
        entryCountYtd: 22,
      },
      openTicketsAtProperty: [],
      activeWork: [],
    },
    "how much maintenance cost on this property?"
  );
  assert.match(reply, /Maintenance spend/);
  assert.match(reply, /1250\.00/);
  assert.match(reply, /YTD/);
});

test("resolveTicketTargetFromQuestion matches unit 423", () => {
  const target = resolveTicketTargetFromQuestion(
    {
      anchor: { propertyCode: "PENN" },
      propertyOpenTickets: [
        {
          ticketRowId: "uuid-1",
          humanTicketId: "PENN-051926-7149",
          unitLabel: "423",
        },
        {
          ticketRowId: "uuid-2",
          humanTicketId: "PENN-051926-7150",
          unitLabel: "424",
        },
      ],
    },
    "what is 423 ticket about?"
  );
  assert.equal(target.reason, "QUESTION_UNIT_SINGLE");
  assert.equal(target.humanTicketId, "PENN-051926-7149");
});

test("classifyJarvisIntent", () => {
  const s = classifyJarvisIntent("what's the situation?");
  assert.ok(s.has("PROPERTY_SITUATION"));
  const spend = classifyJarvisIntent("maintenance spend this month");
  assert.ok(spend.has("PROPERTY_SPEND"));
});

test("extractUnitHintFromQuestion", () => {
  assert.equal(extractUnitHintFromQuestion("what is 423 ticket about?"), "423");
  assert.equal(extractUnitHintFromQuestion("unit 306 status"), "306");
});

test("isPortalJarvisAskMode", () => {
  assert.equal(isPortalJarvisAskMode({ _portalChatMode: "jarvis_ask" }), true);
  assert.equal(isPortalJarvisAskMode({ _portalChatMode: "normal" }), false);
});
