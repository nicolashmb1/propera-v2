const test = require("node:test");
const assert = require("node:assert/strict");

test("commitSendCommunicationCampaign — sends via comm engine", async (t) => {
  const sendPath = require.resolve("../src/communication/campaignService");
  const original = require(sendPath);

  t.mock.method(original, "sendCampaignNow", async () => ({
    ok: true,
    campaign: { id: "camp-1", status: "SENT", totalSent: 12, totalFailed: 0 },
    send: { status: "SENT", sent: 12, failed: 0 },
  }));

  delete require.cache[require.resolve("../src/agent/proposals/sendCommunicationCampaign")];
  const { commitSendCommunicationCampaign } = require("../src/agent/proposals/sendCommunicationCampaign");

  const run = await commitSendCommunicationCampaign(null, {
    op: "send_communication_campaign",
    proposal_id: "prop-1",
    payload: { campaign_id: "camp-1" },
  }, { traceId: "t1" });

  assert.equal(run.ok, true);
  assert.match(run.replyText, /Broadcast sent to 12 tenants/);
  assert.equal(run.resolution.campaign_id, "camp-1");

  t.mock.restoreAll();
});

test("buildSendCommunicationCampaignProposal — token round-trip fields", () => {
  const {
    buildSendCommunicationCampaignProposal,
  } = require("../src/agent/proposals/sendCommunicationCampaign");
  const { verifyProposalConfirmToken } = require("../src/agent/proposals/proposalToken");

  const { proposal, confirmToken } = buildSendCommunicationCampaignProposal(
    {
      campaignId: "camp-abc",
      title: "Parking notice",
      brief: "remove belongings",
      commType: "POLICY_REMINDER",
      audienceKind: "PROPERTY",
      audienceFilter: { property_codes: ["PENN"] },
      messageBody: "Please clear parking spots.",
      audienceLabel: "Residents at Penn",
      willSend: 40,
      finalMessagePreview: "Please clear parking spots.\n\nReply STOP to opt out.",
      smsSegments: 1,
    },
    "Send tenant broadcast — Residents at Penn · 40 recipients"
  );

  assert.equal(proposal.op, "send_communication_campaign");
  assert.ok(confirmToken);

  const verified = verifyProposalConfirmToken(confirmToken);
  assert.ok(verified);
  assert.equal(verified.payload.campaign_id || verified.payload.campaignId, "camp-abc");
  assert.equal(verified.payload.will_send ?? verified.payload.willSend, 40);
});
