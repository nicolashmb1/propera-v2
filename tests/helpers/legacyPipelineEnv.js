/**
 * Legacy maintenance scenario defaults — tenant agent OFF.
 * Require first in pipeline scenario tests so `.env` TENANT_AGENT_ENABLED=1 does not leak.
 * @see docs/TENANT_AGENT_ADAPTER.md §11 CI rule
 */
process.env.TENANT_AGENT_ENABLED = "0";
process.env.TENANT_AGENT_LLM_ENABLED = "0";
