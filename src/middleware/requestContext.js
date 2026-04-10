/**
 * Request-scoped trace id — propagate X-Trace-Id or generate; echo on response.
 */
const { randomUUID } = require("crypto");
const { emit } = require("../logging/structuredLog");

function requestContext(req, res, next) {
  const traceId =
    (req.get("x-trace-id") && String(req.get("x-trace-id")).trim()) ||
    (req.get("x-request-id") && String(req.get("x-request-id")).trim()) ||
    randomUUID();

  req.traceId = traceId;
  res.setHeader("X-Trace-Id", traceId);

  emit({
    level: "info",
    trace_id: traceId,
    log_kind: "http_request",
    event: `${req.method} ${req.originalUrl || req.url}`,
    data: {
      method: req.method,
      path: req.originalUrl || req.url,
    },
  });

  next();
}

module.exports = { requestContext };
