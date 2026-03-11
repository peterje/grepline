import { Effect } from "effect"

import { StartupError, startupError, type ServiceError } from "./domain/errors"
import type { ServiceShell } from "./domain/models"
import { logError, logInfo, loggingLayer } from "./observability/logging"
import { bootstrapServiceShell } from "./service/shell"

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
    const serviceShell = yield* bootstrapServiceShell(
      cli.workflow_path === undefined
        ? { cwd }
        : { cwd, workflow_path: cli.workflow_path },
    )

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
