import path from "node:path"

import { describe, expect, it } from "@effect/vitest"
import { Effect, Logger } from "effect"

import { parseCliOptions, runCli } from "../src/cli"
import { DEFAULT_WORKFLOW_FILE } from "../src/domain/models"
import {
  bootstrapServiceShell,
  resolveWorkflowPath,
} from "../src/service/shell"

const silentLogger = Logger.layer([Logger.make(() => undefined)])

describe("service shell", () => {
  it.effect("defaults the workflow path to WORKFLOW.md in cwd", () =>
    Effect.gen(function* () {
      const cwd = "/tmp/grepline"
      const shell = yield* bootstrapServiceShell({
        cwd,
        started_at: "2026-03-10T00:00:00.000Z",
      }).pipe(Effect.provide(silentLogger))

      expect(shell.workflow_path).toEqual(
        path.resolve(cwd, DEFAULT_WORKFLOW_FILE),
      )
      expect(shell.orchestrator_state.poll_interval_ms).toEqual(30_000)
      expect(shell.orchestrator_state.max_concurrent_agents).toEqual(10)
    }),
  )

  it.effect("resolves a custom workflow path through the cli", () =>
    Effect.gen(function* () {
      const cwd = "/repo/project"
      const shell = yield* runCli(["./config/TEAM_WORKFLOW.md"], { cwd }).pipe(
        Effect.provide(silentLogger),
      )

      expect(shell.workflow_path).toEqual(
        path.resolve(cwd, "./config/TEAM_WORKFLOW.md"),
      )
    }),
  )

  it.effect("rejects extra cli arguments", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(parseCliOptions(["one.md", "two.md"]))

      expect(error.code).toEqual("invalid_cli_arguments")
    }),
  )

  it.effect("resolves relative and default workflow paths", () =>
    Effect.sync(() => {
      expect(resolveWorkflowPath("/workspace")).toEqual(
        "/workspace/WORKFLOW.md",
      )
      expect(
        resolveWorkflowPath("/workspace", "docs/WORKFLOW.local.md"),
      ).toEqual("/workspace/docs/WORKFLOW.local.md")
    }),
  )
})
