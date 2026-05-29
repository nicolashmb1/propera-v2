const ACCESS_LIFECYCLE_JOB_STATUS = {
  PENDING: "PENDING",
  CLAIMED: "CLAIMED",
  COMPLETED: "COMPLETED",
  CANCELLED: "CANCELLED",
};

const ACCESS_LIFECYCLE_JOB_TYPES = {
  APPROVAL_TIMEOUT: "APPROVAL_TIMEOUT",
  REMINDER: "REMINDER",
  START_WINDOW: "START_WINDOW",
  END_WINDOW: "END_WINDOW",
};

function normalizeJobType(jobType) {
  const key = String(jobType || "").trim().toUpperCase();
  return ACCESS_LIFECYCLE_JOB_TYPES[key] || key;
}

function normalizeJobStatus(status) {
  const key = String(status || "").trim().toUpperCase();
  return ACCESS_LIFECYCLE_JOB_STATUS[key] || key;
}

function asIsoOrNull(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(d.getTime())) return null;
  return d.toISOString();
}

function mapLifecycleJobRow(row) {
  if (!row) return null;
  return {
    id: String(row.id || "").trim(),
    reservationId: String(row.reservation_id || "").trim(),
    jobType: normalizeJobType(row.job_type),
    status: normalizeJobStatus(row.status),
    runAt: row.run_at || null,
    payload:
      row.payload_json && typeof row.payload_json === "object" && !Array.isArray(row.payload_json)
        ? row.payload_json
        : {},
    claimedAt: row.claimed_at || null,
    completedAt: row.completed_at || null,
    cancelledAt: row.cancelled_at || null,
    lastError: String(row.last_error || "").trim(),
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

async function upsertAccessLifecycleJob(sb, opts) {
  const reservationId = String(opts.reservationId || "").trim();
  const jobType = normalizeJobType(opts.jobType);
  const runAt = asIsoOrNull(opts.runAt);
  if (!sb || !reservationId || !jobType || !runAt) return null;

  const row = {
    reservation_id: reservationId,
    job_type: jobType,
    status: ACCESS_LIFECYCLE_JOB_STATUS.PENDING,
    run_at: runAt,
    payload_json:
      opts.payload && typeof opts.payload === "object" && !Array.isArray(opts.payload)
        ? opts.payload
        : {},
    claimed_at: null,
    completed_at: null,
    cancelled_at: null,
    last_error: "",
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await sb
    .from("access_lifecycle_jobs")
    .upsert(row, { onConflict: "reservation_id,job_type" })
    .select("*")
    .single();

  if (error || !data) {
    throw new Error(error?.message || "access_lifecycle_job_upsert_failed");
  }
  return mapLifecycleJobRow(data);
}

async function cancelAccessLifecycleJobs(sb, reservationId, jobTypes) {
  const id = String(reservationId || "").trim();
  if (!sb || !id) return 0;

  const types = Array.isArray(jobTypes)
    ? jobTypes.map(normalizeJobType).filter(Boolean)
    : [];

  let q = sb
    .from("access_lifecycle_jobs")
    .update({
      status: ACCESS_LIFECYCLE_JOB_STATUS.CANCELLED,
      cancelled_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("reservation_id", id)
    .in("status", [
      ACCESS_LIFECYCLE_JOB_STATUS.PENDING,
      ACCESS_LIFECYCLE_JOB_STATUS.CLAIMED,
    ]);

  if (types.length) q = q.in("job_type", types);
  const { data, error } = await q.select("id");
  if (error) throw new Error(error.message || "access_lifecycle_job_cancel_failed");
  return Array.isArray(data) ? data.length : 0;
}

async function listDueAccessLifecycleJobs(sb, limit = 50) {
  if (!sb) return [];
  const cap = Math.max(1, Math.min(200, Math.floor(Number(limit) || 50)));
  const { data, error } = await sb
    .from("access_lifecycle_jobs")
    .select("*")
    .eq("status", ACCESS_LIFECYCLE_JOB_STATUS.PENDING)
    .lte("run_at", new Date().toISOString())
    .order("run_at", { ascending: true })
    .limit(cap);
  if (error || !data) return [];
  return data.map(mapLifecycleJobRow).filter(Boolean);
}

async function claimAccessLifecycleJob(sb, jobId, claimedBy = "") {
  const id = String(jobId || "").trim();
  if (!sb || !id) return null;
  const { data, error } = await sb
    .from("access_lifecycle_jobs")
    .update({
      status: ACCESS_LIFECYCLE_JOB_STATUS.CLAIMED,
      claimed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      last_error: "",
      claimed_by: String(claimedBy || "").trim(),
    })
    .eq("id", id)
    .eq("status", ACCESS_LIFECYCLE_JOB_STATUS.PENDING)
    .select("*")
    .maybeSingle();

  if (error) throw new Error(error.message || "access_lifecycle_job_claim_failed");
  return mapLifecycleJobRow(data);
}

async function completeAccessLifecycleJob(sb, jobId) {
  const id = String(jobId || "").trim();
  if (!sb || !id) return null;
  const { data, error } = await sb
    .from("access_lifecycle_jobs")
    .update({
      status: ACCESS_LIFECYCLE_JOB_STATUS.COMPLETED,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      last_error: "",
    })
    .eq("id", id)
    .select("*")
    .maybeSingle();
  if (error) throw new Error(error.message || "access_lifecycle_job_complete_failed");
  return mapLifecycleJobRow(data);
}

async function failAccessLifecycleJob(sb, jobId, err) {
  const id = String(jobId || "").trim();
  if (!sb || !id) return null;
  const message = String(err && err.message ? err.message : err || "access_lifecycle_job_failed")
    .trim()
    .slice(0, 500);
  const { data, error } = await sb
    .from("access_lifecycle_jobs")
    .update({
      status: ACCESS_LIFECYCLE_JOB_STATUS.PENDING,
      updated_at: new Date().toISOString(),
      last_error: message,
    })
    .eq("id", id)
    .select("*")
    .maybeSingle();
  if (error) throw new Error(error.message || "access_lifecycle_job_fail_failed");
  return mapLifecycleJobRow(data);
}

module.exports = {
  ACCESS_LIFECYCLE_JOB_STATUS,
  ACCESS_LIFECYCLE_JOB_TYPES,
  mapLifecycleJobRow,
  upsertAccessLifecycleJob,
  cancelAccessLifecycleJobs,
  listDueAccessLifecycleJobs,
  claimAccessLifecycleJob,
  completeAccessLifecycleJob,
  failAccessLifecycleJob,
};
