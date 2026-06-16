# Supabase migrations — order and V2 code alignment

Run SQL files in **numeric order** in the Supabase SQL Editor (same project as `SUPABASE_URL` in `.env`).

| File | Tables / changes | Required by V2 code |
|------|------------------|---------------------|
| **001_core.sql** | `conversation_ctx`, `work_items`, `tickets` (base), `tenant_directory`, `property_policy`, `message_templates`, `intake_sessions` | Core: `appendEventLog` does not use 001 tables except via other paths — **conversation_ctx**, **work_items**, **tickets**, **intake_sessions**, **property_policy** are all used. |
| **002_event_log.sql** | `event_log` | `appendEventLog.js` |
| **003_identity.sql** | `properties`, `contacts`, `staff`, `staff_assignments` | `resolveActor.js`, `resolveStaffContext.js`, `propertyLookup.js` (properties), `intakeSession.listPropertiesForMenu`, `handleInboundCore` property codes |
| **004_roster_and_policy_seed.sql** | Alters (properties columns, `staff_assignments` uniqueness, contacts/staff extras), **seed** properties (incl. GLOBAL), roster, **property_policy** rows | **Schedule policy** (`getSchedPolicySnapshot`): needs `property_policy` rows for production-like parity; optional defaults work without rows. Roster seed for dev staff. **Supersedes** need for 008’s property columns if 004 is applied. |
| **005_telegram_chat_link.sql** | `telegram_chat_link` | `upsertTelegramChatLink.js` |
| **006_tickets_sheet1_columns.sql** | Many `tickets` columns (Sheet1 / COL) | **`finalizeMaintenance.js`** inserts — **required** for maintenance finalize |
| **007_category_final_legacy.sql** | Comment on `tickets.category_final` | Optional |
| **008_properties_dal_columns.sql** | `properties.legacy_property_id`, `address`, `short_name` | **`getPropertyByCode`** — run if you have **003** (and **006**) but have **not** run **004** yet |
| **009_property_aliases.sql** | `property_aliases` (config-driven per-property aliases) | Intake property detection (`listPropertiesForMenu` → `detectPropertyFromBody`) uses this when present; safe fallback if absent |
| **010_property_aliases_seed_from_properties.sql** | Optional seed helper for `property_aliases` from `properties.short_name` / `display_name` / controlled address token | Optional convenience after 009; safe idempotent seed (`ON CONFLICT DO NOTHING`) |
| **011_sms_opt_out.sql** | `sms_opt_out` — compliance STOP/START persistence | **`src/dal/smsOptOut.js`**, **`src/inbound/runInboundPipeline.js`** (SMS-only branch) |
| **012_tenant_roster.sql** | `tenant_roster` — GAS **Tenants** sheet (property + unit + resident phone + name) | **`src/dal/tenantRoster.js`** — staff **`#capture`** resolves **resident** phone for `tickets` / `work_items` (never staff phone) |
| **013_tenant_roster_rls.sql** | **RLS enabled** on `tenant_roster` (no anon policies — PII safe for Supabase API) | Run after **012** if Supabase warns about missing RLS; server uses **service role** (bypasses RLS) |
| **018_program_engine_v1.sql** | `program_templates`, `program_runs`, `program_lines` (PM/Task V1) + seed templates | **`programRuns.js`**, portal routes `/api/portal/program-*` — see **`docs/PM_PROGRAM_ENGINE_V1.md`** |
| **019_properties_program_expansion_profile.sql** | `properties.program_expansion_profile` (jsonb) — per-property PM expansion hints | **`expandProgramLines.js`**: `FLOOR_BASED` uses **`floor_paint_scopes`** then **`common_paint_scopes`**; `UNIT_PLUS_COMMON` appends **`common_paint_scopes`** (or one **Common Area**); `COMMON_AREA_ONLY` uses **`common_paint_scopes`** only — see **`docs/PM_PROGRAM_ENGINE_V1.md`** |
| **020_program_lines_scope_type_common_area_only.sql** | `program_lines`: migrate `SITE` → `COMMON_AREA`; constraint allows only `UNIT`, `COMMON_AREA`, `FLOOR` | **`expandProgramLines.js`** (`COMMON_AREA_ONLY` lines use `COMMON_AREA`) |
| **040_program_lines_proof_photos.sql** | `program_lines.proof_photo_urls` (jsonb array of image URLs) | **`programRuns.js`** complete/reopen + portal **`PATCH .../program-lines/:id/complete`**; **`propera-app`** `/preventive` proof upload |
| **021_portal_auth_allowlist.sql** | `portal_auth_allowlist` — pre-approved emails, `portal_role`, optional `staff_id` FK | **`propera-app`** `POST /api/auth/register`, **`POST /api/auth/login`**, **`portalMeFromSupabase`** (`/api/me`); service role bypasses RLS |
| **031_batch_media_meter_billing.sql** | `batch_media_runs`, `batch_media_assets`, `utility_meters`, `utility_meter_readings`; Storage bucket **`utility-meter-runs`** | **`meterBillingRuns.js`**, **`registerMeterRunRoutes.js`** (`/api/portal/meter-runs`, `utility-meters`); **`propera-app`** `/api/utility-meter-runs/*`, `/api/utility-meter-runs/upload` |
| **041_batch_media_assets_updated_at.sql** | `batch_media_assets.updated_at` + touch trigger | Stuck **PROCESSING** reset, **`POST /internal/cron/meter-runs-process-pending`**, portal resume / snapshot counts |
| **042_operational_finance_v1.sql** | `ticket_cost_entries`, `tenant_ledger_entries`, `portal_ticket_financial_summary_v1`, `portal_property_maintenance_spend_month_v1`; extends **`portal_tickets_v1`** (`ticket_row_id`, finance timeline colors), **`portal_properties_v1`** (UTC-month maintenance columns) | **`ticketCostEntries.js`**, portal `/api/portal/tickets/:id/ticket-cost-entries*`, **`propera-app`** Costs & charges; env: `PROPERA_FINANCE_ENABLED`, `PROPERA_FINANCE_TICKET_COSTS_ENABLED`, `PROPERA_FINANCE_LEDGER_ENABLED` + `NEXT_PUBLIC_PROPERA_FINANCE_ENABLED` |
| **069_vendor_lane_v1.sql** | `vendor_contacts`, `vendor_conversation_ctx`, `tickets.vendor_dispatch_at` / `vendor_dispatched_to` | **`vendorContacts.js`**, **`vendorAssignment.js`**, **`preloadActorIdentity.js`**; see **`docs/VENDOR_LANE.md`** |
| **046_vendors_and_program_line_vendor.sql** | `vendors` catalog; **`program_lines.assigned_vendor_id`**, **`assigned_vendor_display`** | **`portalTicketAssignment.js`** (ticket `assigned_type = VENDOR`), **`programRuns.js`** `setProgramLineVendor`, **`GET /api/portal/vendors-for-assignment`**; **`propera-app`** ticket + `/preventive` vendor UI |
| **047_program_run_cost_entries.sql** | **`ticket_cost_entries`**: nullable **`ticket_id`**, **`program_run_id`** / **`program_line_id`**, parent XOR check, **`material`** entry type | **`ticketCostEntries.js`** program-run list/create + same PATCH as tickets; portal **`/api/portal/program-runs/:id/ticket-cost-entries`**; **`propera-app`** `/preventive` costs when finance on |
| **051_program_lines_staff_assignment.sql** | **`program_lines.assigned_staff_id`**, **`assigned_staff_display`** | **`setProgramLineStaff`**, **`PATCH .../program-lines/:id/staff`** |
| **059_program_timeline_v1.sql** | **`program_timeline_events`** — preventive Activity (DAL writers, not triggers) | **`programTimeline.js`**, **`programRuns.js`**; **`GET program-runs/:id`** includes **`timeline`** |
| **060_program_line_ticket_bridge.sql** | Line ↔ ticket link columns; `tickets` / `work_items` program FKs | **`createTicketFromProgramLine.js`**, **`POST …/program-lines/:id/create-ticket`**, **`/preventive` Report issue** |
| **062_tenant_outbound_day_mark.sql** | First tenant outbound per ops day | **`tenantOutboundDayMark.js`**, Outgate Phase 4 SMS footer + property header |
| **063_tenant_conversations.sql** | `tenant_conversations` — Tenant Agent adapter state | **`src/adapters/tenantAgent/conversationStore.js`** when **`TENANT_AGENT_ENABLED=1`** |
| **064_unit_status_history_v1.sql** | `unit_status_history`; extends **`portal_units_v1`** with `vacancy_started_at` | **`propera-app`** `/financial/properties/[property]` vacancy timing / loss estimates; canonical unit status intervals for future vacancy analytics |
| **048_portal_properties_maintenance_ytd.sql** | **`portal_properties_v1`**: **`maintenance_*_ytd`** columns (UTC year sum from monthly rollup) | **`portalTicketsRead.js`**, **`propera-app`** properties KPI + cards + financial property header; export CSV |
| **052_tenant_ledger_effective_date_notes.sql** | **`tenant_ledger_entries.effective_date`**, **`notes`** | **`propera-app`** unit ledger manual POST + void |
| **054_pm_attachments_audio_mime.sql** | **`pm-attachments`** bucket audio + PDF MIME types | **`/api/portal/chat-audio-upload`** voice notes |
| **055_communication_engine.sql** | **`communication_*`** tables; **`organizations`**; property brand columns; **`tenant_roster.comm_broadcast_opt_out`** | **`docs/COMMUNICATION_ENGINE.md`** — broadcast SMS engine (separate Twilio number) |
| **065_communication_agent_initiated.sql** | **`communication_campaigns.agent_initiated`** | Communication Engine follow-up audit flag for portal vs future agent-created drafts |
| **066_access_lifecycle_jobs.sql** | **`access_lifecycle_jobs`** — reservation approval timeout / reminder / activate / complete queue | **Access Engine** lifecycle worker (`src/access/accessLifecycleJobs.js`, `src/access/processAccessLifecycleJobs.js`) and cron fan-out from `POST /internal/cron/lifecycle-timers` |
| **067_conflict_mediation_v1.sql** | **`conflict_policies`**, **`conflict_cases`**, **`conflict_case_events`** + CME enums | **Conflict Mediation Engine** read slice (`src/conflictMediation/*`, `/api/conflict/*`) — see `docs/CONFLICT_MEDIATION_ENGINE.md` |
| **068_operational_policy_conflict_keys.sql** | `property_policy` GLOBAL seeds for `conflict.monitoring_window_days`, `conflict.complainant_confidentiality`, `conflict.auto_escalate_after_violations` | **Operational policy config** defaults for CME escalation rules (`src/brain/policy/resolveOperationalPolicy.js`) |
| **071_conflict_policy_seed_v1.sql** | Starter **`conflict_policies`** rows per property (quiet hours, trash, parking, pets, smoking, common area) | **CME-2** staff report + courtesy notice (`src/conflictMediation/conflictCaseWrite.js`) |
| **070_jarvis_operator_threads.sql** | **`jarvis_operator_threads`** | Jarvis spine thread state (pending proposals + last receipt) for plan/confirm flows (`src/dal/jarvisOperatorThreads.js`, `src/agent/thread/*`) |
| **074_org_spine_core.sql** | **`org_id`** on allowlist, staff, vendors, roster, aliases; allowlist **`(org_id, email_lower)`** unique | **`docs/MULTI_ORG_ARCHITECTURE.md`** — portal org resolution (`resolvePortalOrgContext.js`); run after **055** / **056** |
| **075_portal_staff_access_tier.sql** | `portal_auth_allowlist.staff_access_tier` (`assigned_only` \| `operations`) | **`propera-app`** layered Staff nav + Portal access tier dropdown |
| **076_org_channel_config.sql** | **`org_channel_configs`** — per-org channel phone/Telegram metadata + setup status | **`portalOrgChannels.js`**, Settings → Channels (MO-3); run after **055** |
| **077_policy_change_log.sql** | **`policy_change_log`** — append-only audit for Settings policy edits | **`portalOrgPolicies.js`**, Settings → Policies (MO-2c); run after **001** |
| **078_org_onboarding.sql** | **`organizations.onboarding_completed_at`**, **`created_via`** | MO-4 wizard (`portalOrgOnboarding.js`); run after **055** |
| **085_leasing_engine_v1.sql** | `unit_leases.renewal_*`; **`leasing_prospects`** | **`leasingProspects.js`**, portal `/api/portal/leasing/*`; flags **`PROPERA_LEASING_ENGINE_ENABLED`** + **`NEXT_PUBLIC_PROPERA_LEASING_ENABLED`**; run after **049** |
| **086_staff_jarvis_voice_enabled.sql** | **`staff.jarvis_voice_enabled`** | Settings → Jarvis per-staff toggle; **`jarvisStaffSettings.js`**, **`portalMeFromSupabase`** |
| **087_unit_occupancies_v1.sql** | **`unit_occupancies`**, **`portal_unit_occupancies_v1`**; backfill from active roster + lease | **`unitOccupancies.js`**, portal **`/api/portal/occupancies*`**; flag **`PROPERA_UNIT_LIFECYCLE_ENABLED=1`**; see **`docs/UNIT_LIFECYCLE_BUILD_PLAN.md`** |
| **088_unit_assets_v1.sql** | **`unit_assets`**, **`portal_unit_assets_v1`**; one active row per asset type per unit | **`unitAssets.js`**, portal **`/api/portal/unit-assets*`**; same lifecycle flag; see **`docs/UNIT_LIFECYCLE_BUILD_PLAN.md`** Phase 3 |
| **089_unit_asset_nameplates_storage.sql** | Private Supabase bucket **`unit-asset-nameplates`** for nameplate photos | App upload **`/api/unit-assets/nameplate/upload`**; OCR via **`assetNameplateVision.js`** |
| **090_ticket_episode_stamp.sql** | `tickets.unit_occupancy_id`, `tickets.tenant_roster_id_at_open` | **`ticketEpisodeStamp.js`** at create; History API **`unitEpisodeTicketHistory.js`**; run after **087** |
| **091_access_locations_staff_only.sql** | `access_locations.staff_only` | Amenity program **Internal only** — staff command center only; blocks tenant portal / agent / inbound ACCESS_* |
| **094_tenant_account_snapshots_v1.sql** | **`tenant_account_snapshots`** — incumbent read-only financial facts per unit (`source_system`, `synced_at`, `payload_json`) | **`propera-app`** `accountingSnapshotImport.ts`, `financialSnapshot.ts`; import via `POST /api/financial/import/accounting-snapshots` + leasehold-bridge adapter |
| **095_unit_lease_net_rent_enrichment.sql** | **`unit_leases`**: `net_rent_cents`, `rent_subsidy_cents`, `net_rent_derived_at` | **`leaseEnrichmentImport.ts`** / `netRentEnrichmentImport.ts` on snapshot import; portfolio subsidy math |
| **096_unit_lease_deposit_enrichment.sql** | **`unit_leases`**: `key_deposit_cents`, `deposits_derived_at` | **`leaseEnrichmentImport.ts`**; unit hub + `/financial/properties/[p]` deposit display |
| **097_unit_lease_other_pet_deposit_enrichment.sql** | **`unit_leases`**: `other_deposit_cents`, `pet_deposit_cents` | **`leaseEnrichmentImport.ts`**; LH “Other Security” bucket split (Key + Pet + Other = LH Other) |
| **053_financial_intake_cost_capture.sql** | **`ticket_cost_entries`**: `receipt_status`, `voided_at`, `capture_idempotency_key` | Financial Intake V1 chat capture — **`docs/FINANCIAL_INTAKE_V1.md`** |
| **061_open_deck_day_chart_note.sql** | Comment-only (no schema) | Open deck day chart — **`GET /api/portal/tickets/day-curve`**; see **`docs/OPEN_DECK_DAY_CHART_V1.md`** |
| **069_vendor_lane_v1.sql** | **`vendor_contacts`**, **`vendor_conversation_ctx`**, dispatch columns on **`tickets`** | **`docs/VENDOR_LANE.md`** — assign + dispatch + inbound YES/NO |
| **073_portal_tickets_vendor_lane.sql** | Replaces **`portal_tickets_v1`** with vendor dispatch/status fields | PM cockpit vendor columns |
| **098_balance_reminder_automation.sql** | **`balance_reminder_runs`** — monthly dedupe + campaign audit | **`docs/BALANCE_REMINDER_AUTOMATION.md`** |
| **099_balance_reminder_rules_portal.sql** | **`balance_reminder_settings`**, **`balance_reminder_rules`** | Portal-configured rent reminder steps |
| **100_balance_reminder_send_time.sql** | `send_hour` / `send_minute` on **`balance_reminder_settings`** | Scheduled send time gate |
| **100_access_passes_external_credential_id.sql** | **`access_passes.external_credential_id`** | Seam lock revoke id — Access Engine |
| **101_balance_reminder_message_wrap.sql** | `message_header` / `message_footer` on **`balance_reminder_settings`** | Custom SMS wrap text |
| **102_org_broadcast_sms_templates.sql** | **`organizations.comm_sms_header_template`**, **`comm_sms_footer_template`** | Communication Engine + balance reminder SMS wrap |

**Leasehold financial ingest (094–097):** apply all four before first full import. Join keys in SQL: `unit_leases.unit_catalog_id` → **`public.units`** (`id`), not a `unit_catalog` table. Property filter: `unit_leases.property_code` or `units.property_code` (both reference `properties.code`).

**Balance reminders (098–101):** require Communication Engine (**055**) + Leasehold snapshots (**094**) for balance data. Enable **`PROPERA_BALANCE_REMINDER_ENABLED=1`** on V2.

**Note:** two files share prefix **100** — apply both; consider renumbering in a future cleanup migration.

### Minimum paths

- **Telegram + router only (no ticket create):** 001, 002, 003, 005 (002 optional).
- **Core maintenance (finalize + schedule):** 001 → 002 → 003 → **008** → **009** → 005 → **006** → (optional **010** alias seed) → (run **004** or insert `property_policy` rows manually for schedule policy parity).

**Full dev parity (roster + GLOBAL policy seed):** run **004** after `003`; you can still run **008** afterward (no-op for columns already added by 004).
