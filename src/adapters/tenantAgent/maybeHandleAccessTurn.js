const { appendEventLog } = require("../../dal/appendEventLog");
const { appendMessage, saveTenantConversation } = require("./conversationStore");
const { listTenantAccessLocations } = require("../../tenant/tenantAccessService");
const {
  ACCESS_INTENT_TYPES,
  inferAccessIntent,
  parseAccessWindow,
} = require("../../access/parseAccessIntent");
const { resolveInboundTenantContext } = require("../../access/handleAccessInbound");
const { tenantAgentLlmEnabled, openaiApiKey } = require("../../config/env");
const { runAccessAgentLlmTurn } = require("./accessAgentLlmTurn");
const { mergeAccessPartialFromLlm } = require("./mergeAccessPartialFromLlm");
const {
  shouldRouteToAccessTurn,
  supplementAccessLocationAndDay,
  supplementAccessPartialDeterministic,
  alignAccessWindowToDateForDay,
  stampAccessLane,
} = require("./accessGatherRules");
const {
  isAvailabilityQuestion,
  shouldConfirmReserveHandoff,
  affirmativeMeansListSlots,
  applyListSlotsIntent,
  isAccessBookingCorrection,
  extractDateForDayFromText,
  hasRecentAccessBooking,
  bodyHasAccessTimeIntent,
} = require("./accessConversationSignals");
const { isAccessLaneAckOnly } = require("./conversationLane");
const { propertyTimezone } = require("../../access/accessLocalTime");
const { buildAccessDeterministicReply } = require("./accessDeterministicReply");
const {
  mapIntentToAccessType,
  buildAccessHandoffPayload,
  finalizeAccessPartialForHandoff,
  shouldHandoffAccess,
} = require("./finalizeAccessGather");
const {
  clearAccessLane,
  readAccessRequest,
  readAccessLastBooking,
  readAccessLastError,
  accessWindowsMatch,
} = require("./conversationState");

/**
 * LLM-signalled lane close — tenant is done with amenity topic.
 * Saves a closing reply and clears the access lane.
 */
async function finalizeAccessClose(o) {
  const conv = o.conv || null;
  const bodyText = String(o.bodyText || "").trim();
  const replyText = String(o.replyText || "All set — talk soon.").trim();
  const turnCount = conv ? Number(conv.turn_count || 0) + 1 : 1;

  const messages = appendMessage(
    appendMessage(conv || { messages: [] }, "user", bodyText),
    "assistant",
    replyText
  );

  const partial = clearAccessLane(conv?.partial_package);

  const saved = await saveTenantConversation({
    ...(conv || {}),
    tenant_actor_key: o.tenantActorKey,
    transport_channel: o.transportChannel,
    status: "gathering",
    partial_package: partial,
    messages: messages.messages || messages,
    turn_count: turnCount,
    tenant_locale: conv?.tenant_locale || "en",
  });

  return {
    handled: true,
    phase: "gather",
    replyText,
    conversationId: saved?.id || conv?.id || "",
    tenantLocale: saved?.tenant_locale || conv?.tenant_locale || "en",
  };
}

/**
 * LLM-signalled cross-lane switch to maintenance. Clears access lane state
 * (in memory AND on disk) so the rest of `runTenantAgentTurn` processes the
 * inbound text fresh through the maintenance gather path.
 */
async function finalizeAccessSwitchToMaintenance(o) {
  const conv = o.conv || null;
  if (!conv) return;

  const partial = clearAccessLane(conv.partial_package);
  conv.partial_package = partial;

  await saveTenantConversation({
    ...conv,
    tenant_actor_key: o.tenantActorKey,
    transport_channel: o.transportChannel,
    status: "gathering",
    partial_package: partial,
    messages: conv.messages || [],
    turn_count: Number(conv.turn_count || 0),
    tenant_locale: conv.tenant_locale || "en",
  });

  await appendEventLog({
    traceId: String(o.traceId || "").trim(),
    log_kind: "tenant_agent",
    event: "TENANT_AGENT_ACCESS_LANE_SWITCH",
    payload: {
      conversation_id: conv.id || null,
      tenant_actor_key: String(o.tenantActorKey || "").trim(),
      to: "maintenance",
      inbound_preview: String(o.bodyText || "").slice(0, 120),
    },
  });
}

async function maybeHandleAccessTurn(o) {
  const bodyText = String(o.bodyText || "").trim();
  if (!bodyText) return null;

  const conv = o.conv || null;
  const lockedLane = o.lockedLane === true;
  if (!lockedLane && !shouldRouteToAccessTurn(conv, bodyText)) return null;

  const existing = readAccessRequest(conv?.partial_package) || {};
  const lastBooking = readAccessLastBooking(conv?.partial_package);
  const lastAccessError = readAccessLastError(conv?.partial_package);

  const ctx = await resolveInboundTenantContext(o.routerParameter || {});
  if (!ctx.matched || !ctx.tenantCtx) {
    // First-turn access detection with no resident match — defer to maintenance deflect.
    // Only emit the access-specific fallback when we're already inside an access lane.
    if (!lockedLane) return null;
    return {
      handled: true,
      phase: "gather",
      replyText:
        "I can help with amenity access once I can match your resident record. Please use the resident portal amenities page for now.",
      conversationId: conv?.id || "",
      tenantLocale: conv?.tenant_locale || "en",
    };
  }

  const locations = await listTenantAccessLocations({
    tenantId: ctx.tenantCtx.tenantId,
    propertyCode: ctx.tenantCtx.propertyCode,
  });

  // No access amenities configured for this property — defer to maintenance-only deflect.
  // Only bail when we have NO prior access state at all (no in-flight request, no last booking).
  if (
    (!locations || locations.length === 0) &&
    !lockedLane &&
    !readAccessRequest(conv?.partial_package) &&
    !readAccessLastBooking(conv?.partial_package)
  ) {
    return null;
  }

  if (isAccessLaneAckOnly(bodyText) && hasRecentAccessBooking(conv)) {
    return await finalizeAccessClose({
      conv,
      bodyText,
      replyText: "You're all set — talk soon.",
      tenantActorKey: o.tenantActorKey,
      transportChannel: o.transportChannel,
    });
  }

  let partial = { ...existing };
  let replyText = "";
  const llmActive =
    tenantAgentLlmEnabled() && !!openaiApiKey() && !isAccessBookingCorrection(bodyText, conv);

  if (isAccessBookingCorrection(bodyText, conv) && lastBooking) {
    const dayHint =
      extractDateForDayFromText(bodyText) ||
      String(existing.dateForDay || lastBooking.dateForDay || "").trim() ||
      "tomorrow";
    partial = {
      intentType: ACCESS_INTENT_TYPES.RESERVE,
      locationId: String(lastBooking.locationId || "").trim(),
      locationHint: String(lastBooking.locationHint || "").trim(),
      dateForDay: dayHint,
      _cancelReservationId: String(lastBooking.reservationId || "").trim(),
    };
    const window = parseAccessWindow(
      `${dayHint} ${bodyText}`,
      new Date(),
      propertyTimezone()
    );
    if (window?.startAt && window?.endAt) {
      partial.startAt = window.startAt;
      partial.endAt = window.endAt;
    } else if (lastBooking.startAt && lastBooking.endAt) {
      partial.startAt = String(lastBooking.startAt).trim();
      partial.endAt = String(lastBooking.endAt).trim();
      partial = alignAccessWindowToDateForDay(partial);
    }
    replyText = "Got it — I'll move that reservation to the day you meant. One moment.";
  } else if (llmActive) {
    const llm = await runAccessAgentLlmTurn({
      inboundMessage: bodyText,
      accessRequest: existing,
      messages: conv?.messages,
      amenities: locations,
      lastAccessError,
      traceId: o.traceId,
    });

    if (llm.ok) {
      const llmIntent = String(llm.accessIntent || "").trim();

      // LLM-driven lane control — semantic, not lexical.
      if (llmIntent === "ACCESS_CLOSE") {
        return await finalizeAccessClose({
          conv,
          bodyText,
          replyText: String(llm.reply || "").trim() || "All set — talk soon.",
          tenantActorKey: o.tenantActorKey,
          transportChannel: o.transportChannel,
        });
      }
      if (llmIntent === "ACCESS_SWITCH_MAINTENANCE") {
        await finalizeAccessSwitchToMaintenance({
          conv,
          bodyText,
          tenantActorKey: o.tenantActorKey,
          transportChannel: o.transportChannel,
        });
        return null;
      }

      if (llmIntent) partial.intentType = llmIntent;
      partial = mergeAccessPartialFromLlm(partial, llm.partialUpdates, locations);
      partial = supplementAccessLocationAndDay(partial, bodyText, locations);
      replyText = String(llm.reply || "").trim();
    } else {
      await appendEventLog({
        traceId: String(o.traceId || "").trim(),
        log_kind: "tenant_agent",
        event: "TENANT_AGENT_ACCESS_LLM_FAILED",
        payload: { err: String(llm.err || "unknown") },
      });
      partial = supplementAccessPartialDeterministic(partial, bodyText, locations);
    }
  } else {
    partial = supplementAccessPartialDeterministic(partial, bodyText, locations);
  }

  if (!partial.intentType || partial.intentType === ACCESS_INTENT_TYPES.UNKNOWN) {
    partial.intentType = inferAccessIntent(bodyText, {
      ...partial,
      accessSessionActive: true,
      lastAccessError,
    });
  }

  // ----- Deterministic time-window safety net -------------------------------
  //
  // Doctrine: "AI is interpretation, not control." Time parsing in a sticky
  // access lane with a known amenity + day is trivially deterministic; we
  // must not depend on the LLM cooperating. This catches a failure mode where
  // the LLM latches into `clarify` after a brain rejection and never produces
  // start_at/end_at again — every subsequent "1-2pm" / "1pm to 2pm" turn
  // strands the brain and the user gets a re-narrated stale rejection. Once
  // location + day are pinned, any parseable time window in the inbound text
  // wins over whatever the LLM did with `access_intent`.
  const { shouldCloseAccessLaneAfterBooking } = require("./conversationLane");
  if (shouldCloseAccessLaneAfterBooking(conv, bodyText)) {
    return await finalizeAccessClose({
      conv,
      bodyText,
      replyText: "You're all set — talk soon.",
      tenantActorKey: o.tenantActorKey,
      transportChannel: o.transportChannel,
    });
  }

  const _knownLocationId = String(partial.locationId || "").trim();
  const _knownDateForDay = String(partial.dateForDay || "").trim();
  if (_knownLocationId && _knownDateForDay && bodyHasAccessTimeIntent(bodyText)) {
    const _parsedWindow = parseAccessWindow(
      `${_knownDateForDay} ${bodyText}`,
      new Date(),
      propertyTimezone()
    );
    if (_parsedWindow?.startAt && _parsedWindow?.endAt) {
      const _sameStart = String(partial.startAt || "") === _parsedWindow.startAt;
      const _sameEnd = String(partial.endAt || "") === _parsedWindow.endAt;
      if (!_sameStart || !_sameEnd) {
        const _llmIntentBefore = String(partial.intentType || "").trim();
        partial.startAt = _parsedWindow.startAt;
        partial.endAt = _parsedWindow.endAt;
        partial.intentType = ACCESS_INTENT_TYPES.RESERVE;
        replyText = ""; // discard LLM chat; brain narrates rejection/success
        await appendEventLog({
          traceId: String(o.traceId || "").trim(),
          log_kind: "tenant_agent",
          event: "TENANT_AGENT_ACCESS_TIME_WINDOW_OVERRIDE",
          payload: {
            conversation_id: conv?.id || null,
            tenant_actor_key: String(o.tenantActorKey || "").trim(),
            inbound_preview: bodyText.slice(0, 120),
            llm_intent_before: _llmIntentBefore,
            parsed_start: _parsedWindow.startAt,
            parsed_end: _parsedWindow.endAt,
          },
        });
      }
    }
  }

  if (isAvailabilityQuestion(bodyText)) {
    partial = applyListSlotsIntent(partial, bodyText);
  } else if (affirmativeMeansListSlots(bodyText, conv?.messages)) {
    partial = applyListSlotsIntent(partial, bodyText);
  }

  let intentType = mapIntentToAccessType(partial.intentType);
  if (!intentType || intentType === ACCESS_INTENT_TYPES.UNKNOWN) {
    if (lockedLane) {
      // Lane owns interpretation — if we cannot resolve intent, ask within the lane.
      const lastBooking = readAccessLastBooking(conv?.partial_package);
      const stayReply = lastBooking
        ? `Your ${lastBooking.locationHint || "amenity"} booking is set. Want to change the day, change the time, or cancel?`
        : "Tell me which amenity and when you'd like to use it (for example: game room tomorrow 5–7 pm).";
      const turnCountStay = conv ? Number(conv.turn_count || 0) + 1 : 1;
      const messagesStay = appendMessage(
        appendMessage(conv || { messages: [] }, "user", bodyText),
        "assistant",
        stayReply
      );
      const savedStay = await saveTenantConversation({
        ...(conv || {}),
        tenant_actor_key: o.tenantActorKey,
        transport_channel: o.transportChannel,
        status: "gathering",
        partial_package: stampAccessLane({
          ...(conv?.partial_package || {}),
          _access_request: partial,
        }),
        messages: messagesStay.messages || messagesStay,
        turn_count: turnCountStay,
        tenant_locale: conv?.tenant_locale || "en",
      });
      return {
        handled: true,
        phase: "gather",
        replyText: stayReply,
        conversationId: savedStay?.id || conv?.id || "",
        tenantLocale: savedStay?.tenant_locale || conv?.tenant_locale || "en",
      };
    }
    return null;
  }

  partial.intentType = intentType;

  if (
    lastAccessError &&
    (String(lastAccessError.brain || "").trim() === "access_needs_window" ||
      String(lastAccessError.code || "").trim() === "needs_window")
  ) {
    partial.startAt = "";
    partial.endAt = "";
  }

  const turnCount = conv ? Number(conv.turn_count || 0) + 1 : 1;
  let messages = conv
    ? appendMessage(conv, "user", bodyText)
    : appendMessage({ messages: [] }, "user", bodyText);

  const confirmHandoff =
    shouldConfirmReserveHandoff(bodyText, conv?.messages) &&
    shouldHandoffAccess(partial, ACCESS_INTENT_TYPES.RESERVE, { confirmReserve: true });

  const forceListHandoff =
    intentType === ACCESS_INTENT_TYPES.LIST_SLOTS &&
    shouldHandoffAccess(partial, ACCESS_INTENT_TYPES.LIST_SLOTS, { forceList: true });

  const correctionHandoff =
    isAccessBookingCorrection(bodyText, conv) &&
    lastBooking &&
    shouldHandoffAccess(partial, ACCESS_INTENT_TYPES.RESERVE);

  const ready =
    intentType === "ACCESS_CLARIFY"
      ? false
      : forceListHandoff || confirmHandoff || correctionHandoff || shouldHandoffAccess(partial, intentType);

  if (
    ready &&
    mapIntentToAccessType(partial.intentType) === ACCESS_INTENT_TYPES.RESERVE &&
    lastBooking &&
    accessWindowsMatch(partial, lastBooking) &&
    !bodyHasAccessTimeIntent(bodyText) &&
    !isAccessBookingCorrection(bodyText, conv)
  ) {
    return await finalizeAccessClose({
      conv,
      bodyText,
      replyText: `You're all set — your ${lastBooking.locationHint || "amenity"} booking is confirmed. Talk soon.`,
      tenantActorKey: o.tenantActorKey,
      transportChannel: o.transportChannel,
    });
  }

  if (!replyText) {
    replyText = buildAccessDeterministicReply({
      intentType,
      partial,
      locations,
      lastAccessError,
    });
  }

  if (!ready) {
    if (!replyText) {
      replyText = "Tell me which amenity and when you would like to use it.";
    }
    messages = appendMessage({ messages }, "assistant", replyText);
    const saved = await saveTenantConversation({
      ...(conv || {}),
      tenant_actor_key: o.tenantActorKey,
      transport_channel: o.transportChannel,
      status: "gathering",
      partial_package: stampAccessLane({
        ...(conv?.partial_package || {}),
        _access_request: partial,
      }),
      messages,
      turn_count: turnCount,
      tenant_locale: conv?.tenant_locale || "en",
    });
    return {
      handled: true,
      phase: "gather",
      replyText,
      conversationId: saved?.id || conv?.id || "",
      tenantLocale: saved?.tenant_locale || conv?.tenant_locale || "en",
    };
  }

  const handoffIntent = confirmHandoff
    ? ACCESS_INTENT_TYPES.RESERVE
    : forceListHandoff
      ? ACCESS_INTENT_TYPES.LIST_SLOTS
      : correctionHandoff
        ? ACCESS_INTENT_TYPES.RESERVE
        : intentType;

  partial = finalizeAccessPartialForHandoff(partial, handoffIntent);
  const payload = buildAccessHandoffPayload(partial, handoffIntent);

  const saved = await saveTenantConversation({
    ...(conv || {}),
    tenant_actor_key: o.tenantActorKey,
    transport_channel: o.transportChannel,
    status: "handoff_pending",
    partial_package: stampAccessLane({
      ...(conv?.partial_package || {}),
      _access_request: partial,
    }),
    messages,
    turn_count: turnCount,
    tenant_locale: conv?.tenant_locale || "en",
  });

  await appendEventLog({
    traceId: String(o.traceId || "").trim(),
    log_kind: "tenant_agent",
    event: "TENANT_AGENT_ACCESS_HANDOFF",
    payload: {
      conversation_id: saved?.id || conv?.id || null,
      tenant_actor_key: String(o.tenantActorKey || "").trim(),
      intent_type: payload.intentType,
      location_id: payload.locationId || null,
      date_for_day: payload.dateForDay || null,
    },
  });

  return {
    handled: true,
    phase: "access_handoff",
    routerParameter: {
      _accessPayloadJson: JSON.stringify(payload),
      _accessIntentType: String(payload.intentType || "").trim(),
    },
    conversationId: saved?.id || conv?.id || "",
    tenantLocale: saved?.tenant_locale || conv?.tenant_locale || "en",
  };
}

module.exports = {
  maybeHandleAccessTurn,
  buildAccessHandoffPayload,
};
