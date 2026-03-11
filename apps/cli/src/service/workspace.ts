import { spawn } from "node:child_process"
import { lstat, mkdir, readlink, realpath, rm } from "node:fs/promises"
import path from "node:path"

import { Effect } from "effect"

import { runtimeError, type RuntimeError } from "../domain/errors"
import {
  DEFAULT_HOOK_TIMEOUT_MS,
  sanitizeWorkspaceKey,
  type HooksConfig,
  type Issue,
  type Workspace,
} from "../domain/models"
import {
  compactLogFields,
  issueLogFields,
  logInfo,
  logWarning,
} from "../observability/logging"

export type WorkspaceTarget = string | Pick<Issue, "id" | "identifier">

export type WorkspaceManagerOptions = {
  readonly workspace_root: string
  readonly hooks: HooksConfig
  readonly cwd?: string
}

export type ResolvedWorkspacePaths = {
  readonly workspace_root: string
  readonly workspace_key: string
  readonly workspace_path: string
}

type HookName = "after_create" | "before_run" | "after_run" | "before_remove"

type IssueContext = {
  readonly issue_id: string | undefined
  readonly issue_identifier: string
}

type WorkspaceEntryKind = "missing" | "directory" | "symlink" | "other"

type HookExecutionResult =
  | {
      readonly _tag: "completed"
      readonly exit_code: number
      readonly output: string
    }
  | {
      readonly _tag: "timed_out"
      readonly output: string
    }

const resolveAbsoluteWorkspaceRoot = (
  workspaceRoot: string,
  cwd = process.cwd(),
): string =>
  path.isAbsolute(workspaceRoot)
    ? workspaceRoot
    : path.resolve(cwd, workspaceRoot)

const issueContextFrom = (target: WorkspaceTarget): IssueContext =>
  typeof target === "string"
    ? {
        issue_id: undefined,
        issue_identifier: target,
      }
    : {
        issue_id: target.id,
        issue_identifier: target.identifier,
      }

const isSubdirectory = (
  parentDirectory: string,
  candidatePath: string,
): boolean => {
  const relativePath = path.relative(parentDirectory, candidatePath)

  return (
    relativePath !== "" &&
    !relativePath.startsWith("..") &&
    !path.isAbsolute(relativePath)
  )
}

const workspaceError = (
  message: string,
  details?: Readonly<Record<string, unknown>>,
): RuntimeError => runtimeError("workspace_operation_failed", message, details)

const workspaceInvariantError = (
  message: string,
  details?: Readonly<Record<string, unknown>>,
): RuntimeError => runtimeError("runtime_invariant_violation", message, details)

const getWorkspaceEntryKind = (
  workspacePath: string,
): Effect.Effect<WorkspaceEntryKind, RuntimeError> =>
  Effect.tryPromise({
    try: async () => {
      try {
        const entry = await lstat(workspacePath)

        if (entry.isSymbolicLink()) {
          return "symlink"
        }

        return entry.isDirectory() ? "directory" : "other"
      } catch (cause) {
        const error = cause as NodeJS.ErrnoException
        if (error.code === "ENOENT") {
          return "missing"
        }

        throw cause
      }
    },
    catch: (cause) =>
      workspaceError("failed to inspect workspace path", {
        workspace_path: workspacePath,
        cause: String(cause),
      }),
  })

const truncateOutputForLog = (output: string, maxBytes = 2_048): string => {
  const buffer = Buffer.from(output)

  return buffer.byteLength <= maxBytes
    ? output
    : `${buffer.subarray(0, maxBytes).toString("utf8")}... (truncated)`
}

const hookTimeoutMs = (hooks: HooksConfig): number =>
  hooks.timeout_ms > 0 ? hooks.timeout_ms : DEFAULT_HOOK_TIMEOUT_MS

const cwdOptions = (
  cwd: string | undefined,
): {
  readonly cwd?: string
} => (cwd === undefined ? {} : { cwd })

const hookLogFields = (
  hookName: HookName,
  workspacePath: string,
  issueContext: IssueContext,
  extraFields: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> =>
  compactLogFields({
    hook_name: hookName,
    workspace_path: workspacePath,
    ...(issueContext.issue_id === undefined
      ? { issue_identifier: issueContext.issue_identifier }
      : issueLogFields({
          id: issueContext.issue_id,
          identifier: issueContext.issue_identifier,
        })),
    ...extraFields,
  })

const executeHookScript = (
  script: string,
  workspacePath: string,
  timeoutMs: number,
): Effect.Effect<HookExecutionResult, RuntimeError> =>
  Effect.tryPromise({
    try: () =>
      new Promise<HookExecutionResult>((resolve, reject) => {
        const child = spawn("sh", ["-lc", script], {
          cwd: workspacePath,
          stdio: ["ignore", "pipe", "pipe"],
        })

        let output = ""
        let didTimeOut = false
        const timer = setTimeout(() => {
          didTimeOut = true
          child.kill("SIGKILL")
        }, timeoutMs)

        const appendChunk = (chunk: string | Buffer): void => {
          output += chunk.toString()
        }

        child.stdout?.on("data", appendChunk)
        child.stderr?.on("data", appendChunk)

        child.once("error", (cause) => {
          clearTimeout(timer)
          reject(cause)
        })

        child.once("close", (code) => {
          clearTimeout(timer)

          if (didTimeOut) {
            resolve({
              _tag: "timed_out",
              output,
            })

            return
          }

          resolve({
            _tag: "completed",
            exit_code: code ?? 1,
            output,
          })
        })
      }),
    catch: (cause) =>
      workspaceError("failed to execute workspace hook", {
        workspace_path: workspacePath,
        cause: String(cause),
      }),
  })

const assertWorkspaceDirectoryWithinRoot = (
  workspacePath: string,
  options: Pick<WorkspaceManagerOptions, "workspace_root" | "cwd">,
): Effect.Effect<void, RuntimeError> =>
  Effect.gen(function* () {
    const { workspace_path, workspace_root } =
      yield* assertWorkspacePathWithinRoot(
        workspacePath,
        options.workspace_root,
        cwdOptions(options.cwd),
      )
    const workspaceEntry = yield* getWorkspaceEntryKind(workspace_path)

    if (workspaceEntry !== "directory") {
      return yield* workspaceError("workspace path is not a directory", {
        workspace_path,
        workspace_root,
        entry_kind: workspaceEntry,
      })
    }

    const [realWorkspaceRoot, realWorkspacePath] = yield* Effect.tryPromise({
      try: () =>
        Promise.all([realpath(workspace_root), realpath(workspace_path)]),
      catch: (cause) =>
        workspaceError("failed to resolve workspace path", {
          workspace_path,
          workspace_root,
          cause: String(cause),
        }),
    })

    if (!isSubdirectory(realWorkspaceRoot, realWorkspacePath)) {
      return yield* workspaceInvariantError(
        "workspace directory escapes the workspace root",
        {
          workspace_path,
          workspace_root,
          real_workspace_root: realWorkspaceRoot,
          real_workspace_path: realWorkspacePath,
        },
      )
    }
  })

const runHook = (
  hookName: HookName,
  script: string,
  workspacePath: string,
  issueContext: IssueContext,
  options: WorkspaceManagerOptions,
): Effect.Effect<void, RuntimeError> =>
  Effect.gen(function* () {
    const timeoutMs = hookTimeoutMs(options.hooks)

    yield* assertWorkspaceDirectoryWithinRoot(workspacePath, options)
    yield* logInfo(
      "workspace hook started",
      hookLogFields(hookName, workspacePath, issueContext, {
        timeout_ms: timeoutMs,
      }),
    )

    const result = yield* executeHookScript(script, workspacePath, timeoutMs)

    if (result._tag === "timed_out") {
      yield* logWarning(
        "workspace hook timed out",
        hookLogFields(hookName, workspacePath, issueContext, {
          timeout_ms: timeoutMs,
          output: truncateOutputForLog(result.output),
        }),
      )

      return yield* workspaceError("workspace hook timed out", {
        hook_name: hookName,
        workspace_path: workspacePath,
        timeout_ms: timeoutMs,
      })
    }

    if (result.exit_code !== 0) {
      yield* logWarning(
        "workspace hook failed",
        hookLogFields(hookName, workspacePath, issueContext, {
          exit_code: result.exit_code,
          output: truncateOutputForLog(result.output),
        }),
      )

      return yield* workspaceError("workspace hook failed", {
        hook_name: hookName,
        workspace_path: workspacePath,
        exit_code: result.exit_code,
      })
    }

    yield* logInfo(
      "workspace hook completed",
      hookLogFields(hookName, workspacePath, issueContext),
    )
  })

const ignoreHookFailure = (effect: Effect.Effect<void, RuntimeError>) =>
  Effect.match(effect, {
    onFailure: () => undefined,
    onSuccess: () => undefined,
  })

const removeWorkspacePath = (
  workspacePath: string,
): Effect.Effect<void, RuntimeError> =>
  Effect.tryPromise({
    try: () => rm(workspacePath, { recursive: true, force: true }),
    catch: (cause) =>
      workspaceError("failed to remove workspace path", {
        workspace_path: workspacePath,
        cause: String(cause),
      }),
  })

export const resolveWorkspacePaths = (
  issueIdentifier: string,
  options: Pick<WorkspaceManagerOptions, "workspace_root" | "cwd">,
): ResolvedWorkspacePaths => {
  const workspace_root = resolveAbsoluteWorkspaceRoot(
    options.workspace_root,
    options.cwd,
  )
  const workspace_key = sanitizeWorkspaceKey(issueIdentifier)

  return {
    workspace_root,
    workspace_key,
    workspace_path: path.join(workspace_root, workspace_key),
  }
}

export const assertWorkspacePathWithinRoot = (
  workspacePath: string,
  workspaceRoot: string,
  options: {
    readonly cwd?: string
  } = {},
): Effect.Effect<
  {
    readonly workspace_root: string
    readonly workspace_path: string
  },
  RuntimeError
> =>
  Effect.gen(function* () {
    const absoluteWorkspaceRoot = resolveAbsoluteWorkspaceRoot(
      workspaceRoot,
      options.cwd,
    )
    const absoluteWorkspacePath = path.resolve(
      options.cwd ?? process.cwd(),
      workspacePath,
    )

    if (!isSubdirectory(absoluteWorkspaceRoot, absoluteWorkspacePath)) {
      return yield* workspaceInvariantError(
        "workspace path escapes the workspace root",
        {
          workspace_root: absoluteWorkspaceRoot,
          workspace_path: absoluteWorkspacePath,
        },
      )
    }

    return {
      workspace_root: absoluteWorkspaceRoot,
      workspace_path: absoluteWorkspacePath,
    }
  })

export const ensureWorkspace = (
  target: WorkspaceTarget,
  options: WorkspaceManagerOptions,
): Effect.Effect<Workspace, RuntimeError> =>
  Effect.gen(function* () {
    const issueContext = issueContextFrom(target)
    const workspace = resolveWorkspacePaths(
      issueContext.issue_identifier,
      options,
    )

    yield* Effect.tryPromise({
      try: () => mkdir(workspace.workspace_root, { recursive: true }),
      catch: (cause) =>
        workspaceError("failed to create workspace root", {
          workspace_root: workspace.workspace_root,
          cause: String(cause),
        }),
    })

    yield* assertWorkspacePathWithinRoot(
      workspace.workspace_path,
      workspace.workspace_root,
      cwdOptions(options.cwd),
    )

    const existingEntry = yield* getWorkspaceEntryKind(workspace.workspace_path)
    if (existingEntry === "symlink" || existingEntry === "other") {
      return yield* workspaceError(
        "workspace path already exists and is not a directory",
        {
          workspace_path: workspace.workspace_path,
          workspace_root: workspace.workspace_root,
          entry_kind: existingEntry,
        },
      )
    }

    const created_now = existingEntry === "missing"
    if (created_now) {
      yield* Effect.tryPromise({
        try: () => mkdir(workspace.workspace_path, { recursive: true }),
        catch: (cause) =>
          workspaceError("failed to create workspace directory", {
            workspace_path: workspace.workspace_path,
            workspace_root: workspace.workspace_root,
            cause: String(cause),
          }),
      })
    }

    yield* assertWorkspaceDirectoryWithinRoot(workspace.workspace_path, options)

    const preparedWorkspace: Workspace = {
      path: workspace.workspace_path,
      workspace_key: workspace.workspace_key,
      created_now,
    }

    if (!created_now || options.hooks.after_create === null) {
      return preparedWorkspace
    }

    const afterCreateResult = yield* Effect.match(
      runHook(
        "after_create",
        options.hooks.after_create,
        preparedWorkspace.path,
        issueContext,
        options,
      ),
      {
        onFailure: (error) => ({ _tag: "failure" as const, error }),
        onSuccess: () => ({ _tag: "success" as const }),
      },
    )

    if (afterCreateResult._tag === "failure") {
      yield* ignoreHookFailure(removeWorkspacePath(preparedWorkspace.path))
      return yield* afterCreateResult.error
    }

    return preparedWorkspace
  })

export const runBeforeRunHook = (
  workspacePath: string,
  target: WorkspaceTarget,
  options: WorkspaceManagerOptions,
): Effect.Effect<void, RuntimeError> => {
  const script = options.hooks.before_run

  return script === null
    ? Effect.void
    : runHook(
        "before_run",
        script,
        workspacePath,
        issueContextFrom(target),
        options,
      )
}

export const runAfterRunHook = (
  workspacePath: string,
  target: WorkspaceTarget,
  options: WorkspaceManagerOptions,
): Effect.Effect<void> => {
  const script = options.hooks.after_run

  return script === null
    ? Effect.void
    : ignoreHookFailure(
        runHook(
          "after_run",
          script,
          workspacePath,
          issueContextFrom(target),
          options,
        ),
      )
}

export const removeWorkspaceForIssue = (
  issueIdentifier: string,
  options: WorkspaceManagerOptions,
): Effect.Effect<void, RuntimeError> =>
  Effect.gen(function* () {
    const workspace = resolveWorkspacePaths(issueIdentifier, options)

    yield* assertWorkspacePathWithinRoot(
      workspace.workspace_path,
      workspace.workspace_root,
      cwdOptions(options.cwd),
    )

    const entryKind = yield* getWorkspaceEntryKind(workspace.workspace_path)
    if (entryKind === "missing") {
      return
    }

    if (entryKind === "directory" && options.hooks.before_remove !== null) {
      yield* ignoreHookFailure(
        runHook(
          "before_remove",
          options.hooks.before_remove,
          workspace.workspace_path,
          issueContextFrom(issueIdentifier),
          options,
        ),
      )
    }

    if (entryKind === "symlink") {
      const targetPath = yield* Effect.tryPromise({
        try: () => readlink(workspace.workspace_path),
        catch: (cause) =>
          workspaceError("failed to inspect workspace symlink", {
            workspace_path: workspace.workspace_path,
            cause: String(cause),
          }),
      })

      yield* logWarning("removing workspace symlink without hooks", {
        workspace_path: workspace.workspace_path,
        workspace_root: workspace.workspace_root,
        symlink_target: targetPath,
        issue_identifier: issueIdentifier,
      })
    }

    yield* removeWorkspacePath(workspace.workspace_path)
  })

export const cleanupTerminalWorkspaces = (
  issueIdentifiers: ReadonlyArray<string>,
  options: WorkspaceManagerOptions,
): Effect.Effect<void, RuntimeError> =>
  Effect.forEach(issueIdentifiers, (issueIdentifier) =>
    removeWorkspaceForIssue(issueIdentifier, options),
  ).pipe(Effect.asVoid)
