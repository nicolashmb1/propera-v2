/**
 * Route validated proposals to brain commit paths.
 */

const { getSupabase } = require("../../db/supabase");
const { PROPOSAL_OPS } = require("./types");
const { commitAttachTicketCost } = require("./attachTicketCost");
const { commitProposeVendorRequest } = require("./proposeVendorRequest");
const { commitAppendServiceNote } = require("./appendServiceNote");
const { commitCreateServiceRequest } = require("./createServiceRequest");
const { commitScheduleTicket } = require("./scheduleTicket");
const { commitBookAmenityReservation } = require("./bookAmenityReservation");
const { commitSetAmenitySchedule } = require("./setAmenitySchedule");
const { commitCancelAmenityReservation } = require("./cancelAmenityReservation");
const { commitUpdateAmenityPolicy } = require("./updateAmenityPolicy");
const { commitTicketLifecycle } = require("./ticketLifecycleOps");
const { commitSendCommunicationCampaign } = require("./sendCommunicationCampaign");

/**
 * @param {{ op: string, proposal_id: string, payload: object }} verified
 * @param {object} ctx
 */
async function commitProposal(verified, ctx) {
  const op = String(verified?.op || "").trim();
  const sb = getSupabase();
  if (!sb) {
    return {
      ok: false,
      brain: "jarvis_plan",
      replyText: "Database is not configured.",
    };
  }

  switch (op) {
    case PROPOSAL_OPS.ATTACH_TICKET_COST:
      return commitAttachTicketCost(sb, verified, ctx);
    case PROPOSAL_OPS.PROPOSE_VENDOR_REQUEST:
      return commitProposeVendorRequest(sb, verified, ctx);
    case PROPOSAL_OPS.APPEND_SERVICE_NOTE:
      return commitAppendServiceNote(sb, verified, ctx);
    case PROPOSAL_OPS.CREATE_SERVICE_REQUEST:
      return commitCreateServiceRequest(sb, verified, ctx);
    case PROPOSAL_OPS.SCHEDULE_TICKET:
      return commitScheduleTicket(sb, verified, ctx);
    case PROPOSAL_OPS.BOOK_AMENITY_RESERVATION:
      return commitBookAmenityReservation(sb, verified, ctx);
    case PROPOSAL_OPS.SET_AMENITY_SCHEDULE:
      return commitSetAmenitySchedule(sb, verified, ctx);
    case PROPOSAL_OPS.CANCEL_AMENITY_RESERVATION:
      return commitCancelAmenityReservation(sb, verified, ctx);
    case PROPOSAL_OPS.UPDATE_AMENITY_POLICY:
      return commitUpdateAmenityPolicy(sb, verified, ctx);
    case PROPOSAL_OPS.SET_TICKET_STATUS:
    case PROPOSAL_OPS.SET_TICKET_CATEGORY:
    case PROPOSAL_OPS.UPDATE_TICKET_ISSUE:
    case PROPOSAL_OPS.CLOSE_TICKET:
    case PROPOSAL_OPS.CANCEL_TICKET:
      return commitTicketLifecycle(sb, verified, ctx);
    case PROPOSAL_OPS.SEND_COMMUNICATION_CAMPAIGN:
      return commitSendCommunicationCampaign(sb, verified, ctx);
    default:
      return {
        ok: false,
        brain: "jarvis_plan",
        replyText: `Unknown proposal operation: ${op || "?"}`,
      };
  }
}

module.exports = { commitProposal };
