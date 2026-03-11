import { Schema } from "effect"

export const Timestamp = Schema.String
export type Timestamp = Schema.Schema.Type<typeof Timestamp>

export const JsonMap = Schema.Record(Schema.String, Schema.Unknown)
export type JsonMap = Schema.Schema.Type<typeof JsonMap>

export const BlockerRef = Schema.Struct({
  id: Schema.NullOr(Schema.String),
  identifier: Schema.NullOr(Schema.String),
  state: Schema.NullOr(Schema.String),
})
export type BlockerRef = Schema.Schema.Type<typeof BlockerRef>

export const Issue = Schema.Struct({
  id: Schema.String,
  identifier: Schema.String,
  title: Schema.String,
  description: Schema.NullOr(Schema.String),
  priority: Schema.NullOr(Schema.Number),
  state: Schema.String,
  branch_name: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
  labels: Schema.Array(Schema.String),
  blocked_by: Schema.Array(BlockerRef),
  created_at: Schema.NullOr(Timestamp),
  updated_at: Schema.NullOr(Timestamp),
})
export type Issue = Schema.Schema.Type<typeof Issue>

export const WorkflowDefinition = Schema.Struct({
  config: JsonMap,
  prompt_template: Schema.String,
})
export type WorkflowDefinition = Schema.Schema.Type<typeof WorkflowDefinition>

export const StateConcurrencyLimits = Schema.Record(
  Schema.String,
  Schema.Number,
)
export type StateConcurrencyLimits = Schema.Schema.Type<
  typeof StateConcurrencyLimits
>

export const TrackerConfig = Schema.Struct({
  kind: Schema.NullOr(Schema.String),
  endpoint: Schema.String,
  api_key: Schema.NullOr(Schema.String),
  project_slug: Schema.NullOr(Schema.String),
  active_states: Schema.Array(Schema.String),
  terminal_states: Schema.Array(Schema.String),
})
export type TrackerConfig = Schema.Schema.Type<typeof TrackerConfig>

export const PollingConfig = Schema.Struct({
  interval_ms: Schema.Number,
})
export type PollingConfig = Schema.Schema.Type<typeof PollingConfig>

export const WorkspaceConfig = Schema.Struct({
  root: Schema.String,
})
export type WorkspaceConfig = Schema.Schema.Type<typeof WorkspaceConfig>

export const HooksConfig = Schema.Struct({
  after_create: Schema.NullOr(Schema.String),
  before_run: Schema.NullOr(Schema.String),
  after_run: Schema.NullOr(Schema.String),
  before_remove: Schema.NullOr(Schema.String),
  timeout_ms: Schema.Number,
})
export type HooksConfig = Schema.Schema.Type<typeof HooksConfig>

export const AgentConfig = Schema.Struct({
  max_concurrent_agents: Schema.Number,
  max_turns: Schema.Number,
  max_retry_backoff_ms: Schema.Number,
  max_concurrent_agents_by_state: StateConcurrencyLimits,
})
export type AgentConfig = Schema.Schema.Type<typeof AgentConfig>

export const CodexConfig = Schema.Struct({
  command: Schema.String,
  approval_policy: Schema.NullOr(Schema.Unknown),
  thread_sandbox: Schema.NullOr(Schema.String),
  turn_sandbox_policy: Schema.NullOr(JsonMap),
  turn_timeout_ms: Schema.Number,
  read_timeout_ms: Schema.Number,
  stall_timeout_ms: Schema.Number,
})
export type CodexConfig = Schema.Schema.Type<typeof CodexConfig>

export const WorkflowConfig = Schema.Struct({
  tracker: TrackerConfig,
  polling: PollingConfig,
  workspace: WorkspaceConfig,
  hooks: HooksConfig,
  agent: AgentConfig,
  codex: CodexConfig,
})
export type WorkflowConfig = Schema.Schema.Type<typeof WorkflowConfig>

export const Workspace = Schema.Struct({
  path: Schema.String,
  workspace_key: Schema.String,
  created_now: Schema.Boolean,
})
export type Workspace = Schema.Schema.Type<typeof Workspace>

export const FailureDetails = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  details: Schema.NullOr(JsonMap),
})
export type FailureDetails = Schema.Schema.Type<typeof FailureDetails>

export const RunAttemptStatus = Schema.Literals([
  "preparing_workspace",
  "building_prompt",
  "launching_agent_process",
  "initializing_session",
  "streaming_turn",
  "finishing",
  "succeeded",
  "failed",
  "timed_out",
  "stalled",
  "canceled_by_reconciliation",
])
export type RunAttemptStatus = Schema.Schema.Type<typeof RunAttemptStatus>

export const RunAttempt = Schema.Struct({
  issue_id: Schema.String,
  issue_identifier: Schema.String,
  attempt: Schema.NullOr(Schema.Number),
  workspace_path: Schema.String,
  started_at: Timestamp,
  status: RunAttemptStatus,
  error: Schema.NullOr(FailureDetails),
})
export type RunAttempt = Schema.Schema.Type<typeof RunAttempt>

export const LiveSession = Schema.Struct({
  session_id: Schema.String,
  thread_id: Schema.String,
  turn_id: Schema.String,
  codex_app_server_pid: Schema.NullOr(Schema.String),
  last_codex_event: Schema.NullOr(Schema.String),
  last_codex_timestamp: Schema.NullOr(Timestamp),
  last_codex_message: Schema.NullOr(Schema.String),
  codex_input_tokens: Schema.Number,
  codex_output_tokens: Schema.Number,
  codex_total_tokens: Schema.Number,
  last_reported_input_tokens: Schema.Number,
  last_reported_output_tokens: Schema.Number,
  last_reported_total_tokens: Schema.Number,
  turn_count: Schema.Number,
})
export type LiveSession = Schema.Schema.Type<typeof LiveSession>

export const RetryEntry = Schema.Struct({
  issue_id: Schema.String,
  identifier: Schema.String,
  attempt: Schema.Number,
  due_at_ms: Schema.Number,
  timer_handle: Schema.NullOr(Schema.Unknown),
  error: Schema.NullOr(Schema.String),
})
export type RetryEntry = Schema.Schema.Type<typeof RetryEntry>

export const CodexTotals = Schema.Struct({
  input_tokens: Schema.Number,
  output_tokens: Schema.Number,
  total_tokens: Schema.Number,
  seconds_running: Schema.Number,
})
export type CodexTotals = Schema.Schema.Type<typeof CodexTotals>

export const RunningEntry = Schema.Struct({
  issue: Issue,
  run_attempt: RunAttempt,
  live_session: Schema.NullOr(LiveSession),
})
export type RunningEntry = Schema.Schema.Type<typeof RunningEntry>

export const OrchestratorState = Schema.Struct({
  poll_interval_ms: Schema.Number,
  max_concurrent_agents: Schema.Number,
  running: Schema.Record(Schema.String, RunningEntry),
  claimed: Schema.Array(Schema.String),
  retry_attempts: Schema.Record(Schema.String, RetryEntry),
  completed: Schema.Array(Schema.String),
  codex_totals: CodexTotals,
  codex_rate_limits: Schema.NullOr(JsonMap),
})
export type OrchestratorState = Schema.Schema.Type<typeof OrchestratorState>

export const ServiceShell = Schema.Struct({
  cwd: Schema.String,
  workflow_path: Schema.String,
  started_at: Timestamp,
  orchestrator_state: OrchestratorState,
})
export type ServiceShell = Schema.Schema.Type<typeof ServiceShell>

export const DEFAULT_WORKFLOW_FILE = "WORKFLOW.md"
export const DEFAULT_POLL_INTERVAL_MS = 30_000
export const DEFAULT_MAX_CONCURRENT_AGENTS = 10
export const DEFAULT_LINEAR_ENDPOINT = "https://api.linear.app/graphql"
export const DEFAULT_LINEAR_PAGE_SIZE = 50
export const DEFAULT_LINEAR_TIMEOUT_MS = 30_000
export const DEFAULT_ACTIVE_STATES = ["Todo", "In Progress"]
export const DEFAULT_TERMINAL_STATES = [
  "Closed",
  "Cancelled",
  "Canceled",
  "Duplicate",
  "Done",
]
export const DEFAULT_WORKSPACE_DIRECTORY = "symphony_workspaces"
export const DEFAULT_HOOK_TIMEOUT_MS = 60_000
export const DEFAULT_MAX_TURNS = 20
export const DEFAULT_MAX_RETRY_BACKOFF_MS = 300_000
export const DEFAULT_CODEX_COMMAND = "codex app-server"
export const DEFAULT_CODEX_TURN_TIMEOUT_MS = 3_600_000
export const DEFAULT_CODEX_READ_TIMEOUT_MS = 5_000
export const DEFAULT_CODEX_STALL_TIMEOUT_MS = 300_000
export const DEFAULT_WORKFLOW_PROMPT =
  "You are working on an issue from Linear."

export const sanitizeWorkspaceKey = (issueIdentifier: string): string =>
  issueIdentifier.replaceAll(/[^A-Za-z0-9._-]/g, "_")

export const makeInitialCodexTotals = (): CodexTotals => ({
  input_tokens: 0,
  output_tokens: 0,
  total_tokens: 0,
  seconds_running: 0,
})

export const makeInitialOrchestratorState = (
  overrides: Partial<
    Pick<OrchestratorState, "poll_interval_ms" | "max_concurrent_agents">
  > = {},
): OrchestratorState => ({
  poll_interval_ms: overrides.poll_interval_ms ?? DEFAULT_POLL_INTERVAL_MS,
  max_concurrent_agents:
    overrides.max_concurrent_agents ?? DEFAULT_MAX_CONCURRENT_AGENTS,
  running: {},
  claimed: [],
  retry_attempts: {},
  completed: [],
  codex_totals: makeInitialCodexTotals(),
  codex_rate_limits: null,
})
