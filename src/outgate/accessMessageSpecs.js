/**
 * Access message specs and deterministic copy builder for amenity lifecycle.
 */

const ACCESS_MESSAGE_SPECS = {
  ACCESS_TENANT_RESERVATION_CONFIRMED: {
    templateKey: "ACCESS_TENANT_RESERVATION_CONFIRMED",
    audience: "tenant",
    channelHint: "short",
    fallbackText: "Your access reservation is confirmed.",
  },
  ACCESS_TENANT_APPROVAL_REQUIRED: {
    templateKey: "ACCESS_TENANT_APPROVAL_REQUIRED",
    audience: "tenant",
    channelHint: "short",
    fallbackText: "Your access request is pending approval.",
  },
  ACCESS_TENANT_APPROVED: {
    templateKey: "ACCESS_TENANT_APPROVED",
    audience: "tenant",
    channelHint: "short",
    fallbackText: "Your access request was approved.",
  },
  ACCESS_TENANT_DENIED: {
    templateKey: "ACCESS_TENANT_DENIED",
    audience: "tenant",
    channelHint: "short",
    fallbackText: "Your access request was not approved.",
  },
  ACCESS_TENANT_REMINDER: {
    templateKey: "ACCESS_TENANT_REMINDER",
    audience: "tenant",
    channelHint: "short",
    fallbackText: "Reminder: your access reservation starts soon.",
  },
  ACCESS_TENANT_ACTIVE: {
    templateKey: "ACCESS_TENANT_ACTIVE",
    audience: "tenant",
    channelHint: "short",
    fallbackText: "Your access reservation is now active.",
  },
  ACCESS_TENANT_CANCELLED: {
    templateKey: "ACCESS_TENANT_CANCELLED",
    audience: "tenant",
    channelHint: "short",
    fallbackText: "Your access reservation was cancelled.",
  },
  ACCESS_TENANT_COMPLETED: {
    templateKey: "ACCESS_TENANT_COMPLETED",
    audience: "tenant",
    channelHint: "short",
    fallbackText: "Your access reservation has ended.",
  },
  ACCESS_STAFF_APPROVAL_REQUIRED: {
    templateKey: "ACCESS_STAFF_APPROVAL_REQUIRED",
    audience: "staff",
    channelHint: "short",
    fallbackText: "An access reservation needs approval.",
  },
  ACCESS_STAFF_NEW_RESERVATION: {
    templateKey: "ACCESS_STAFF_NEW_RESERVATION",
    audience: "staff",
    channelHint: "short",
    fallbackText: "A new access reservation was created.",
  },
  ACCESS_STAFF_CANCELLED: {
    templateKey: "ACCESS_STAFF_CANCELLED",
    audience: "staff",
    channelHint: "short",
    fallbackText: "An access reservation was cancelled.",
  },
  ACCESS_STAFF_REMINDER: {
    templateKey: "ACCESS_STAFF_REMINDER",
    audience: "staff",
    channelHint: "short",
    fallbackText: "Reminder: an access reservation window is opening soon.",
  },
};

function getAccessMessageSpec(templateKey) {
  const key = String(templateKey || "").trim();
  return ACCESS_MESSAGE_SPECS[key] || null;
}

function formatTime(date, timeZone) {
  const d = date instanceof Date ? date : new Date(date);
  if (!Number.isFinite(d.getTime())) return "";
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timeZone || "UTC",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(d);
  } catch (_) {
    return d.toISOString();
  }
}

function buildWindowLabel(ctx) {
  const startLabel = formatTime(ctx.startAt, ctx.timeZone);
  const endDate = new Date(ctx.endAt);
  if (!startLabel || !Number.isFinite(endDate.getTime())) return "";
  try {
    const endLabel = new Intl.DateTimeFormat("en-US", {
      timeZone: ctx.timeZone || "UTC",
      hour: "numeric",
      minute: "2-digit",
    }).format(endDate);
    return `${startLabel} to ${endLabel}`;
  } catch (_) {
    return `${startLabel} to ${endDate.toISOString()}`;
  }
}

function pinLine(ctx) {
  const pin = String(ctx.pin || "").trim();
  if (!pin) return "";
  return ` PIN: ${pin}.`;
}

function residentLabel(ctx) {
  const name = String(ctx.tenantName || "").trim();
  const unit = String(ctx.unitLabel || "").trim();
  if (name && unit) return `${name} (unit ${unit})`;
  if (name) return name;
  if (unit) return `unit ${unit}`;
  return "resident";
}

function buildAccessMessageText(templateKey, ctx) {
  const spec = getAccessMessageSpec(templateKey);
  if (!spec) return "";

  const locationName = String(ctx.locationName || "the amenity").trim();
  const windowLabel = buildWindowLabel(ctx);
  const untilLabel = formatTime(ctx.endAt, ctx.timeZone);
  const tenantLabel = residentLabel(ctx);

  switch (templateKey) {
    case "ACCESS_TENANT_RESERVATION_CONFIRMED":
      return `Your ${locationName} reservation is confirmed for ${windowLabel}.${pinLine(ctx)}`.trim();
    case "ACCESS_TENANT_APPROVAL_REQUIRED":
      return `Your ${locationName} request for ${windowLabel} is pending approval. We will follow up once the team reviews it.`;
    case "ACCESS_TENANT_APPROVED":
      return `Your ${locationName} request was approved for ${windowLabel}.${pinLine(ctx)}`.trim();
    case "ACCESS_TENANT_DENIED":
      return `Your ${locationName} request for ${windowLabel} was not approved and has been cancelled.`;
    case "ACCESS_TENANT_REMINDER":
      return `Reminder: your ${locationName} reservation starts at ${formatTime(
        ctx.startAt,
        ctx.timeZone
      )}.${pinLine(ctx)}`.trim();
    case "ACCESS_TENANT_ACTIVE":
      return `Your ${locationName} reservation is now active until ${untilLabel}.${pinLine(ctx)}`.trim();
    case "ACCESS_TENANT_CANCELLED":
      return `Your ${locationName} reservation for ${windowLabel} has been cancelled.`;
    case "ACCESS_TENANT_COMPLETED":
      return `Your ${locationName} reservation ended at ${untilLabel}. Your pass is no longer active.`;
    case "ACCESS_STAFF_APPROVAL_REQUIRED":
      return `Approval needed: ${tenantLabel} requested ${locationName} for ${windowLabel}.`;
    case "ACCESS_STAFF_NEW_RESERVATION":
      return `New reservation: ${tenantLabel} booked ${locationName} for ${windowLabel}.`;
    case "ACCESS_STAFF_CANCELLED":
      return `Cancelled reservation: ${tenantLabel} cancelled ${locationName} for ${windowLabel}.`;
    case "ACCESS_STAFF_REMINDER":
      return `Reminder: ${tenantLabel} has ${locationName} starting at ${formatTime(
        ctx.startAt,
        ctx.timeZone
      )}.`;
    default:
      return String(spec.fallbackText || "").trim();
  }
}

module.exports = {
  ACCESS_MESSAGE_SPECS,
  getAccessMessageSpec,
  buildAccessMessageText,
  buildWindowLabel,
};
