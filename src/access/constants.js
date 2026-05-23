/** @see docs/ACCESS_ENGINE_BUILD_PLAN.md */

const TERMINAL_RESERVATION_STATUSES = new Set([
  "CANCELLED",
  "COMPLETED",
  "NO_SHOW",
]);

const BLOCKING_RESERVATION_STATUSES = new Set([
  "REQUESTED",
  "PENDING_DEPOSIT",
  "PENDING_APPROVAL",
  "CONFIRMED",
  "ACTIVE",
]);

const RESERVATION_CHANNELS = new Set([
  "sms",
  "whatsapp",
  "telegram",
  "tenant_portal",
  "qr_portal",
  "portal",
  "staff_override",
]);

module.exports = {
  TERMINAL_RESERVATION_STATUSES,
  BLOCKING_RESERVATION_STATUSES,
  RESERVATION_CHANNELS,
};
