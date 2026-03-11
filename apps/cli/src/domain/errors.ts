import { Data } from "effect"

export type ErrorDetails = Readonly<Record<string, unknown>>

export type StartupErrorCode =
  | "invalid_cli_arguments"
  | "missing_workflow_file"
  | "workflow_parse_error"
  | "workflow_front_matter_not_a_map"
  | "startup_validation_failed"

export type RuntimeErrorCode =
  | "runtime_invariant_violation"
  | "workspace_operation_failed"
  | "tracker_request_failed"
  | "agent_process_failed"
  | "unexpected_runtime_error"

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
