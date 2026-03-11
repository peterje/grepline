import path from "node:path"
import os from "node:os"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"

import { describe, expect, it } from "bun:test"
import { Effect, Logger } from "effect"

import { DEFAULT_WORKFLOW_FILE } from "../src/domain/models"
import {
  bootstrapServiceShell,
  resolveWorkflowPath,
} from "../src/service/shell"
import { runCliForTest } from "./cli-harness"

const silentLogger = Logger.layer([Logger.make(() => undefined)])

describe("service shell", () => {
  it("defaults the workflow path to WORKFLOW.md in cwd", async () => {
    const cwd = "/tmp/grepline"
    const shell = await Effect.runPromise(
      bootstrapServiceShell({
        cwd,
        started_at: "2026-03-10T00:00:00.000Z",
      }).pipe(Effect.provide(silentLogger)),
    )

    expect(shell.workflow_path).toEqual(
      path.resolve(cwd, DEFAULT_WORKFLOW_FILE),
    )
    expect(shell.orchestrator_state.poll_interval_ms).toEqual(30_000)
    expect(shell.orchestrator_state.max_concurrent_agents).toEqual(10)
  })

  it("resolves a custom workflow path through the cli", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "grepline-cli-"))

    try {
      const workflowPath = path.join(cwd, "config", "TEAM_WORKFLOW.md")

      await mkdir(path.dirname(workflowPath), { recursive: true })
      await writeFile(
        workflowPath,
        [
          "---",
          "tracker:",
          "  kind: linear",
          "  api_key: test-token",
          "  project_slug: demo",
          "polling:",
          "  interval_ms: 5000",
          "agent:",
          "  max_concurrent_agents: 3",
          "---",
          "hello {{ issue.identifier }}",
        ].join("\n"),
        { encoding: "utf8" },
      )

      const shell = await Effect.runPromise(
        runCliForTest(["./config/TEAM_WORKFLOW.md"], {
          cwd,
        }),
      )

      expect(shell.workflow_path).toEqual(
        path.resolve(cwd, "./config/TEAM_WORKFLOW.md"),
      )
      expect(shell.orchestrator_state.poll_interval_ms).toEqual(5000)
      expect(shell.orchestrator_state.max_concurrent_agents).toEqual(3)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it("rejects extra cli arguments", async () => {
    const error = await Effect.runPromise(
      Effect.flip(runCliForTest(["one.md", "two.md"])),
    )

    expect(error).toMatchObject({
      code: "invalid_cli_arguments",
    })
  })

  it("resolves relative and default workflow paths", () => {
    expect(resolveWorkflowPath("/workspace")).toEqual("/workspace/WORKFLOW.md")
    expect(resolveWorkflowPath("/workspace", "docs/WORKFLOW.local.md")).toEqual(
      "/workspace/docs/WORKFLOW.local.md",
    )
  })
})
