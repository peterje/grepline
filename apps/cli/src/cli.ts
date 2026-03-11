import { Effect } from "effect"

import { StartupError, startupError, type ServiceError } from "./domain/errors"
import {
  makeInitialOrchestratorState,
  type ServiceShell,
} from "./domain/models"
import { logError, logInfo, loggingLayer } from "./observability/logging"
import { bootstrapServiceShell } from "./service/shell"
import {
  loadWorkflowDefinition,
  resolveWorkflowConfig,
  validateWorkflowStartupConfig,
} from "./service/workflow"

export type CliOptions = {
  readonly workflow_path?: string
}

export type RunCliOptions = {
  readonly cwd?: string
}

export const parseCliOptions = (
  argv: ReadonlyArray<string>,
): Effect.Effect<CliOptions, StartupError> => {
  const flags = argv.filter((arg) => arg.startsWith("-"))
  const positionals = argv.filter((arg) => !arg.startsWith("-"))

  if (flags.length > 0 || positionals.length > 1) {
    return Effect.fail(
      startupError(
        "invalid_cli_arguments",
        "expected at most one optional workflow path argument",
        { argv },
      ),
    )
  }

  return Effect.succeed(
    positionals[0] === undefined ? {} : { workflow_path: positionals[0] },
  )
}

export const runCli = (
  argv: ReadonlyArray<string>,
  options: RunCliOptions = {},
): Effect.Effect<ServiceShell, ServiceError> =>
  Effect.gen(function* () {
    const cli = yield* parseCliOptions(argv)
    const cwd = options.cwd ?? process.cwd()
    const loadedWorkflow = yield* loadWorkflowDefinition(
      cli.workflow_path === undefined
        ? { cwd }
        : { cwd, workflow_path: cli.workflow_path },
    )
    const workflowConfig = resolveWorkflowConfig(
      loadedWorkflow.workflow.config,
      {
        cwd,
      },
    )

    yield* validateWorkflowStartupConfig(workflowConfig)

    const serviceShell = yield* bootstrapServiceShell({
      cwd,
      workflow_path: loadedWorkflow.workflow_path,
      orchestrator_state: makeInitialOrchestratorState({
        poll_interval_ms: workflowConfig.polling.interval_ms,
        max_concurrent_agents: workflowConfig.agent.max_concurrent_agents,
      }),
    })

    yield* logInfo("service shell ready", {
      cwd: serviceShell.cwd,
      workflow_path: serviceShell.workflow_path,
    })

    return serviceShell
  }).pipe(
    Effect.tapError((error) =>
      logError("service shell failed", {
        error_tag: error._tag,
        error_code: error.code,
        error_message: error.message,
        ...error.details,
      }),
    ),
  )

export const makeProgram = (
  argv: ReadonlyArray<string> = Bun.argv.slice(2),
  options: RunCliOptions = {},
): Effect.Effect<void, ServiceError> =>
  runCli(argv, options).pipe(Effect.asVoid, Effect.provide(loggingLayer))
