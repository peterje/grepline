import { Effect } from "effect"
import { Argument, Command } from "effect/unstable/cli"

import { startupError, type ServiceError } from "./domain/errors"
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

export const CLI_VERSION = "0.0.0"

const workflowPathArgument = Argument.string("workflow-path").pipe(
  Argument.withDescription("Path to the workflow file"),
  Argument.variadic(),
)

const initializeServiceShell = (
  cli: CliOptions,
  options: RunCliOptions = {},
): Effect.Effect<ServiceShell, ServiceError> =>
  Effect.gen(function* () {
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

export const makeCliCommand = (
  options: RunCliOptions = {},
  onServiceShell?: (serviceShell: ServiceShell) => Effect.Effect<void>,
) =>
  Command.make("grepline", {
    workflow_path: workflowPathArgument,
  }).pipe(
    Command.withDescription("Start the grepline service shell"),
    Command.withHandler(({ workflow_path: workflowPaths }) =>
      Effect.gen(function* () {
        if (workflowPaths.length > 1) {
          return yield* startupError(
            "invalid_cli_arguments",
            "expected at most one optional workflow path argument",
            { argv: workflowPaths },
          )
        }

        return yield* initializeServiceShell(
          workflowPaths[0] === undefined
            ? {}
            : { workflow_path: workflowPaths[0] },
          options,
        )
      }).pipe(
        Effect.tap((serviceShell) =>
          onServiceShell === undefined
            ? Effect.void
            : onServiceShell(serviceShell),
        ),
      ),
    ),
  )

export const runCli = (
  argv: ReadonlyArray<string>,
  options: RunCliOptions = {},
) =>
  Effect.gen(function* () {
    let serviceShell: ServiceShell | undefined

    yield* Command.runWith(
      makeCliCommand(options, (nextServiceShell) =>
        Effect.sync(() => {
          serviceShell = nextServiceShell
        }),
      ),
      {
        version: CLI_VERSION,
      },
    )(argv)

    if (serviceShell === undefined) {
      return yield* Effect.die(
        "cli completed without producing a service shell",
      )
    }

    return serviceShell
  })

export const makeProgram = (options: RunCliOptions = {}) =>
  Command.run(makeCliCommand(options), {
    version: CLI_VERSION,
  }).pipe(Effect.provide(loggingLayer))
