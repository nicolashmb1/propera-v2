/**
 * PM/Task V1 — program_runs + program_lines DAL (portal / future staff NL).
 * @see docs/PM_PROGRAM_ENGINE_V1.md
 */
const { getSupabase } = require("../db/supabase");
const { appendEventLog } = require("./appendEventLog");
const { resolvePropertyCodeFromLabel } = require("./portalTenants");
const { expandProgramLines } = require("../pm/expandProgramLines");
const {
  getSavedProgram,
  parseIncludedLabelsJson,
  EXPANSION_TYPES,
} = require("./savedPrograms");

/** Max images per line (portal preventive proof-of-work). */
const MAX_PROOF_PHOTOS_PER_LINE = 12;

/**
 * @param {unknown} raw
 * @returns {string[]}
 */
function normalizeProofPhotoUrls(raw) {
  if (!raw || !Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const x of raw) {
    const u = String(x || "").trim();
    if (u.length < 8 || u.length > 2048) continue;
    const lower = u.toLowerCase();
    if (!lower.startsWith("https://") && !lower.startsWith("http://")) continue;
    if (seen.has(u)) continue;
    seen.add(u);
    out.push(u);
    if (out.length >= MAX_PROOF_PHOTOS_PER_LINE) break;
  }
  return out;
}

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

/**
 * Shape expected by expandProgramLines (mirrors program_templates row).
 * @param {object} p
 * @param {string} p.expansionType
 * @param {string[]} [p.defaultScopeLabels]
 * @param {string} [p.label]
 */
function templateShapeForExpand(p) {
  const expansionType = String(p.expansionType || "").trim();
  const labels = Array.isArray(p.defaultScopeLabels)
    ? p.defaultScopeLabels.map((x) => String(x || "").trim()).filter(Boolean)
    : [];
  return {
    template_key: String(p.templateKeyStub || "_SYNTH_"),
    label: String(p.label || "Program").trim() || "Program",
    expansion_type: expansionType,
    default_scope_labels: labels.length ? labels : null,
  };
}

/**
 * @param {unknown} raw
 * @returns {string[]}
 */
function normalizeIncludedArray(raw) {
  if (!raw) return [];
  if (!Array.isArray(raw)) return [];
  return raw.map((x) => String(x || "").trim()).filter(Boolean);
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
 * Expand + apply includedScopeLabels (request) > defaultIncluded (definition) > all lines.
 * @param {string} propertyCode
 * @param {object} templateShape — row-like object for expandProgramLines
 * @param {string[]|undefined} includedScopeLabels — from request
 * @param {string[]} defaultIncludedLabels — from saved program or template defaults
 */
async function buildProgramLineSpecs(propertyCode, templateShape, includedScopeLabels, defaultIncludedLabels) {
  const code = String(propertyCode || "").trim().toUpperCase();
  const sb = getSupabase();
  if (!sb || !code) return { ok: false, error: "unknown_property" };

  const { data: propRow } = await sb
    .from("properties")
    .select("code, program_expansion_profile")
    .eq("code", code)
    .maybeSingle();
  if (!propRow) return { ok: false, error: "unknown_property" };

  const unitRows =
    String(templateShape.expansion_type) === "UNIT_PLUS_COMMON"
      ? await loadActiveUnitRows(code)
      : [];

  let lineSpecs = expandProgramLines(templateShape, unitRows, {
    expansionProfile: propRow.program_expansion_profile,
  });

  const req = normalizeIncludedArray(includedScopeLabels);
  const def = normalizeIncludedArray(defaultIncludedLabels);

  if (req.length) {
    const allow = new Set(req);
    lineSpecs = lineSpecs.filter((spec) => allow.has(String(spec.scope_label || "").trim()));
    if (!lineSpecs.length) {
      return { ok: false, error: "no_matching_scopes" };
    }
    lineSpecs = lineSpecs.map((spec, i) => ({ ...spec, sort_order: i }));
    return { ok: true, lineSpecs };
  }

  if (def.length) {
    const allow = new Set(def);
    lineSpecs = lineSpecs.filter((spec) => allow.has(String(spec.scope_label || "").trim()));
    if (!lineSpecs.length) {
      return { ok: false, error: "no_matching_scopes" };
    }
    lineSpecs = lineSpecs.map((spec, i) => ({ ...spec, sort_order: i }));
    return { ok: true, lineSpecs };
  }

  return { ok: true, lineSpecs };
}

/**
 * @param {object} o
 * @param {string} o.propertyCode
 * @param {string} [o.templateKey]
 * @param {string} [o.savedProgramId]
 * @returns {Promise<{ ok: boolean, sourceType?: string, sourceId?: string, displayName?: string, expansionType?: string, defaultIncludedScopeLabels?: string[], templateShape?: object, error?: string }>}
 */
async function resolveProgramDefinitionForRun(o) {
  const propertyCode = String(o.propertyCode || "").trim().toUpperCase();
  if (!propertyCode) return { ok: false, error: "missing_property_code" };

  const templateKey = String(o.templateKey || "")
    .trim()
    .toUpperCase();
  const savedProgramId = String(o.savedProgramId || "").trim();

  const hasT = Boolean(templateKey);
  const hasS = Boolean(savedProgramId);
  if (hasT === hasS) {
    return { ok: false, error: hasT ? "ambiguous_run_source" : "missing_run_source" };
  }

  if (hasT) {
    const template = await getTemplate(templateKey);
    if (!template) return { ok: false, error: "unknown_template" };
    const defaultIncludedScopeLabels = parseIncludedLabelsJson(template.default_scope_labels);
    const templateShape = templateShapeForExpand({
      expansionType: template.expansion_type,
      defaultScopeLabels: defaultIncludedScopeLabels,
      label: template.label,
      templateKeyStub: template.template_key,
    });
    return {
      ok: true,
      sourceType: "legacy_template",
      sourceId: templateKey,
      displayName: String(template.label || "").trim() || templateKey,
      expansionType: String(template.expansion_type || ""),
      defaultIncludedScopeLabels,
      templateShape,
    };
  }

  const sp = await getSavedProgram(savedProgramId);
  if (!sp) return { ok: false, error: "unknown_saved_program" };
  if (String(sp.property_code || "").trim().toUpperCase() !== propertyCode) {
    return { ok: false, error: "saved_program_property_mismatch" };
  }
  if (sp.active === false) {
    return { ok: false, error: "saved_program_archived" };
  }

  const defaultIncludedScopeLabels = parseIncludedLabelsJson(sp.default_included_scope_labels);
  const templateShape = templateShapeForExpand({
    expansionType: sp.expansion_type,
    defaultScopeLabels: defaultIncludedScopeLabels,
    label: sp.display_name,
    templateKeyStub: "_SAVED_",
  });

  return {
    ok: true,
    sourceType: "saved_program",
    sourceId: savedProgramId,
    displayName: String(sp.display_name || "").trim() || "Program",
    expansionType: String(sp.expansion_type || ""),
    defaultIncludedScopeLabels,
    templateShape,
  };
}

/**
 * @param {object} o
 * @param {string} [o.property]
 * @param {string} [o.propertyCode]
 * @param {string} [o.templateKey]
 * @param {string} [o.savedProgramId]
 * @param {string} [o.createdBy]
 * @param {string} [o.traceId]
 * @param {string[]} [o.includedScopeLabels]
 */
async function createProgramRun(o) {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db" };

  let propertyCode = String(o.propertyCode || "").trim().toUpperCase();
  if (!propertyCode) {
    propertyCode = await resolvePropertyCodeFromLabel(
      sb,
      String(o.property || "").trim()
    );
  }
  if (!propertyCode) return { ok: false, error: "unknown_property" };

  const resolved = await resolveProgramDefinitionForRun({
    propertyCode,
    templateKey: o.templateKey,
    savedProgramId: o.savedProgramId,
  });
  if (!resolved.ok) {
    return { ok: false, error: resolved.error || "resolve_failed" };
  }

  const built = await buildProgramLineSpecs(
    propertyCode,
    resolved.templateShape,
    o.includedScopeLabels,
    resolved.defaultIncludedScopeLabels
  );
  if (!built.ok) {
    return { ok: false, error: built.error || "expand_failed" };
  }
  const lineSpecs = built.lineSpecs;

  const propDisplay = await getPropertyDisplayName(propertyCode);
  const title = `${propDisplay} — ${resolved.displayName}`;

  const createdBy = String(o.createdBy || "PORTAL").slice(0, 200);
  const traceId = String(o.traceId || "");

  const runInsert =
    resolved.sourceType === "legacy_template"
      ? {
          property_code: propertyCode,
          template_key: resolved.sourceId,
          saved_program_id: null,
          title,
          status: "OPEN",
          created_by: createdBy,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }
      : {
          property_code: propertyCode,
          template_key: null,
          saved_program_id: resolved.sourceId,
          title,
          status: "OPEN",
          created_by: createdBy,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };

  const { data: run, error: runErr } = await sb
    .from("program_runs")
    .insert(runInsert)
    .select(
      "id, property_code, template_key, saved_program_id, title, status, created_by, created_at, updated_at"
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
        "id, program_run_id, scope_type, scope_label, sort_order, status, completed_by, completed_at, notes, proof_photo_urls"
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
      template_key: run.template_key || null,
      saved_program_id: run.saved_program_id || null,
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
 * @param {string} runId
 * @param {object} [o]
 * @param {string} [o.traceId]
 */
async function deleteProgramRun(runId, o) {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db" };

  const id = String(runId || "").trim();
  if (!id) return { ok: false, error: "missing_run_id" };

  const { data: existing, error: fetchErr } = await sb
    .from("program_runs")
    .select("id, property_code, template_key, saved_program_id, title")
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
      saved_program_id: String(existing.saved_program_id || ""),
      title: String(existing.title || ""),
    },
  });

  return { ok: true };
}

/**
 * Preview expansion (no DB writes for lines). Supports legacy templateKey, savedProgramId, or ephemeral expansionType.
 * @param {object} o
 * @param {string} [o.property]
 * @param {string} [o.propertyCode]
 * @param {string} [o.templateKey]
 * @param {string} [o.savedProgramId]
 * @param {string} [o.expansionType]
 * @param {string[]} [o.includedScopeLabels]
 */
async function previewProgramRunExpansion(o) {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db" };

  const templateKey = String(o.templateKey || "")
    .trim()
    .toUpperCase();
  const savedProgramId = String(o.savedProgramId || "").trim();
  const expansionType = String(o.expansionType || "")
    .trim()
    .toUpperCase();

  const n = (templateKey ? 1 : 0) + (savedProgramId ? 1 : 0) + (expansionType ? 1 : 0);
  if (n !== 1) {
    return { ok: false, error: n === 0 ? "missing_preview_source" : "ambiguous_preview_source" };
  }

  let propertyCode = String(o.propertyCode || "").trim().toUpperCase();
  if (!propertyCode) {
    propertyCode = await resolvePropertyCodeFromLabel(sb, String(o.property || "").trim());
  }
  if (!propertyCode) return { ok: false, error: "unknown_property" };

  let templateShape;
  let defaultIncludedScopeLabels = [];
  let outTemplateKey = templateKey || null;
  let outSavedId = savedProgramId || null;

  if (templateKey) {
    const template = await getTemplate(templateKey);
    if (!template) return { ok: false, error: "unknown_template" };
    defaultIncludedScopeLabels = parseIncludedLabelsJson(template.default_scope_labels);
    templateShape = templateShapeForExpand({
      expansionType: template.expansion_type,
      defaultScopeLabels: defaultIncludedScopeLabels,
      label: template.label,
      templateKeyStub: template.template_key,
    });
  } else if (savedProgramId) {
    const sp = await getSavedProgram(savedProgramId);
    if (!sp) return { ok: false, error: "unknown_saved_program" };
    if (String(sp.property_code || "").trim().toUpperCase() !== propertyCode) {
      return { ok: false, error: "saved_program_property_mismatch" };
    }
    defaultIncludedScopeLabels = parseIncludedLabelsJson(sp.default_included_scope_labels);
    templateShape = templateShapeForExpand({
      expansionType: sp.expansion_type,
      defaultScopeLabels: defaultIncludedScopeLabels,
      label: sp.display_name,
      templateKeyStub: "_SAVED_",
    });
  } else {
    if (!EXPANSION_TYPES.has(expansionType)) {
      return { ok: false, error: "invalid_expansion_type" };
    }
    outTemplateKey = null;
    outSavedId = null;
    templateShape = templateShapeForExpand({
      expansionType,
      defaultScopeLabels: [],
      label: "",
      templateKeyStub: "_EPHEMERAL_",
    });
    defaultIncludedScopeLabels = [];
  }

  const built = await buildProgramLineSpecs(
    propertyCode,
    templateShape,
    o.includedScopeLabels,
    defaultIncludedScopeLabels
  );
  if (!built.ok) {
    return { ok: false, error: built.error || "expand_failed" };
  }

  return {
    ok: true,
    lines: built.lineSpecs,
    expansion_type: String(templateShape.expansion_type || ""),
    template_key: outTemplateKey,
    saved_program_id: outSavedId,
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
      "id, property_code, template_key, saved_program_id, title, status, created_by, created_at, updated_at"
    )
    .order("created_at", { ascending: false });

  if (error || !runs) return [];

  const ids = runs.map((r) => r.id).filter(Boolean);
  if (!ids.length) return [];

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

  const { data: templates } = await sb.from("program_templates").select("template_key, label");

  const labelByKey = {};
  for (const t of templates || []) {
    labelByKey[String(t.template_key).toUpperCase()] = String(t.label || "").trim();
  }

  const savedIds = [...new Set(runs.map((r) => r.saved_program_id).filter(Boolean))];
  const labelBySavedId = {};
  if (savedIds.length) {
    const { data: sps } = await sb
      .from("saved_programs")
      .select("id, display_name")
      .in("id", savedIds);
    for (const sp of sps || []) {
      labelBySavedId[String(sp.id)] = String(sp.display_name || "").trim();
    }
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
    const sid = r.saved_program_id ? String(r.saved_program_id) : "";
    const tk = r.template_key ? String(r.template_key).toUpperCase() : "";
    const templateLabel = sid
      ? labelBySavedId[sid] || sid
      : labelByKey[tk] || r.template_key || "";
    return {
      ...r,
      property_display: displayNames[pc] || pc,
      template_label: templateLabel,
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
      "id, property_code, template_key, saved_program_id, title, status, created_by, created_at, updated_at"
    )
    .eq("id", id)
    .maybeSingle();

  if (error || !run) return null;

  const { data: lines } = await sb
    .from("program_lines")
    .select(
      "id, program_run_id, scope_type, scope_label, sort_order, status, completed_by, completed_at, notes, proof_photo_urls"
    )
    .eq("program_run_id", id)
    .order("sort_order", { ascending: true })
    .order("scope_label", { ascending: true });

  let template_label = "";
  let expansion_type = "";

  if (run.saved_program_id) {
    const sp = await getSavedProgram(String(run.saved_program_id));
    template_label = sp ? String(sp.display_name || "").trim() : "";
    expansion_type = sp ? String(sp.expansion_type || "").trim() : "";
  } else if (run.template_key) {
    const { data: tmpl } = await sb
      .from("program_templates")
      .select("label, expansion_type")
      .eq("template_key", run.template_key)
      .maybeSingle();
    template_label = tmpl?.label || run.template_key;
    expansion_type = tmpl?.expansion_type || "";
  }

  const total = (lines || []).length;
  const complete = (lines || []).filter((l) => String(l.status).toUpperCase() === "COMPLETE").length;

  const propDisplay = await getPropertyDisplayName(run.property_code);

  return {
    ...run,
    property_display: propDisplay,
    template_label,
    expansion_type,
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
 * @param {unknown} [o.proofPhotoUrls] — optional array of public http(s) image URLs
 * @param {string} [o.traceId]
 */
async function completeProgramLine(lineId, o) {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: "no_db" };

  const lid = String(lineId || "").trim();
  if (!lid) return { ok: false, error: "missing_line_id" };

  const { data: line, error: lineErr } = await sb
    .from("program_lines")
    .select("id, program_run_id, status")
    .eq("id", lid)
    .maybeSingle();

  if (lineErr || !line) return { ok: false, error: "not_found" };

  const completedBy = String(o?.completedBy || "PORTAL").slice(0, 200);
  const notes = String(o?.notes || "").slice(0, 2000);
  const proofPhotoUrls = normalizeProofPhotoUrls(o?.proofPhotoUrls);
  const now = new Date().toISOString();

  const { error: upErr } = await sb
    .from("program_lines")
    .update({
      status: "COMPLETE",
      completed_by: completedBy,
      completed_at: now,
      notes,
      proof_photo_urls: proofPhotoUrls,
    })
    .eq("id", lid);

  if (upErr) return { ok: false, error: upErr.message || "update_failed" };

  await recalcProgramRunStatus(sb, line.program_run_id);

  await appendEventLog({
    traceId: String(o?.traceId || ""),
    log_kind: "portal",
    event: "PROGRAM_LINE_COMPLETED",
    payload: {
      program_line_id: lid,
      program_run_id: line.program_run_id,
      completed_by: completedBy,
      proof_photo_count: proofPhotoUrls.length,
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

  const lid = String(lineId || "").trim();
  if (!lid) return { ok: false, error: "missing_line_id" };

  const { data: line, error: lineErr } = await sb
    .from("program_lines")
    .select("id, program_run_id")
    .eq("id", lid)
    .maybeSingle();

  if (lineErr || !line) return { ok: false, error: "not_found" };

  const { error: upErr } = await sb
    .from("program_lines")
    .update({
      status: "OPEN",
      completed_by: "",
      completed_at: null,
      notes: "",
      proof_photo_urls: [],
    })
    .eq("id", lid);

  if (upErr) return { ok: false, error: upErr.message || "update_failed" };

  await recalcProgramRunStatus(sb, line.program_run_id);

  await appendEventLog({
    traceId: String(o?.traceId || ""),
    log_kind: "portal",
    event: "PROGRAM_LINE_REOPENED",
    payload: {
      program_line_id: lid,
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
  resolveProgramDefinitionForRun,
};
