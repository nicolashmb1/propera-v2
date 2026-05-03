/**
 * PM/Task V1 — program_runs + program_lines DAL (portal / future staff NL).
 * @see docs/PM_PROGRAM_ENGINE_V1.md
 */
const { getSupabase } = require("../db/supabase");
const { appendEventLog } = require("./appendEventLog");
const { resolvePropertyCodeFromLabel } = require("./portalTenants");
const { expandProgramLines } = require("../pm/expandProgramLines");

/**
 * @param {string} propertyCode
 * @returns {Promise<string>}
 */
async function getPropertyDisplayName(propertyCode) {
  const code = String(propertyCode || "").trim().toUpperCase();
  const sb = getSupabase();
  if (!sb || !code) return code;
  const { data } = await sb
    .from("properties")
    .select("display_name, code")
    .eq("code", code)
    .maybeSingle();
  if (!data) return code;
  return String(data.display_name || data.code || code).trim() || code;
}

/**
 * @param {string} propertyCode
 * @returns {Promise<{ unit_label: string }[]>}
 */
async function loadActiveUnitRows(propertyCode) {
  const code = String(propertyCode || "").trim().toUpperCase();
  const sb = getSupabase();
  if (!sb || !code) return [];
  const { data, error } = await sb
    .from("tenant_roster")
    .select("unit_label")
    .eq("property_code", code)
    .eq("active", true);

  if (error || !data) return [];
  return data.map((r) => ({ unit_label: String(r.unit_label || "").trim() }));
}

/**
 * @param {string} templateKey
 * @returns {Promise<object|null>}
 */
async function getTemplate(templateKey) {
  const key = String(templateKey || "").trim().toUpperCase();
  const sb = getSupabase();
  if (!sb || !key) return null;
  const { data, error } = await sb
    .from("program_templates")
    .select("template_key, label, expansion_type, default_scope_labels")
    .eq("template_key", key)
    .maybeSingle();
  if (error || !data) return null;
  return data;
}

async function recalcProgramRunStatus(sb, programRunId) {
  const { data: lines } = await sb
    .from("program_lines")
    .select("status")
    .eq("program_run_id", programRunId);

  if (!lines || !lines.length) {
    await sb
      .from("program_runs")
      .update({
        status: "OPEN",
        updated_at: new Date().toISOString(),
      })
      .eq("id", programRunId);
    return;
  }

  const complete = lines.filter((l) => String(l.status).toUpperCase() === "COMPLETE").length;
  const total = lines.length;
  let status = "OPEN";
  if (complete === total) status = "COMPLETE";
  else if (complete > 0) status = "IN_PROGRESS";

  await sb
    .from("program_runs")
    .update({
      status,
      updated_at: new Date().toISOString(),
    })
    .eq("id", programRunId);
}

/**
 * @param {object} o
 * @param {string} [o.property] — display name or code (Murray / MURRAY)
 * @param {string} [o.propertyCode] — canonical code override
 * @param {string} o.templateKey — e.g. HVAC_PM
 * @param {string} [o.createdBy]
 * @param {string} [o.traceId]
 * @returns {Promise<{ ok: boolean, run?: object, lines?: object[], error?: string }>}
 */
async function createProgramRun(o) {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db" };

  const templateKey = String(o.templateKey || "")
    .trim()
    .toUpperCase();
  if (!templateKey) return { ok: false, error: "missing_template_key" };

  const template = await getTemplate(templateKey);
  if (!template) return { ok: false, error: "unknown_template" };

  let propertyCode = String(o.propertyCode || "").trim().toUpperCase();
  if (!propertyCode) {
    propertyCode = await resolvePropertyCodeFromLabel(
      sb,
      String(o.property || "").trim()
    );
  }
  if (!propertyCode) return { ok: false, error: "unknown_property" };

  const { data: propRow } = await sb
    .from("properties")
    .select("code, program_expansion_profile")
    .eq("code", propertyCode)
    .maybeSingle();
  if (!propRow) return { ok: false, error: "unknown_property" };

  const unitRows =
    String(template.expansion_type) === "UNIT_PLUS_COMMON"
      ? await loadActiveUnitRows(propertyCode)
      : [];

  const lineSpecs = expandProgramLines(template, unitRows, {
    expansionProfile: propRow.program_expansion_profile,
  });
  const displayName = await getPropertyDisplayName(propertyCode);
  const title = `${displayName} — ${template.label}`;

  const createdBy = String(o.createdBy || "PORTAL").slice(0, 200);
  const traceId = String(o.traceId || "");

  const runInsert = {
    property_code: propertyCode,
    template_key: templateKey,
    title,
    status: lineSpecs.length === 0 ? "OPEN" : "OPEN",
    created_by: createdBy,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const { data: run, error: runErr } = await sb
    .from("program_runs")
    .insert(runInsert)
    .select(
      "id, property_code, template_key, title, status, created_by, created_at, updated_at"
    )
    .maybeSingle();

  if (runErr || !run) {
    return { ok: false, error: runErr?.message || "insert_failed" };
  }

  const runId = run.id;
  let insertedLines = [];

  if (lineSpecs.length) {
    const rows = lineSpecs.map((spec) => ({
      program_run_id: runId,
      scope_type: spec.scope_type,
      scope_label: spec.scope_label,
      sort_order: spec.sort_order,
      status: "OPEN",
      completed_by: "",
      notes: "",
    }));

    const { data: linesOut, error: linesErr } = await sb
      .from("program_lines")
      .insert(rows)
      .select(
        "id, program_run_id, scope_type, scope_label, sort_order, status, completed_by, completed_at, notes"
      );

    if (linesErr) {
      await sb.from("program_runs").delete().eq("id", runId);
      return { ok: false, error: linesErr.message || "lines_insert_failed" };
    }
    insertedLines = linesOut || [];

    const done = insertedLines.filter((l) => l.status === "COMPLETE").length;
    const total = insertedLines.length;
    let nextStatus = "OPEN";
    if (done === total && total > 0) nextStatus = "COMPLETE";
    else if (done > 0) nextStatus = "IN_PROGRESS";

    if (nextStatus !== run.status) {
      await sb
        .from("program_runs")
        .update({ status: nextStatus, updated_at: new Date().toISOString() })
        .eq("id", runId);
      run.status = nextStatus;
    }
  }

  await appendEventLog({
    traceId,
    log_kind: "portal",
    event: "PROGRAM_RUN_CREATED",
    payload: {
      program_run_id: runId,
      property_code: propertyCode,
      template_key: templateKey,
      line_count: insertedLines.length,
    },
  });

  return {
    ok: true,
    run,
    lines: insertedLines,
  };
}

/**
 * Dry-run line expansion for PM/Task V1 (no DB writes).
 * @param {object} o
 * @param {string} [o.property]
 * @param {string} [o.propertyCode]
 * @param {string} o.templateKey
 * @returns {Promise<{ ok: boolean; lines?: object[]; expansion_type?: string; template_key?: string; property_code?: string; error?: string }>}
 */
/**
 * @param {string} runId
 * @param {object} [o]
 * @param {string} [o.traceId]
 * @returns {Promise<{ ok: boolean; error?: string }>}
 */
async function deleteProgramRun(runId, o) {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db" };

  const id = String(runId || "").trim();
  if (!id) return { ok: false, error: "missing_run_id" };

  const { data: existing, error: fetchErr } = await sb
    .from("program_runs")
    .select("id, property_code, template_key, title")
    .eq("id", id)
    .maybeSingle();

  if (fetchErr) return { ok: false, error: fetchErr.message || "fetch_failed" };
  if (!existing) return { ok: false, error: "not_found" };

  const { error: delErr } = await sb.from("program_runs").delete().eq("id", id);
  if (delErr) return { ok: false, error: delErr.message || "delete_failed" };

  await appendEventLog({
    traceId: String(o?.traceId || ""),
    log_kind: "portal",
    event: "PROGRAM_RUN_DELETED",
    payload: {
      program_run_id: id,
      property_code: String(existing.property_code || ""),
      template_key: String(existing.template_key || ""),
      title: String(existing.title || ""),
    },
  });

  return { ok: true };
}

async function previewProgramRunExpansion(o) {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db" };

  const templateKey = String(o.templateKey || "")
    .trim()
    .toUpperCase();
  if (!templateKey) return { ok: false, error: "missing_template_key" };

  const template = await getTemplate(templateKey);
  if (!template) return { ok: false, error: "unknown_template" };

  let propertyCode = String(o.propertyCode || "").trim().toUpperCase();
  if (!propertyCode) {
    propertyCode = await resolvePropertyCodeFromLabel(
      sb,
      String(o.property || "").trim()
    );
  }
  if (!propertyCode) return { ok: false, error: "unknown_property" };

  const { data: propRow } = await sb
    .from("properties")
    .select("code, program_expansion_profile")
    .eq("code", propertyCode)
    .maybeSingle();
  if (!propRow) return { ok: false, error: "unknown_property" };

  const unitRows =
    String(template.expansion_type) === "UNIT_PLUS_COMMON"
      ? await loadActiveUnitRows(propertyCode)
      : [];

  const lineSpecs = expandProgramLines(template, unitRows, {
    expansionProfile: propRow.program_expansion_profile,
  });

  return {
    ok: true,
    lines: lineSpecs,
    expansion_type: String(template.expansion_type || ""),
    template_key: templateKey,
    property_code: propertyCode,
  };
}

/**
 * @returns {Promise<object[]>}
 */
async function listProgramRuns() {
  const sb = getSupabase();
  if (!sb) return [];

  const { data: runs, error } = await sb
    .from("program_runs")
    .select(
      "id, property_code, template_key, title, status, created_by, created_at, updated_at"
    )
    .order("created_at", { ascending: false });

  if (error || !runs) return [];

  const ids = runs.map((r) => r.id);
  if (!ids.length) return runs.map(enrichRunSummary);

  const { data: lineRows } = await sb
    .from("program_lines")
    .select("program_run_id, status")
    .in("program_run_id", ids);

  const totalByRun = {};
  const completeByRun = {};
  for (const row of lineRows || []) {
    const rid = row.program_run_id;
    totalByRun[rid] = (totalByRun[rid] || 0) + 1;
    if (String(row.status).toUpperCase() === "COMPLETE") {
      completeByRun[rid] = (completeByRun[rid] || 0) + 1;
    }
  }

  const { data: templates } = await sb
    .from("program_templates")
    .select("template_key, label");

  const labelByKey = {};
  for (const t of templates || []) {
    labelByKey[String(t.template_key).toUpperCase()] = String(t.label || "").trim();
  }

  const displayNames = {};
  const codes = [...new Set(runs.map((r) => String(r.property_code || "").toUpperCase()))];
  if (codes.length) {
    const { data: props } = await sb
      .from("properties")
      .select("code, display_name")
      .in("code", codes);
    for (const p of props || []) {
      const c = String(p.code || "").trim().toUpperCase();
      displayNames[c] = String(p.display_name || c).trim() || c;
    }
  }

  return runs.map((r) => {
    const id = r.id;
    const total = totalByRun[id] || 0;
    const complete = completeByRun[id] || 0;
    const pc = String(r.property_code || "").trim().toUpperCase();
    return {
      ...r,
      property_display: displayNames[pc] || pc,
      template_label: labelByKey[String(r.template_key).toUpperCase()] || r.template_key,
      line_total: total,
      line_complete: complete,
    };
  });
}

/**
 * @param {string} runId
 * @returns {Promise<object|null>}
 */
async function getProgramRunById(runId) {
  const id = String(runId || "").trim();
  const sb = getSupabase();
  if (!sb || !id) return null;

  const { data: run, error } = await sb
    .from("program_runs")
    .select(
      "id, property_code, template_key, title, status, created_by, created_at, updated_at"
    )
    .eq("id", id)
    .maybeSingle();

  if (error || !run) return null;

  const { data: lines } = await sb
    .from("program_lines")
    .select(
      "id, program_run_id, scope_type, scope_label, sort_order, status, completed_by, completed_at, notes"
    )
    .eq("program_run_id", id)
    .order("sort_order", { ascending: true })
    .order("scope_label", { ascending: true });

  const { data: tmpl } = await sb
    .from("program_templates")
    .select("label, expansion_type")
    .eq("template_key", run.template_key)
    .maybeSingle();

  const total = (lines || []).length;
  const complete = (lines || []).filter(
    (l) => String(l.status).toUpperCase() === "COMPLETE"
  ).length;

  const propDisplay = await getPropertyDisplayName(run.property_code);

  return {
    ...run,
    property_display: propDisplay,
    template_label: tmpl?.label || run.template_key,
    expansion_type: tmpl?.expansion_type || "",
    lines: lines || [],
    line_total: total,
    line_complete: complete,
  };
}

/**
 * @param {string} lineId
 * @param {object} o
 * @param {string} [o.completedBy]
 * @param {string} [o.notes]
 * @param {string} [o.traceId]
 */
async function completeProgramLine(lineId, o) {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db" };

  const id = String(lineId || "").trim();
  if (!id) return { ok: false, error: "missing_line_id" };

  const { data: line, error: lineErr } = await sb
    .from("program_lines")
    .select("id, program_run_id, status")
    .eq("id", id)
    .maybeSingle();

  if (lineErr || !line) return { ok: false, error: "not_found" };

  const completedBy = String(o?.completedBy || "PORTAL").slice(0, 200);
  const notes = String(o?.notes || "").slice(0, 2000);
  const now = new Date().toISOString();

  const { error: upErr } = await sb
    .from("program_lines")
    .update({
      status: "COMPLETE",
      completed_by: completedBy,
      completed_at: now,
      notes,
    })
    .eq("id", id);

  if (upErr) return { ok: false, error: upErr.message || "update_failed" };

  await recalcProgramRunStatus(sb, line.program_run_id);

  await appendEventLog({
    traceId: String(o?.traceId || ""),
    log_kind: "portal",
    event: "PROGRAM_LINE_COMPLETED",
    payload: {
      program_line_id: id,
      program_run_id: line.program_run_id,
      completed_by: completedBy,
    },
  });

  const run = await getProgramRunById(line.program_run_id);
  return { ok: true, run };
}

/**
 * @param {string} lineId
 * @param {object} [o]
 * @param {string} [o.traceId]
 */
async function reopenProgramLine(lineId, o) {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db" };

  const id = String(lineId || "").trim();
  if (!id) return { ok: false, error: "missing_line_id" };

  const { data: line, error: lineErr } = await sb
    .from("program_lines")
    .select("id, program_run_id")
    .eq("id", id)
    .maybeSingle();

  if (lineErr || !line) return { ok: false, error: "not_found" };

  const { error: upErr } = await sb
    .from("program_lines")
    .update({
      status: "OPEN",
      completed_by: "",
      completed_at: null,
      notes: "",
    })
    .eq("id", id);

  if (upErr) return { ok: false, error: upErr.message || "update_failed" };

  await recalcProgramRunStatus(sb, line.program_run_id);

  await appendEventLog({
    traceId: String(o?.traceId || ""),
    log_kind: "portal",
    event: "PROGRAM_LINE_REOPENED",
    payload: {
      program_line_id: id,
      program_run_id: line.program_run_id,
    },
  });

  const run = await getProgramRunById(line.program_run_id);
  return { ok: true, run };
}

module.exports = {
  createProgramRun,
  previewProgramRunExpansion,
  deleteProgramRun,
  listProgramRuns,
  getProgramRunById,
  completeProgramLine,
  reopenProgramLine,
  getTemplate,
};
