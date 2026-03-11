import os from "node:os"
import path from "node:path"
import { mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises"

import { describe, expect, it } from "bun:test"
import { Effect } from "effect"

import type { HooksConfig, Issue } from "../src/domain/models"
import {
  assertWorkspacePathWithinRoot,
  cleanupTerminalWorkspaces,
  ensureWorkspace,
  removeWorkspaceForIssue,
  runAfterRunHook,
  runBeforeRunHook,
} from "../src/service/workspace"

const sampleIssue: Pick<Issue, "id" | "identifier"> = {
  id: "issue-1",
  identifier: "ABC-123",
}

const makeHooksConfig = (
  overrides: Partial<HooksConfig> = {},
): HooksConfig => ({
  after_create: null,
  before_run: null,
  after_run: null,
  before_remove: null,
  timeout_ms: 250,
  ...overrides,
})

const pathExists = async (filePath: string): Promise<boolean> => {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

describe("workspace manager and hooks", () => {
  it("creates and reuses deterministic sanitized workspaces", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "grepline-workspace-"))

    try {
      const options = {
        cwd,
        workspace_root: "workspaces",
        hooks: makeHooksConfig(),
      }

      const firstWorkspace = await Effect.runPromise(
        ensureWorkspace("ABC 123/456", options),
      )
      const secondWorkspace = await Effect.runPromise(
        ensureWorkspace("ABC 123/456", options),
      )

      expect(firstWorkspace).toEqual({
        path: path.join(cwd, "workspaces", "ABC_123_456"),
        workspace_key: "ABC_123_456",
        created_now: true,
      })
      expect(secondWorkspace).toEqual({
        path: path.join(cwd, "workspaces", "ABC_123_456"),
        workspace_key: "ABC_123_456",
        created_now: false,
      })
      expect(await pathExists(firstWorkspace.path)).toEqual(true)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it("rejects workspace paths outside the configured root", async () => {
    const cwd = await mkdtemp(
      path.join(os.tmpdir(), "grepline-workspace-safety-"),
    )

    try {
      const workspaceRoot = path.join(cwd, "workspaces")
      const outsidePath = path.join(cwd, "elsewhere", "ABC-123")
      const error = await Effect.runPromise(
        Effect.flip(
          assertWorkspacePathWithinRoot(outsidePath, workspaceRoot, { cwd }),
        ),
      )

      expect(error.code).toEqual("runtime_invariant_violation")
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it("runs after_create only for newly created workspaces", async () => {
    const cwd = await mkdtemp(
      path.join(os.tmpdir(), "grepline-workspace-after-create-"),
    )

    try {
      const options = {
        cwd,
        workspace_root: "workspaces",
        hooks: makeHooksConfig({
          after_create: [
            "count=0",
            'if [ -f "after-create-count.txt" ]; then count=$(cat "after-create-count.txt"); fi',
            "count=$((count + 1))",
            'printf "%s" "$count" > "after-create-count.txt"',
          ].join("; "),
        }),
      }

      const workspace = await Effect.runPromise(
        ensureWorkspace(sampleIssue, options),
      )
      await Effect.runPromise(ensureWorkspace(sampleIssue, options))

      expect(
        await readFile(
          path.join(workspace.path, "after-create-count.txt"),
          "utf8",
        ),
      ).toEqual("1")
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it("treats before_run failures as fatal", async () => {
    const cwd = await mkdtemp(
      path.join(os.tmpdir(), "grepline-workspace-before-run-"),
    )

    try {
      const options = {
        cwd,
        workspace_root: "workspaces",
        hooks: makeHooksConfig({ before_run: "exit 17" }),
      }
      const workspace = await Effect.runPromise(
        ensureWorkspace(sampleIssue, {
          ...options,
          hooks: makeHooksConfig(),
        }),
      )
      const error = await Effect.runPromise(
        Effect.flip(runBeforeRunHook(workspace.path, sampleIssue, options)),
      )

      expect(error.code).toEqual("workspace_operation_failed")
      expect(error.details?.hook_name).toEqual("before_run")
      expect(error.details?.exit_code).toEqual(17)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it("ignores after_run and before_remove failures while preserving cleanup", async () => {
    const cwd = await mkdtemp(
      path.join(os.tmpdir(), "grepline-workspace-best-effort-"),
    )

    try {
      const workspace = await Effect.runPromise(
        ensureWorkspace(sampleIssue, {
          cwd,
          workspace_root: "workspaces",
          hooks: makeHooksConfig(),
        }),
      )

      const options = {
        cwd,
        workspace_root: "workspaces",
        hooks: makeHooksConfig({
          after_run: "exit 19",
          before_remove: "exit 23",
        }),
      }

      await Effect.runPromise(
        runAfterRunHook(workspace.path, sampleIssue, options),
      )
      await Effect.runPromise(
        removeWorkspaceForIssue(sampleIssue.identifier, options),
      )

      expect(await pathExists(workspace.path)).toEqual(false)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it("uses the configured hook timeout", async () => {
    const cwd = await mkdtemp(
      path.join(os.tmpdir(), "grepline-workspace-timeout-"),
    )

    try {
      const workspace = await Effect.runPromise(
        ensureWorkspace(sampleIssue, {
          cwd,
          workspace_root: "workspaces",
          hooks: makeHooksConfig(),
        }),
      )
      const options = {
        cwd,
        workspace_root: "workspaces",
        hooks: makeHooksConfig({
          before_run: "sleep 1",
          timeout_ms: 50,
        }),
      }
      const error = await Effect.runPromise(
        Effect.flip(runBeforeRunHook(workspace.path, sampleIssue, options)),
      )

      expect(error.code).toEqual("workspace_operation_failed")
      expect(error.details?.hook_name).toEqual("before_run")
      expect(error.details?.timeout_ms).toEqual(50)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it("removes terminal issue workspaces without touching unrelated directories", async () => {
    const cwd = await mkdtemp(
      path.join(os.tmpdir(), "grepline-workspace-cleanup-"),
    )

    try {
      const options = {
        cwd,
        workspace_root: "workspaces",
        hooks: makeHooksConfig(),
      }
      const firstWorkspace = await Effect.runPromise(
        ensureWorkspace("ABC-123", options),
      )
      const secondWorkspace = await Effect.runPromise(
        ensureWorkspace("XYZ 45", options),
      )
      const unrelatedDirectory = path.join(cwd, "workspaces", "keep-me")

      await mkdir(unrelatedDirectory, { recursive: true })
      await Effect.runPromise(
        cleanupTerminalWorkspaces(["ABC-123", "XYZ 45"], options),
      )

      expect(await pathExists(firstWorkspace.path)).toEqual(false)
      expect(await pathExists(secondWorkspace.path)).toEqual(false)
      expect(await pathExists(unrelatedDirectory)).toEqual(true)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
