/**
 * Utility meter batch runs — batch_media_runs + utility_meter_readings (MVP 1a).
 */
const { getSupabase } = require("../db/supabase");
const {
  supabaseUrl,
  openaiApiKey,
  meterRegisterLastDigitZero,
  meterExpectedRegisterDigits,
} = require("../config/env");
const { validateMeterReading } = require("../meterRuns/validateMeterReading");
const { extractMeterReadingFromImage } = require("../meterRuns/extractMeterReading");
const { tryDecodeQrFromImageBuffer } = require("../meterRuns/decodeMeterQr");
const {
  normMeterKey,
  buildMeterKeyCandidates,
  findUniquePartialMeter,
} = require("../meterRuns/meterKeyAliases");

const BUCKET_DEFAULT = "utility-meter-runs";

/** Public bucket URL for portal review thumbnails (bucket is public-read per migration 031). */
function publicStorageObjectUrl(baseUrl, bucket, storagePath) {
  const b = String(baseUrl || "").replace(/\/$/, "");
  const bk = String(bucket || BUCKET_DEFAULT).trim() || BUCKET_DEFAULT;
  const key = String(storagePath || "").trim();
  if (!b || !key) return null;
  const encodedPath = key
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  return `${b}/storage/v1/object/public/${encodeURIComponent(bk)}/${encodedPath}`;
}

function normProp(code) {
  return String(code || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "_");
}

function periodToDate(periodMonth) {
  const s = String(periodMonth || "").trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}$/.test(s)) return `${s}-01`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return null;
}

/**
 * @param {{ propertyCode: string, periodMonth: string }} p
 */
async function createMeterRun(p) {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db" };

  const propertyCode = normProp(p.propertyCode);
  const periodDate = periodToDate(p.periodMonth);
  if (!propertyCode || !periodDate) {
    return { ok: false, error: "bad_property_or_period" };
  }

  const { data: meters, error: mErr } = await sb
    .from("utility_meters")
    .select("id, meter_key, previous_reading")
    .eq("property_code", propertyCode)
    .eq("active", true);

  if (mErr) return { ok: false, error: String(mErr.message || mErr) };

  const { data: run, error: rErr } = await sb
    .from("batch_media_runs")
    .insert({
      run_type: "METER_BILLING_RUN",
      property_code: propertyCode,
      period_month: periodDate,
      status: "DRAFT",
      expected_meter_count: (meters || []).length,
    })
    .select("id")
    .single();

  if (rErr || !run) return { ok: false, error: String(rErr?.message || rErr || "insert_failed") };

  const runId = run.id;
  const rows = (meters || []).map((m) => ({
    run_id: runId,
    meter_id: m.id,
    previous_reading: m.previous_reading != null ? Number(m.previous_reading) : null,
    status: "MISSING",
    review_reasons: [],
  }));

  if (rows.length > 0) {
    const { error: insErr } = await sb.from("utility_meter_readings").insert(rows);
    if (insErr) return { ok: false, error: String(insErr.message || insErr) };
  }

  await sb
    .from("batch_media_runs")
    .update({
      status: "READY",
      updated_at: new Date().toISOString(),
    })
    .eq("id", runId);

  return { ok: true, runId };
}

async function listMeterRuns({ propertyCode } = {}) {
  const sb = getSupabase();
  if (!sb) return [];
  let q = sb
    .from("batch_media_runs")
    .select(
      "id, run_type, property_code, period_month, status, expected_meter_count, uploaded_asset_count, processed_asset_count, auto_accepted_count, review_count, missing_count, created_at"
    )
    .eq("run_type", "METER_BILLING_RUN")
    .order("created_at", { ascending: false })
    .limit(100);
  const pc = propertyCode ? normProp(propertyCode) : "";
  if (pc) q = q.eq("property_code", pc);
  const { data, error } = await q;
  if (error || !data) return [];
  return data;
}

async function getMeterRunDetail(runId) {
  const sb = getSupabase();
  if (!sb) return null;
  const { data: run, error: rErr } = await sb
    .from("batch_media_runs")
    .select("*")
    .eq("id", runId)
    .maybeSingle();
  if (rErr || !run) return null;

  const { data: readingsRaw, error: rdErr } = await sb
    .from("utility_meter_readings")
    .select(
      "id, meter_id, asset_id, previous_reading, current_reading, usage, estimated_charge, status, review_reasons, extraction_json, corrected_from, corrected_by, corrected_at"
    )
    .eq("run_id", runId);

  if (rdErr) return { ...run, readings: [], readingsError: String(rdErr.message || rdErr) };

  const readings = readingsRaw || [];
  const meterIds = [...new Set(readings.map((r) => r.meter_id).filter(Boolean))];
  let meterById = {};
  if (meterIds.length > 0) {
    const { data: meters } = await sb
      .from("utility_meters")
      .select("id, meter_key, unit_label, utility_type")
      .in("id", meterIds);
    meterById = Object.fromEntries((meters || []).map((m) => [m.id, m]));
  }
  const { data: assets, error: aErr } = await sb
    .from("batch_media_assets")
    .select("id, storage_bucket, storage_path, mime_type, processing_status, last_error, created_at")
    .eq("run_id", runId)
    .order("created_at", { ascending: true });

  const assetList = aErr ? [] : assets || [];
  const assetById = Object.fromEntries(assetList.map((a) => [a.id, a]));

  const readingsWithMeters = readings.map((r) => {
    const base = {
      ...r,
      utility_meters: meterById[r.meter_id] || null,
    };
    const a = r.asset_id ? assetById[r.asset_id] : null;
    const photo_public_url =
      supabaseUrl && a
        ? publicStorageObjectUrl(supabaseUrl, a.storage_bucket || BUCKET_DEFAULT, a.storage_path)
        : null;
    return { ...base, photo_public_url };
  });

  return {
    ...run,
    readings: readingsWithMeters,
    assets: assetList.map((a) => ({
      id: a.id,
      storage_path: a.storage_path,
      mime_type: a.mime_type,
      processing_status: a.processing_status,
      last_error: a.last_error,
      photo_public_url: supabaseUrl
        ? publicStorageObjectUrl(supabaseUrl, a.storage_bucket || BUCKET_DEFAULT, a.storage_path)
        : null,
    })),
  };
}

async function registerAsset({ runId, storagePath, mimeType, storageBucket }) {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db" };
  const bucket = String(storageBucket || BUCKET_DEFAULT).trim() || BUCKET_DEFAULT;
  const path = String(storagePath || "").trim();
  if (!runId || !path) return { ok: false, error: "bad_input" };

  const { data: run } = await sb.from("batch_media_runs").select("id, status").eq("id", runId).maybeSingle();
  if (!run) return { ok: false, error: "run_not_found" };

  const { data: asset, error } = await sb
    .from("batch_media_assets")
    .insert({
      run_id: runId,
      storage_bucket: bucket,
      storage_path: path,
      mime_type: mimeType || null,
      processing_status: "UPLOADED",
    })
    .select("id")
    .single();

  if (error || !asset) return { ok: false, error: String(error?.message || error || "insert_failed") };

  await refreshUploadedCount(runId);
  await sb
    .from("batch_media_runs")
    .update({
      status: "UPLOADING",
      updated_at: new Date().toISOString(),
    })
    .eq("id", runId);

  return { ok: true, assetId: asset.id };
}

async function refreshUploadedCount(runId) {
  const sb = getSupabase();
  if (!sb) return;
  const { count } = await sb
    .from("batch_media_assets")
    .select("id", { count: "exact", head: true })
    .eq("run_id", runId);
  await sb
    .from("batch_media_runs")
    .update({
      uploaded_asset_count: count || 0,
      updated_at: new Date().toISOString(),
    })
    .eq("id", runId);
}

async function matchMeterForProperty(sb, propertyCode, extraction, qrDecodedHint) {
  const { data } = await sb
    .from("utility_meters")
    .select("id, meter_key")
    .eq("property_code", propertyCode)
    .eq("active", true);

  const meters = data || [];
  const ex = extraction && typeof extraction === "object" ? extraction : {};
  const candidates = buildMeterKeyCandidates(propertyCode, ex, qrDecodedHint);

  for (const key of candidates) {
    const exact = meters.find((m) => normMeterKey(m.meter_key) === key);
    if (exact) return exact;
  }
  for (const key of candidates) {
    const partial = findUniquePartialMeter(meters, key);
    if (partial) return partial;
  }
  return null;
}

async function processOneAsset(assetRow) {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db" };

  const assetId = assetRow.id;
  const runId = assetRow.run_id;
  const bucket = assetRow.storage_bucket || BUCKET_DEFAULT;
  const path = assetRow.storage_path;

  await sb
    .from("batch_media_assets")
    .update({ processing_status: "PROCESSING", last_error: null })
    .eq("id", assetId);

  const { data: run } = await sb.from("batch_media_runs").select("property_code").eq("id", runId).maybeSingle();
  if (!run) {
    await sb
      .from("batch_media_assets")
      .update({ processing_status: "FAILED", last_error: "run_missing" })
      .eq("id", assetId);
    return { ok: false, error: "run_missing" };
  }

  const propertyCode = run.property_code;

  const dl = await sb.storage.from(bucket).download(path);
  if (dl.error || !dl.data) {
    await sb
      .from("batch_media_assets")
      .update({
        processing_status: "FAILED",
        last_error: String(dl.error?.message || "download_failed"),
      })
      .eq("id", assetId);
    return { ok: false, error: "download_failed" };
  }

  const buf = Buffer.from(await dl.data.arrayBuffer());
  const mime = assetRow.mime_type || "image/jpeg";
  const qrHint = tryDecodeQrFromImageBuffer(buf, mime);
  const tensPolicy = meterRegisterLastDigitZero();
  const expRegDigits = meterExpectedRegisterDigits();

  let extraction;
  try {
    extraction = await extractMeterReadingFromImage(buf, mime, {
      qrDecodedHint: qrHint,
      lastDigitMustBeZero: tensPolicy,
      expectedRegisterDigitCount: expRegDigits,
    });
  } catch (e) {
    await sb
      .from("batch_media_assets")
      .update({
        processing_status: "FAILED",
        last_error: String(e && e.message ? e.message : e),
      })
      .eq("id", assetId);
    return { ok: false, error: "extract_throw" };
  }

  const meter = await matchMeterForProperty(sb, propertyCode, extraction, qrHint);
  if (!meter) {
    await sb
      .from("batch_media_assets")
      .update({
        processing_status: "FAILED",
        extraction_json: extraction,
        last_error: "meter_not_matched",
      })
      .eq("id", assetId);
    return { ok: false, error: "meter_not_matched" };
  }

  const { data: reading } = await sb
    .from("utility_meter_readings")
    .select("*")
    .eq("run_id", runId)
    .eq("meter_id", meter.id)
    .maybeSingle();

  if (!reading) {
    await sb
      .from("batch_media_assets")
      .update({
        processing_status: "FAILED",
        extraction_json: extraction,
        last_error: "reading_row_missing",
      })
      .eq("id", assetId);
    return { ok: false, error: "reading_row_missing" };
  }

  if (reading.asset_id && reading.current_reading != null) {
    await sb
      .from("batch_media_assets")
      .update({
        processing_status: "VALIDATED",
        extraction_json: extraction,
        last_error: "duplicate_photo_for_meter",
      })
      .eq("id", assetId);

    await sb
      .from("utility_meter_readings")
      .update({
        status: "DUPLICATE",
        review_reasons: ["duplicate_photo"],
        extraction_json: extraction,
        updated_at: new Date().toISOString(),
      })
      .eq("id", reading.id);

    await recalcRunSummary(runId);
    return { ok: true, duplicate: true };
  }

  if (openaiApiKey()) {
    try {
      extraction = await extractMeterReadingFromImage(buf, mime, {
        previousReading: reading.previous_reading,
        expectedRegisterDigitCount: expRegDigits,
        lastDigitMustBeZero: tensPolicy,
        qrDecodedHint: qrHint,
        expectedMeterId: meter.meter_key,
        refinementPass: true,
      });
      extraction.extract_pass = "refinement";
    } catch (_) {
      /* keep match-pass extraction */
    }
  }

  const currentReading =
    extraction.finalReading != null && Number.isFinite(Number(extraction.finalReading))
      ? Math.round(Number(extraction.finalReading))
      : null;

  const v = validateMeterReading({
    previousReading: reading.previous_reading,
    currentReading,
    extraction,
  });

  await sb
    .from("utility_meter_readings")
    .update({
      asset_id: assetId,
      current_reading: currentReading,
      usage: v.usage,
      status: v.status,
      review_reasons: v.reviewReasons,
      extraction_json: extraction,
    })
    .eq("id", reading.id);

  await sb
    .from("batch_media_assets")
    .update({
      processing_status: v.status === "MISSING" ? "EXTRACTED" : "VALIDATED",
      extraction_json: extraction,
    })
    .eq("id", assetId);

  await recalcRunSummary(runId);
  return { ok: true };
}

async function processPendingAssets(runId, { limit = 100 } = {}) {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db" };

  await sb
    .from("batch_media_runs")
    .update({
      status: "PROCESSING",
      updated_at: new Date().toISOString(),
    })
    .eq("id", runId);

  const { data: assets } = await sb
    .from("batch_media_assets")
    .select("*")
    .eq("run_id", runId)
    /* FAILED: allow re-running extract/match after fixes or transient errors; skip EXTRACTED/VALIDATED (already done). */
    .in("processing_status", ["UPLOADED", "QUEUED", "FAILED"])
    .order("created_at", { ascending: true })
    .limit(limit);

  const results = [];
  for (const a of assets || []) {
    results.push(await processOneAsset(a));
  }

  await recalcRunSummary(runId);
  return { ok: true, processed: results.length, results };
}

async function recalcRunSummary(runId) {
  const sb = getSupabase();
  if (!sb) return;

  const { data: readings } = await sb.from("utility_meter_readings").select("status").eq("run_id", runId);

  let autoAccepted = 0;
  let review = 0;
  let missing = 0;
  for (const r of readings || []) {
    const s = r.status;
    if (s === "AUTO_ACCEPTED") autoAccepted += 1;
    else if (s === "MISSING") missing += 1;
    else if (s === "CHECK_PHOTO" || s === "DUPLICATE" || s === "REJECTED") review += 1;
    else if (s === "CORRECTED") autoAccepted += 1;
  }

  const { count: uploaded } = await sb
    .from("batch_media_assets")
    .select("id", { count: "exact", head: true })
    .eq("run_id", runId);

  const { count: processed } = await sb
    .from("batch_media_assets")
    .select("id", { count: "exact", head: true })
    .eq("run_id", runId)
    .in("processing_status", ["EXTRACTED", "VALIDATED", "FAILED"]);

  let status = "UPLOADING";
  const up = uploaded || 0;
  const proc = processed || 0;
  if (up === 0) {
    status = "READY";
  } else if (proc < up) {
    status = "PROCESSING";
  } else {
    const needReview = (readings || []).some((x) =>
      ["CHECK_PHOTO", "DUPLICATE", "MISSING", "REJECTED"].includes(x.status)
    );
    status = needReview ? "REVIEW_REQUIRED" : "BILLING_READY";
  }

  await sb
    .from("batch_media_runs")
    .update({
      uploaded_asset_count: up,
      processed_asset_count: proc,
      auto_accepted_count: autoAccepted,
      review_count: review,
      missing_count: missing,
      status,
      updated_at: new Date().toISOString(),
    })
    .eq("id", runId);
}

/**
 * @param {{ readingId: string, currentReading: number, correctedBy: string }} p
 */
async function correctMeterReading(p) {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db" };
  const id = String(p.readingId || "").trim();
  const cur = Math.round(Number(p.currentReading));
  const by = String(p.correctedBy || "office").trim() || "office";
  if (!id || !Number.isFinite(cur)) return { ok: false, error: "bad_input" };

  const { data: row } = await sb.from("utility_meter_readings").select("*").eq("id", id).maybeSingle();
  if (!row) return { ok: false, error: "not_found" };

  const prevVal = row.current_reading != null ? Number(row.current_reading) : null;
  const v = validateMeterReading({
    previousReading: row.previous_reading,
    currentReading: cur,
    extraction: { ...(row.extraction_json || {}), needsReviewHint: false, confidence: "high" },
  });

  await sb
    .from("utility_meter_readings")
    .update({
      current_reading: cur,
      usage: v.usage,
      status: "CORRECTED",
      review_reasons: [],
      corrected_from: prevVal,
      corrected_by: by,
      corrected_at: new Date().toISOString(),
    })
    .eq("id", id);

  await recalcRunSummary(row.run_id);
  return { ok: true };
}

async function listUtilityMeters(propertyCode) {
  const sb = getSupabase();
  if (!sb) return [];
  const pc = normProp(propertyCode);
  if (!pc) return [];
  const { data, error } = await sb
    .from("utility_meters")
    .select("id, meter_key, property_code, unit_label, utility_type, previous_reading, active, location_note")
    .eq("property_code", pc)
    .eq("active", true)
    .order("meter_key");
  if (error || !data) return [];
  const meters = data;
  const meterIds = meters.map((m) => m.id).filter(Boolean);
  if (meterIds.length === 0) return meters;

  const { data: readings, error: rdErr } = await sb
    .from("utility_meter_readings")
    .select("meter_id, current_reading, run_id")
    .in("meter_id", meterIds);

  if (rdErr || !readings || readings.length === 0) {
    return meters.map((m) => ({
      ...m,
      latest_current_reading: null,
      latest_period_month: null,
    }));
  }

  const withCurr = readings.filter(
    (r) => r.current_reading != null && Number.isFinite(Number(r.current_reading))
  );
  const runIds = [...new Set(withCurr.map((r) => r.run_id).filter(Boolean))];
  let periodByRunId = {};
  if (runIds.length > 0) {
    const { data: runs } = await sb.from("batch_media_runs").select("id, period_month").in("id", runIds);
    periodByRunId = Object.fromEntries((runs || []).map((r) => [r.id, r.period_month]));
  }

  const bestByMeter = {};
  for (const r of withCurr) {
    const period = periodByRunId[r.run_id];
    if (period == null) continue;
    const periodStr = String(period).slice(0, 10);
    const prev = bestByMeter[r.meter_id];
    if (!prev || periodStr > prev.periodStr) {
      bestByMeter[r.meter_id] = {
        periodStr,
        latest_current_reading: Number(r.current_reading),
        latest_period_month: period,
      };
    }
  }

  return meters.map((m) => {
    const b = bestByMeter[m.id];
    return {
      ...m,
      latest_current_reading: b ? b.latest_current_reading : null,
      latest_period_month: b ? b.latest_period_month : null,
    };
  });
}

/**
 * Soft-delete: keeps row for FK history; hidden from list and excluded from new runs.
 * @param {{ meterId: string, propertyCode?: string }} p
 */
async function deactivateUtilityMeter(p) {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db" };
  const id = String(p.meterId || "").trim();
  if (!id) return { ok: false, error: "bad_input" };
  const pc = p.propertyCode ? normProp(p.propertyCode) : "";

  let q = sb.from("utility_meters").update({ active: false }).eq("id", id);
  if (pc) q = q.eq("property_code", pc);
  const { data, error } = await q.select("id").maybeSingle();

  if (error) return { ok: false, error: String(error.message || error) };
  if (!data) return { ok: false, error: "not_found" };
  return { ok: true };
}

async function upsertUtilityMeter(body) {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db" };
  const propertyCode = normProp(body.propertyCode);
  const meterKey = normMeterKey(body.meterKey);
  if (!propertyCode || !meterKey) return { ok: false, error: "bad_input" };

  const { data: propRow, error: propErr } = await sb
    .from("properties")
    .select("code")
    .eq("code", propertyCode)
    .maybeSingle();
  if (propErr) return { ok: false, error: String(propErr.message || propErr) };
  if (!propRow) {
    return {
      ok: false,
      error: "unknown_property_code",
      hint:
        "No Supabase properties row matches this building code yet. Confirm the dropdown code exists in Propera Properties (or run your property sync migration) before registering meters.",
    };
  }

  let previousReading = null;
  if (body.previousReading != null && body.previousReading !== "") {
    const n = Number(body.previousReading);
    if (!Number.isFinite(n)) return { ok: false, error: "bad_previous_reading" };
    previousReading = Math.round(n);
  }

  const row = {
    property_code: propertyCode,
    meter_key: meterKey,
    unit_label: String(body.unitLabel || "").trim(),
    utility_type: String(body.utilityType || "water").trim().toLowerCase() || "water",
    location_note: body.locationNote != null ? String(body.locationNote) : "",
    previous_reading: previousReading,
    active: body.active !== false,
  };

  const { error } = await sb.from("utility_meters").upsert(row, {
    onConflict: "property_code,meter_key",
  });
  if (error) return { ok: false, error: String(error.message || error) };
  return { ok: true };
}

function csvEscape(s) {
  const t = String(s ?? "");
  if (/[",\n\r]/.test(t)) return `"${t.replace(/"/g, '""')}"`;
  return t;
}

async function exportMeterRunCsv(runId) {
  const detail = await getMeterRunDetail(runId);
  if (!detail || !detail.readings) return null;

  const headers = [
    "meter_key",
    "unit_label",
    "previous_reading",
    "current_reading",
    "usage",
    "status",
    "review_reasons",
  ];
  const lines = [headers.join(",")];
  for (const r of detail.readings) {
    const m = r.utility_meters || {};
    const reasons = Array.isArray(r.review_reasons) ? r.review_reasons.join(";") : "";
    lines.push(
      [
        csvEscape(m.meter_key),
        csvEscape(m.unit_label),
        csvEscape(r.previous_reading),
        csvEscape(r.current_reading),
        csvEscape(r.usage),
        csvEscape(r.status),
        csvEscape(reasons),
      ].join(",")
    );
  }
  return lines.join("\r\n");
}

/**
 * Remove a photo from the run: clears any reading tied to this asset, deletes storage object, deletes row.
 * @param {{ runId: string, assetId: string }} p
 */
async function deleteMeterRunAsset(p) {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db" };
  const rid = String(p.runId || "").trim();
  const aid = String(p.assetId || "").trim();
  if (!rid || !aid) return { ok: false, error: "bad_input" };

  const { data: asset, error: fetchErr } = await sb
    .from("batch_media_assets")
    .select("id, run_id, storage_bucket, storage_path")
    .eq("id", aid)
    .maybeSingle();

  if (fetchErr || !asset) return { ok: false, error: "asset_not_found" };
  if (String(asset.run_id) !== rid) return { ok: false, error: "asset_not_found" };

  await sb
    .from("utility_meter_readings")
    .update({
      asset_id: null,
      current_reading: null,
      usage: null,
      status: "MISSING",
      review_reasons: [],
      extraction_json: null,
      corrected_from: null,
      corrected_by: null,
      corrected_at: null,
    })
    .eq("run_id", rid)
    .eq("asset_id", aid);

  const bucket = asset.storage_bucket || BUCKET_DEFAULT;
  const path = String(asset.storage_path || "").trim();
  if (path) {
    const { error: rmErr } = await sb.storage.from(bucket).remove([path]);
    if (rmErr) {
      /* continue — DB row removal still desired */
    }
  }

  const { error: delErr } = await sb.from("batch_media_assets").delete().eq("id", aid);
  if (delErr) return { ok: false, error: String(delErr.message || delErr) };

  await recalcRunSummary(rid);
  return { ok: true };
}

module.exports = {
  createMeterRun,
  listMeterRuns,
  getMeterRunDetail,
  registerAsset,
  deleteMeterRunAsset,
  processPendingAssets,
  correctMeterReading,
  listUtilityMeters,
  upsertUtilityMeter,
  deactivateUtilityMeter,
  exportMeterRunCsv,
  normProp,
  normMeterKey,
};
