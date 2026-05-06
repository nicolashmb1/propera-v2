# V2 Staff Image Gap Map

Phase 1 mapping only. This document maps current V2 `#` staff image behavior against V1/GAS staff image intake. No implementation changes are proposed here beyond exact future edit targets.

## Current Staff Path

- Telegram enters V2 in `src/adapters/telegram/normalizeTelegramUpdate.js`.
  - `normalizeTelegramUpdate(payload)` converts Telegram updates to `InboundSignal`.
  - `normalizeTelegramMedia(msg)` captures the largest `photo` and supported `document` media as channel-neutral objects with `kind`, `provider: "telegram"`, `file_id`, optional `mime_type`, and `caption`.
  - `body.text` is `msg.text || msg.caption`, so a photo caption of `#` / `#d126` becomes the router `Body`.
- Twilio SMS / WhatsApp enter V2 through `src/contracts/buildRouterParameterFromTwilio.js`.
  - `buildRouterParameterFromTwilio(body)` converts `NumMedia`, `MediaUrl*`, and `MediaContentType*` to `_mediaJson[]` items with `provider: "twilio"`, `source: "twilio"`, `url`, `contentType`, and `kind`.
- Telegram router parameters are built in `src/contracts/buildRouterParameterFromTelegram.js`.
  - `buildRouterParameterFromTelegram(signal, rawPayload)` writes `Body`, `_channel: "TELEGRAM"`, `_phoneE164: "TG:<user_id>"`, `_telegramChatId`, `_telegramUpdateId`, `From`, and `_mediaJson`.
- Shared inbound orchestration is `src/inbound/runInboundPipeline.js`.
  - It parses `_mediaJson`, calls `enrichInboundMediaWithOcr(mediaArr)` once before router/core, and rewrites `_mediaJson` with any `ocr_text`.
  - It resolves staff identity through `resolveStaffContextFromRouterParameter`.
  - It resolves the canonical brain actor key through `resolveCanonicalBrainActorKey`.
  - It evaluates `evaluateRouterPrecursor`.
  - It builds lane decisions through `routeInboundDecision`.
- `#` staff mode detection is in `src/brain/router/evaluateRouterPrecursor.js`.
  - Any non-empty `Body` whose first character is `#` returns `STAFF_CAPTURE_HASH` with `staffCapture.stripped`.
  - The current parser treats `#staff` literally as stripped text `staff`; there is no special alias removal for a `#staff` command word. Existing tests and GAS parity docs mostly model the command as bare `#` / `#d123`.
  - Staff non-`#` messages return `STAFF_LIFECYCLE_GATE`, so staff media-only without a `#` does not enter tenant maintenance intake.
- Staff capture enters maintenance core from `runInboundPipeline`.
  - `isStaffCaptureHash(precursor)` gates core mode.
  - The body sent to core is `composeInboundTextWithMedia(textForMediaCompose, mediaForCore, 1400)`.
  - For `#d123 ...`, `textForMediaCompose` is the draft rest after removing the draft id.
- Draft create/update happens in `src/brain/core/handleInboundCore.js`.
  - Staff capture requires the canonical actor key and uses it as the staff draft owner.
  - `resolveStaffCaptureDraftTurn` in `src/dal/staffCaptureDraft.js` allocates or loads a `staff_capture_drafts` row.
  - `handleInboundCore` parses the composed body with `parseMaintenanceDraftAsync`, then merges with `mergeMaintenanceDraftTurn`.
  - `saveIntakeLike` writes staff draft fields through `updateDraftFields`.
  - Final ticket creation uses `finalizeMaintenanceDraft`.

## Current Media Path

- Media enters the canonical package for Telegram and Twilio / WhatsApp / SMS as `_mediaJson`.
- Media references are preserved:
  - Telegram: `provider: "telegram"`, `file_id`, `file_unique_id`, `caption`, optional `mime_type`, `file_name`.
  - Twilio: `provider: "twilio"`, `source: "twilio"`, `url`, `contentType`, `kind`.
- OCR is implemented but narrow:
  - `src/brain/shared/enrichInboundMediaWithOcr.js` is the single inbound OCR checkpoint.
  - `normalizeInboundMediaProvider(item)` dispatches to Twilio or Telegram.
  - `ocrTwilioImageItem` fetches Twilio media as a data URL using Twilio credentials.
  - `ocrTelegramImageItem` calls Telegram `getFile`, downloads the file, builds a data URL, and calls OpenAI vision OCR.
  - OCR only writes `ocr_text` onto media items.
  - `src/brain/shared/mediaOcr.js` skips items with existing `ocr_text` / `text`, and skips non-image / non-file media.
- Current media text composition is in `src/brain/shared/mediaPayload.js`.
  - `mediaTextHints(mediaList)` reads `ocr_text`, `ocrText`, `text`, `transcript`, and Telegram caption hint text.
  - `composeInboundTextWithMedia(bodyText, mediaList, maxChars)` appends unique media text hints to the base body.
  - The recent staff-caption fix strips routing-only Telegram photo captions like `#` / `#d126` via `issueHintFromTelegramPhotoCaption(caption)`, so OCR text can drive the body instead of a lone hash.
- Current ticket attachment behavior is reference-only:
  - `src/dal/finalizeMaintenance.js` calls `buildTicketAttachmentsFromRouterParameter(routerParameter)`.
  - That function writes media URLs when present, or `telegram:<file_id>` tokens for Telegram media without a URL.
  - There is no V2 equivalent of GAS Drive-backed `saveInboundAttachmentToDrive_`.
- Current work item metadata records coarse media facts only:
  - `media_count`.
  - `media_ocr_present`.

## Current Structured Signal Path

- `src/brain/core/parseMaintenanceDraft.js` chooses extraction mode:
  - Regex-only when `INTAKE_COMPILE_TURN` is off.
  - `compileTurn` when `INTAKE_COMPILE_TURN=1`.
- `src/brain/intake/compileTurn.js` calls `properaBuildIntakePackage`.
- `src/brain/intake/properaBuildIntakePackage.js` builds a GAS-shaped package:
  - deterministic structured signal from `signalFromDeterministic`.
  - optional LLM structured signal through `properaExtractStructuredSignalLLM` when `INTAKE_LLM_ENABLED=1` and OpenAI is configured.
  - final `structuredSignal` is attached to the turn package.
- `src/brain/intake/structuredSignal.js` has the current structured signal contract:
  - actor / intent fields
  - property and unit
  - `issues[]`
  - `schedule`
  - `actionSignals`, `targetHints`
  - `confidence`, `ambiguity`, `domainHint`, `safety`
- There is no `mediaSignals[]` or image-facts object in the structured signal today.
- OCR text becomes ordinary message text only after `composeInboundTextWithMedia`; the compiler does not know which facts came from OCR, caption, typed text, or visual interpretation.

## Current Gap vs V1

- `#staff` / `#` image-only with a real photo:
  - V1 can use vision `syntheticBody` to infer "sink leaking" from a real photo.
  - V2 can only use OCR text. A real photo without readable text does not produce an issue hint and will likely skip core on empty composed body or ask for the issue.
- Screenshot-only text:
  - V1 uses vision extraction with `extractedText` and `syntheticBody`, then feeds the result through `compileTurn_`.
  - V2 can handle this only if OCR extracts usable text into `ocr_text`. If `INTAKE_MEDIA_OCR_ENABLED`, OpenAI config, and channel credentials are present, screenshot text can become composed body text and feed `parseMaintenanceDraftAsync`.
- Image-derived issue filling the issue field:
  - V1 explicitly fills weak / missing staff issue text from `mergedPayloadText` and marks `staffSynthIssue`.
  - V2 has no media-derived `issueNameHint` / `syntheticBody`; it only has composed OCR/caption text. Clear visual issue hints cannot fill the issue field unless OCR text says the issue.
- Typed property/unit plus image-derived issue:
  - V1 supports typed property/unit with image issue because text and `syntheticBody` are merged before `compileTurn_`, and media property/unit fallbacks only run when text did not already supply fields.
  - V2 supports typed property/unit plus OCR-derived issue only. It does not support visual-only issue inference.
- Literal `#staff` command word:
  - V1/V2 mapped code treats the staff marker as the leading hash, not a semantic `#staff` token.
  - If users type `#staff Penn 403`, current V2 passes `staff Penn 403` as content after stripping `#`; a future implementation should decide whether `staff` is a supported alias and remove it before issue/property parsing.
- Multiple images in one staff turn:
  - V1 carries a media URL list and treats the same inbound turn as one staff draft. The vision adapter appears to analyze the first image for facts; the draft/ticket path can preserve media URLs but ticket create mainly passes the first media URL to attachment storage.
  - V2 groups all `_mediaJson[]` items in the same inbound turn for the same core run and `buildTicketAttachmentsFromRouterParameter` can write multiple references. There is no combined multi-image visual summary or confidence aggregation.
- Unclear image:
  - V1 returns empty `syntheticBody`, low confidence, `mediaType: "unknown"` and does not hallucinate. It only applies property/unit hints above confidence `0.6`.
  - V2 has no visual confidence or `needsClarification` media fact. If OCR is empty, the body may be empty and `handleInboundCore` returns `core_empty_body`; if typed property/unit exists but no issue, it asks the normal next missing slot.
- Adapter-trapped logic:
  - Current V2 media normalization is mostly adapter-safe: adapters normalize transport shape only.
  - The Telegram adapter currently copies captions into both `body.text` and media `caption`, which is correct transport normalization, but staff semantics are handled later by `mediaPayload.issueHintFromTelegramPhotoCaption`.
  - OCR fetching is channel-aware inside `enrichInboundMediaWithOcr`, but that module is a shared inbound checkpoint, not a maintenance decision point.

## Future Target Architecture Fit

The Compass-safe target should preserve this shape:

```text
Adapter
→ RouterParameter / canonical media[]
→ shared media signal runtime
→ intake compiler / StructuredSignal
→ staff draft engine
→ finalize / lifecycle
→ outgate
```

Future image extraction should be treated as signal interpretation only. It must not assign ownership, create tickets, resolve lifecycle, or bypass the staff draft engine.

## Exact Future Edit Targets

These are the likely files/functions to edit in a future implementation phase, not in this mapping phase.

- Add a shared media facts runtime:
  - New likely file: `src/brain/shared/mediaSignalRuntime.js`
  - Or extend `src/brain/shared/enrichInboundMediaWithOcr.js` if the scope stays as one inbound media enrichment checkpoint.
  - It should return `mediaSignals[]` with OCR text, visual summary, issue/category/location/property/unit/safety hints, confidence, and `needsClarification`.
- Extend the shared media contract:
  - `src/brain/shared/mediaPayload.js`
  - Add support for `mediaSignals[].ocrText`, `mediaSignals[].issueNameHint`, `mediaSignals[].issueDescriptionHint`, and `visualSummary`.
  - Preserve the current caption stripping behavior for Telegram staff captions.
- Extend structured signal shape:
  - `src/brain/intake/structuredSignal.js`
  - `src/brain/intake/canonizeStructuredSignal.js`
  - `src/brain/intake/openaiStructuredSignal.js`
  - `src/brain/intake/properaBuildIntakePackage.js`
  - Add `mediaSignals[]` as extracted facts, not decisions.
- Pass media context into compile:
  - `src/brain/intake/compileTurn.js`
  - `src/brain/core/parseMaintenanceDraft.js`
  - Today only text reaches `compileTurn`; future work should let the compiler see typed text plus media facts while still performing one interpretation step.
- Merge staff media facts into drafts:
  - `src/brain/core/handleInboundCore.js`
  - `src/brain/core/mergeMaintenanceDraft.js`
  - `src/dal/staffCaptureDraft.js` if draft storage needs media references or media facts.
  - Rules to preserve: typed staff text wins for explicit property/unit; OCR text is close to user text; visual issue hint can fill missing issue only when confidence is high; weak signal asks for issue clarification.
- Attach media references to tickets/drafts:
  - `src/dal/finalizeMaintenance.js`
  - Current behavior stores raw URL / `telegram:<file_id>` references. Future attachment persistence may require a DAL/service layer, not adapter logic.
- Add tests:
  - `tests/mediaPayload.test.js`
  - `tests/enrichInboundMediaWithOcr.test.js`
  - `tests/telegramMediaBridge.test.js`
  - `tests/finalizeMaintenanceAttachments.test.js`
  - New staff media integration tests near `tests/integration/staffCaptureCrossChannel.test.js`.

## Patch Law Notes For Future Implementation

- Target module should be the Signal / Compiler boundary plus staff draft engine, not Telegram adapter business logic.
- Allowed zone:
  - transport adapters may normalize media references only.
  - shared media runtime may extract facts only.
  - intake compiler may build `StructuredSignal`.
  - staff draft engine may merge validated facts and ask the next missing question.
  - finalize / lifecycle remains the only ticket/work-item creation path.
- Canonical flow must remain:

```text
Signal → normalize media → structured extraction → staff draft merge → finalize/lifecycle → outgate
```

- Do not implement `if (telegramPhoto) createTicket(...)`.
- Do not add a second issue parser outside the compiler / structured extraction path.
- Do not let image AI decide assignment, lifecycle, escalation, or ticket creation.

