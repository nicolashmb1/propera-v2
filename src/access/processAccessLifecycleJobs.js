const { appendEventLog } = require("../dal/appendEventLog");
const {
  ACCESS_LIFECYCLE_JOB_TYPES,
  listDueAccessLifecycleJobs,
  claimAccessLifecycleJob,
  completeAccessLifecycleJob,
  failAccessLifecycleJob,
} = require("./accessLifecycleJobs");
const {
  approveReservation,
  getReservationDetail,
  markReservationActive,
  completeReservationLifecycle,
  denyReservationByTimeout,
} = require("../dal/accessEngine");

async function processAccessLifecycleJob(sb, job, traceId) {
  const reservationId = String(job.reservationId || "").trim();
  if (!reservationId) return { skipped: true, reason: "missing_reservation_id" };

  switch (job.jobType) {
    case ACCESS_LIFECYCLE_JOB_TYPES.APPROVAL_TIMEOUT: {
      const action = String(job.payload?.action || "auto_cancel").trim().toLowerCase();
      const detail = await getReservationDetail(reservationId);
      if (!detail || detail.status !== "PENDING_APPROVAL") {
        return { skipped: true, reason: "reservation_not_pending_approval" };
      }
      if (action === "auto_approve") {
        await approveReservation(reservationId, "access_lifecycle_worker", {
          traceId,
          templateKey: "ACCESS_TENANT_APPROVED",
        });
        return { processed: true, action: "auto_approve" };
      }
      await denyReservationByTimeout(reservationId, "access_lifecycle_worker", {
        traceId,
      });
      return { processed: true, action: "auto_cancel" };
    }
    case ACCESS_LIFECYCLE_JOB_TYPES.REMINDER: {
      const detail = await getReservationDetail(reservationId);
      if (!detail || detail.status !== "CONFIRMED") {
        return { skipped: true, reason: "reservation_not_confirmed" };
      }
      await markReservationActive(reservationId, {
        actor: "access_lifecycle_worker",
        traceId,
        notifyOnlyIfDue: false,
        dryRunReminder: true,
      });
      return { processed: true, action: "reminder" };
    }
    case ACCESS_LIFECYCLE_JOB_TYPES.START_WINDOW: {
      await markReservationActive(reservationId, {
        actor: "access_lifecycle_worker",
        traceId,
      });
      return { processed: true, action: "activate" };
    }
    case ACCESS_LIFECYCLE_JOB_TYPES.END_WINDOW: {
      await completeReservationLifecycle(reservationId, {
        actor: "access_lifecycle_worker",
        traceId,
      });
      return { processed: true, action: "complete" };
    }
    default:
      return { skipped: true, reason: "unknown_job_type" };
  }
}

async function processDueAccessLifecycleJobs(sb, opts = {}) {
  const traceId = String(opts.traceId || "").trim();
  const due = await listDueAccessLifecycleJobs(sb, opts.limit || 50);
  let claimed = 0;
  let processed = 0;
  let skipped = 0;

  for (const job of due) {
    const claimedJob = await claimAccessLifecycleJob(
      sb,
      job.id,
      String(opts.claimedBy || "access_lifecycle_worker").trim()
    );
    if (!claimedJob) continue;
    claimed += 1;
    try {
      const result = await processAccessLifecycleJob(sb, claimedJob, traceId);
      await completeAccessLifecycleJob(sb, claimedJob.id);
      if (result && result.processed) processed += 1;
      else skipped += 1;
      await appendEventLog({
        traceId,
        log_kind: "access_lifecycle",
        event: "ACCESS_LIFECYCLE_JOB_PROCESSED",
        payload: {
          reservation_id: claimedJob.reservationId,
          job_type: claimedJob.jobType,
          outcome: result?.processed ? "processed" : "skipped",
          reason: result?.reason || null,
          action: result?.action || null,
        },
      });
    } catch (err) {
      await failAccessLifecycleJob(sb, claimedJob.id, err);
      await appendEventLog({
        traceId,
        log_kind: "access_lifecycle",
        event: "ACCESS_LIFECYCLE_JOB_FAILED",
        payload: {
          reservation_id: claimedJob.reservationId,
          job_type: claimedJob.jobType,
          error: String(err && err.message ? err.message : err),
        },
      });
    }
  }

  return {
    due: due.length,
    claimed,
    processed,
    skipped,
  };
}

module.exports = {
  processDueAccessLifecycleJobs,
};
