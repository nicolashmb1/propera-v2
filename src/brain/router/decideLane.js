/**
 * Lane classification — GAS classifyLane_ / decideLane_
 * @see 15_GATEWAY_WEBHOOK.gs ~566–602
 */
const {
  isManagerActorKey,
  isVendorActorKey,
} = require("../../config/lanePolicy");

function classifyLane(inbound) {
  const actorId = String((inbound && inbound.actorId) || "");
  let lane = "tenantLane";
  let reason = "default";

  if (isVendorActorKey(actorId)) {
    lane = "vendorLane";
    reason = "isVendor_";
  } else if (isManagerActorKey(actorId)) {
    lane = "managerLane";
    reason = "isManager_";
  } else if (String((inbound && inbound.meta && inbound.meta.source) || "") === "aiq") {
    lane = "systemLane";
    reason = "aiq_source";
  }

  const mode =
    lane === "vendorLane"
      ? "VENDOR"
      : lane === "managerLane"
        ? "MANAGER"
        : lane === "systemLane"
          ? "SYSTEM"
          : "TENANT";

  return { lane, reason, mode };
}

function decideLane(inbound) {
  const c = classifyLane(inbound);
  return {
    lane: c.lane,
    reason: c.reason,
    mode: c.mode,
    trace: "lane_v1",
  };
}

module.exports = { classifyLane, decideLane };
