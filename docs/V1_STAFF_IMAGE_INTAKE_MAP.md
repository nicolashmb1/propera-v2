# V1 Staff Image Intake Map

Phase 1 mapping only. This document maps the GAS / V1 staff `#` image intake behavior so V2 can reproduce it without putting maintenance decisions inside channel adapters.

## Entry Point

- Staff capture begins in `propera-gas-reference/01_PROPERA MAIN.gs` at `handleSmsRouter_(e)`. A body beginning with `#` is stripped with `bodyTrim.replace(/^#\s*/, "")`, `_staffCapture = "1"` is set, and the event is routed to core in `MANAGER` mode.
- The mapped code treats the staff marker as the leading hash. It does not show a special `#staff` command alias; a literal `#staff Penn 403` would strip to `staff Penn 403` unless another unlocated production wrapper rewrote it before this router.
- Telegram V1/GAS normalizes Telegram photos in `propera-gas-reference/02_TELEGRAM_ADAPTER.gs` through `telegramCollectNormalizedMediaFromMessage_(msg)` and `telegramTryAppendNormalizedMedia_(mediaArr, fileId, mimeHintFromMessage)`. The adapter resolves `file_id` to a direct Telegram file URL and emits canonical media objects with `url`, `contentType`, `mimeType`, and `source: "telegram"`.
- Twilio / WhatsApp / SMS media is accepted through `NumMedia`, `MediaUrl0..n`, and `MediaContentType0..n`. `handleSmsRouter_(e)` collects those fields into router metadata, and `ensureCanonicalMediaJsonOnParameters_(p)` can convert Twilio parameters into `_mediaJson`.
- Media-only messages are allowed. `handleSmsSafe_` / core set `globalThis.__bodyOverride = "ATTACHMENT_ONLY"` when `Body` is empty and `NumMedia > 0`, and core later normalizes that marker back to empty text so it is never treated as issue text.

## Media Handling

- Canonical media normalization lives in `propera-gas-reference/05_AI_MEDIA_TRANSPORT.gs`:
  - `parseCanonicalMediaArrayFromEvent_(e)` prefers `_mediaJson`, then falls back to Twilio `MediaUrl*`.
  - `ensureCanonicalMediaJsonOnParameters_(p)` writes `_mediaJson` from Twilio-style media params when absent.
  - `extractInboundMediaFacts_(e)` returns media count, first URL/type/source, and image eligibility.
- Telegram files are resolved to direct HTTPS file URLs in `telegramGetFileResolved_(fileId)` and then placed into the same canonical media array. This means the downstream vision path is not supposed to know whether the image came from Telegram or Twilio except for fetch authentication.
- Media fetch is channel-aware but signal-neutral:
  - `fetchTwilioMediaAsDataUrl_(mediaUrl)` uses Twilio Basic auth.
  - `fetchGenericHttpsMediaAsDataUrl_(mediaUrl, hintedMime)` handles Telegram / generic HTTPS image URLs.
  - `fetchInboundMediaAsDataUrl_(mediaUrl, source, hintedMime)` chooses Twilio vs generic HTTPS.
- Attachment storage is ticket-time, not adapter-time:
  - `saveInboundAttachmentToDrive_(mediaUrl, mediaFacts, opts)` stores a fetched blob in Drive.
  - `processTicket_` in `PROPERA_MAIN_BACKUP.gs` writes the Drive URL into the `ATTACHMENTS` column when `firstMediaUrl` is present.
  - V1 stores only the first staff-capture media URL on ticket create in the mapped path, although `turnFacts.meta.mediaUrls` may carry multiple URLs.

## OCR / Vision

- V1 did not run plain OCR only. The main staff path uses multimodal vision extraction in `propera-gas-reference/05_AI_MEDIA_TRANSPORT.gs`.
- The provider call is `openaiVisionJson_(opts)`, called by `imageSignalAdapter_(e, bodyText, phone)`.
- `buildMediaSignalPrompt_(bodyText)` asks OpenAI to return JSON with:
  - `mediaType`: `real_world_photo`, `screenshot_chat`, `screenshot_error_screen`, or `unknown`.
  - `detectedObjects`.
  - `extractedText`.
  - `propertyHint`, `unitHint`, `tenantNameHint`.
  - `issueHints.category`, `issueHints.subcategory`, `issueHints.issueSummary`, `symptoms`, `attemptedFixes`, `locationsInUnit`, and `safetySensitive`.
  - `syntheticBody`.
  - `confidence`.
- Screenshot text and visual summaries converge through the same `syntheticBody` / `extractedText` media facts. For screenshots, the prompt explicitly tells the model to read visible text and build a concise operational issue sentence. For real-world photos, it asks for maintenance-relevant visible objects and a conservative synthetic issue only when clear.

## Issue Extraction

- The main media interpretation function is `imageSignalAdapter_(e, bodyText, phone)`.
- It returns normalized media facts, including `syntheticBody`, `extractedText`, issue/category hints, property/unit hints, confidence, and first media URL/type.
- `mergeMediaIntoBody_(bodyTrim, mediaFacts)` is the key bridge into normal issue extraction:
  - If the body is empty or weak (`""`, very short text, or `isWeakIssue_`), and `syntheticBody` exists, the synthetic image-derived body replaces the weak body.
  - If body and synthetic text both exist, the function appends synthetic text when useful and non-duplicative.
- In the staff capture path in `PROPERA_MAIN_BACKUP.gs`, lines around `16654-16763` show the synchronous path:
  - Run `imageSignalAdapter_(e, payloadText, originPhoneStaff)`.
  - Compute `mergedPayloadText = mergeMediaIntoBody_(payloadText, staffMediaFacts)`.
  - Run `compileTurn_(mergedPayloadText, draftPhone, "en", baseVars, null)`.
  - Attach media facts to `turnFacts` with `maybeAttachMediaFactsToTurn_(turnFacts, staffMediaFacts)`.
- If `compileTurn_` leaves `turnFacts.issue` blank or weak, V1 applies `mergedPayloadText` as a staff synthetic issue and sets `turnFacts.meta.staffSynthIssue = true`. This protects clear image-derived issue text from being suppressed by downstream weak-property heuristics.

## Draft Merge

- Staff capture state is draft-based. `parseStaffCapDraftId_(s)` reads `d123` / `d123: rest`; `nextStaffCapDraftId_()` allocates new draft ids.
- `draftPhone = "SCAP:" + draftId` is the synthetic key for the staff draft in Directory/session state.
- The synchronous staff path in `PROPERA_MAIN_BACKUP.gs` merges media facts into the same draft path as text:
  - `compileTurn_(mergedPayloadText, draftPhone, "en", baseVars, null)`.
  - `maybeAttachMediaFactsToTurn_(turnFacts, staffMediaFacts)`.
  - media-derived issue fallback when parser output is weak.
  - property/unit fallbacks from media hints only when `staffMediaFacts.confidence >= 0.6` and the text/turn did not already provide those fields.
  - `draftUpsertFromTurn_(dir, dirRow, turnFacts, mergedPayloadText, draftPhone, { staffCapture: true })`.
- Typed text wins in practice because media property/unit hints are applied only if `turnFacts.property` / `turnFacts.unit` are still empty. Text like `# apt 305 penn` therefore supplies property/unit while the image supplies the issue.
- Screenshot text feeds normal issue extraction because the OCR/vision-derived `syntheticBody` becomes `mergedPayloadText`, then goes through `compileTurn_` and `draftUpsertFromTurn_`.
- Image-only input can fill the issue field when `syntheticBody` is usable. If there is no usable synthetic body, V1 treats the turn as status-only or asks for missing fields rather than inventing an issue.

## Ticket Creation

- V1 promotes a staff draft to a real ticket only when the triad is complete:
  - property
  - unit, except for common-area behavior elsewhere in the system
  - issue
- In the staff media path, after `draftUpsertFromTurn_` and `recomputeDraftExpected_`, V1 rereads draft fields and calls `finalizeDraftAndCreateTicket_(...)` only when no required fields are missing and no ticket was already created.
- `finalizeDraftAndCreateTicket_` then calls `processTicket_(...)` through the canonical ticket creation path, preserving the resolver / lifecycle write discipline.
- Media is linked on create by passing:
  - `firstMediaUrl`
  - `firstMediaContentType`
  - `firstMediaSource`
  - `mediaType`
  - category/subcategory/unit hints used for attachment naming
- `processTicket_` uses `saveInboundAttachmentToDrive_` and writes a Drive URL to the ticket `ATTACHMENTS` column.

## Weak Signal Behavior

- V1 is conservative when the image cannot be interpreted:
  - `imageSignalAdapter_` returns `hasMedia: true`, `mediaType: "unknown"`, empty `syntheticBody`, and `confidence: 0` on fetch/API failure or unclear output.
  - `mergeMediaIntoBody_` does not synthesize an issue without `syntheticBody`.
  - Staff capture only applies media property/unit hints when confidence is at least `0.6`.
- If there is no typed payload and no usable synthetic body, the staff capture branch sends draft status / missing-field messaging instead of creating an issue.
- For tenant photo-only active-ticket turns, GAS had a separate `ASK_ISSUE_FROM_PHOTO` path that appends media to an active ticket and asks for clarification. The staff image path does not use that tenant copy directly, but it follows the same principle: store/keep media, do not hallucinate issue text.

## Exact V1 Files / Functions

- `propera-gas-reference/01_PROPERA MAIN.gs`
  - `handleSmsRouter_(e)`
  - `handleInboundCore_(e)`
  - `parseStaffCapDraftId_(s)`
  - `nextStaffCapDraftId_()`
- `propera-gas-reference/PROPERA_MAIN_BACKUP.gs`
  - staff capture block around `handleInboundCore_(e)`
  - `staffCaptureDispatchOutboundIntent_`
  - `tenantMsg_` fallback keys for `STAFF_CAPTURE_*`
  - `processTicket_` attachment write
- `propera-gas-reference/06_STAFF_CAPTURE_ENGINE.gs`
  - `staffMediaVisionDeferEnabled_()`
  - `extractMediaUrlsFromTwilioEvent_(e)`
  - `enqueueStaffMediaVisionJob_(e, job)`
  - `staffMediaVisionWorkerRunPipeline_(...)`
  - `processStaffMediaVisionQueueTick_()`
- `propera-gas-reference/05_AI_MEDIA_TRANSPORT.gs`
  - `fetchInboundMediaAsDataUrl_(...)`
  - `openaiVisionJson_(opts)`
  - `parseCanonicalMediaArrayFromEvent_(e)`
  - `ensureCanonicalMediaJsonOnParameters_(p)`
  - `extractInboundMediaFacts_(e)`
  - `buildMediaSignalPrompt_(bodyText)`
  - `imageSignalAdapter_(e, bodyText, phone)`
  - `mergeMediaIntoBody_(bodyTrim, mediaFacts)`
  - `maybeAttachMediaFactsToTurn_(turnFacts, mediaFacts)`
  - `firstMediaFieldsFromTurnFacts_(turnFacts)`
  - `saveInboundAttachmentToDrive_(...)`
- `propera-gas-reference/10_CANONICAL_INTAKE_ENGINE.gs`
  - `draftUpsertFromTurn_(...)`
- `propera-gas-reference/11_TICKET_FINALIZE_ENGINE.gs`
  - `finalizeDraftAndCreateTicket_(...)`
- `propera-gas-reference/02_TELEGRAM_ADAPTER.gs`
  - `telegramCollectNormalizedMediaFromMessage_(msg)`
  - `telegramTryAppendNormalizedMedia_(...)`
  - `telegramGetFileResolved_(fileId)`

