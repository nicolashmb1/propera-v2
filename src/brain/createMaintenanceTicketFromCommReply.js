/**
 * Explicit seam for future Communication Engine → maintenance-brain handoff.
 * Intentionally thin and currently inert until the ticket seed contract is finalized.
 */
async function createMaintenanceTicketFromCommReply(_input) {
  return {
    ok: false,
    error: "not_implemented",
    ticketSeedId: null,
  };
}

module.exports = {
  createMaintenanceTicketFromCommReply,
};
