import {
  Effect,
  FileSystem,
  Layer,
  Logger,
  Path,
  Stdio,
  Terminal,
} from "effect"
import { TestConsole } from "effect/testing"
import { CliOutput } from "effect/unstable/cli"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"

import { runCli, type RunCliOptions } from "../src/cli"

const silentLogger = Logger.layer([Logger.make(() => undefined)])

const testTerminal = Terminal.make({
  columns: Effect.succeed(80),
  display: () => Effect.void,
  readInput: Effect.die("terminal input is not implemented in tests"),
  readLine: Effect.die("terminal input is not implemented in tests"),
})

const testCliLayer = Layer.mergeAll(
  TestConsole.layer,
  FileSystem.layerNoop({}),
  Path.layer,
  CliOutput.layer(CliOutput.defaultFormatter({ colors: false })),
  Layer.succeed(Terminal.Terminal, testTerminal),
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() =>
      Effect.die("child process spawning is not implemented in tests"),
    ),
  ),
  Stdio.layerTest({}),
)

export const runCliForTest = (
  argv: ReadonlyArray<string>,
  options: RunCliOptions = {},
) =>
  runCli(argv, options).pipe(
    Effect.provide(silentLogger),
    Effect.provide(testCliLayer),
  )
