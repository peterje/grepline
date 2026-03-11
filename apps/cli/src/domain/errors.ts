import { Data } from "effect"

export type ErrorDetails = Readonly<Record<string, unknown>>

export type StartupErrorCode =
  | "invalid_cli_arguments"
  | "missing_workflow_file"
  | "workflow_parse_error"
  | "workflow_front_matter_not_a_map"
  | "startup_validation_failed"

export type RuntimeErrorCode =
  | "template_parse_error"
  | "template_render_error"
  | "runtime_invariant_violation"
  | "workspace_operation_failed"
  | "codex_not_found"
  | "invalid_workspace_cwd"
  | "response_timeout"
  | "turn_timeout"
  | "port_exit"
  | "response_error"
  | "turn_failed"
  | "turn_cancelled"
  | "turn_input_required"
  | "tracker_request_failed"
  | "agent_process_failed"
  | "unexpected_runtime_error"

export type TrackerAdapterErrorCode =
  | "unsupported_tracker_kind"
  | "missing_tracker_api_key"
  | "missing_tracker_project_slug"
  | "linear_api_request"
  | "linear_api_status"
  | "linear_graphql_errors"
  | "linear_unknown_payload"
  | "linear_missing_end_cursor"

type ServiceErrorShape<Code extends string> = {
  readonly code: Code
  readonly message: string
  readonly details: ErrorDetails | undefined
}

export class StartupError extends Data.TaggedError("StartupError")<
  ServiceErrorShape<StartupErrorCode>
> {}

export class RuntimeError extends Data.TaggedError("RuntimeError")<
  ServiceErrorShape<RuntimeErrorCode>
> {}

export class TrackerAdapterError extends Data.TaggedError(
  "TrackerAdapterError",
)<ServiceErrorShape<TrackerAdapterErrorCode>> {}

export type ServiceError = StartupError | RuntimeError

export const startupError = (
  code: StartupErrorCode,
  message: string,
  details?: ErrorDetails,
): StartupError => new StartupError({ code, message, details })

export const runtimeError = (
  code: RuntimeErrorCode,
  message: string,
  details?: ErrorDetails,
): RuntimeError => new RuntimeError({ code, message, details })

export const trackerAdapterError = (
  code: TrackerAdapterErrorCode,
  message: string,
  details?: ErrorDetails,
): TrackerAdapterError => new TrackerAdapterError({ code, message, details })
