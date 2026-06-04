const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  formatDisambiguationSpeak,
  formatResolvedTicketSpeak,
  formatCandidateLine,
  formatTicketChoicePhrase,
} = require("../../src/voice/ticketDisambiguationSpeak");

describe("ticketDisambiguationSpeak", () => {
  it("disambiguates by issue not ticket id", () => {
    const speak = formatDisambiguationSpeak([
      { issue: "shower clogged", unitLabel: "303" },
      { issue: "microwave not working", unitLabel: "303" },
    ]);
    assert.match(speak, /shower clogged/i);
    assert.match(speak, /microwave/i);
    assert.doesNotMatch(speak, /PENN-/);
  });

  it("single match confirms with issue phrase", () => {
    const speak = formatDisambiguationSpeak([{ issue: "sink clogged", unitLabel: "303" }]);
    assert.match(speak, /sink clogged/i);
    assert.doesNotMatch(speak, /PENN-/);
  });

  it("formatResolvedTicketSpeak uses unit and issue", () => {
    const speak = formatResolvedTicketSpeak({
      unitLabel: "303",
      propertyCode: "PENN",
      issue: "shower clogged",
    });
    assert.match(speak, /unit 303/i);
    assert.match(speak, /PENN/i);
    assert.match(speak, /shower clogged/i);
    assert.doesNotMatch(speak, /PENN-\d/);
  });

  it("formatCandidateLine puts issue first with id secondary", () => {
    const line = formatCandidateLine(
      {
        humanTicketId: "PENN-060126-0042",
        issue: "dishwasher leaking",
        unitLabel: "303",
        ageDays: 2,
      },
      0
    );
    assert.match(line, /^1\. dishwasher leaking/);
    assert.match(line, /PENN-060126-0042/);
  });

  it("formatTicketChoicePhrase reads naturally", () => {
    assert.equal(
      formatTicketChoicePhrase({ issue: "shower clogged" }),
      "the one for shower clogged"
    );
  });
});
