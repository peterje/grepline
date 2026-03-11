import os from "node:os"
import path from "node:path"
import { readFile } from "node:fs/promises"

import { Effect } from "effect"

import { StartupError, startupError } from "../domain/errors"
import {
  DEFAULT_ACTIVE_STATES,
  DEFAULT_CODEX_COMMAND,
  DEFAULT_CODEX_READ_TIMEOUT_MS,
  DEFAULT_CODEX_STALL_TIMEOUT_MS,
  DEFAULT_CODEX_TURN_TIMEOUT_MS,
  DEFAULT_HOOK_TIMEOUT_MS,
  DEFAULT_LINEAR_ENDPOINT,
  DEFAULT_MAX_CONCURRENT_AGENTS,
  DEFAULT_MAX_RETRY_BACKOFF_MS,
  DEFAULT_MAX_TURNS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_TERMINAL_STATES,
  DEFAULT_WORKFLOW_FILE,
  DEFAULT_WORKSPACE_DIRECTORY,
  type JsonMap,
  type WorkflowConfig,
  type WorkflowDefinition,
} from "../domain/models"
import { resolveWorkflowPath } from "./shell"

export type LoadWorkflowDefinitionOptions = {
  readonly cwd: string
  readonly workflow_path?: string
}

export type ResolveWorkflowConfigOptions = {
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
  readonly home_directory?: string
  readonly temp_directory?: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const toJsonMap = (value: Record<string, unknown>): JsonMap =>
  Object.fromEntries(Object.entries(value))

const normalizeKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeKeys(entry))
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        normalizeKeys(nested),
      ]),
    )
  }

  return value
}

const splitWorkflowContent = (
  content: string,
): {
  readonly frontMatter: string
  readonly promptBody: string
} => {
  if (!content.startsWith("---")) {
    return { frontMatter: "", promptBody: content }
  }

  const lineBreakMatch = content.match(/\r?\n/)
  const lineBreak = lineBreakMatch?.[0] ?? "\n"
  const firstLineEnd = content.indexOf(lineBreak)

  if (firstLineEnd === -1) {
    return { frontMatter: content.slice(3), promptBody: "" }
  }

  const remainder = content.slice(firstLineEnd + lineBreak.length)
  const closingFence = `${lineBreak}---`
  const closingIndex = remainder.indexOf(closingFence)

  if (closingIndex === -1) {
    return { frontMatter: remainder, promptBody: "" }
  }

  const frontMatter = remainder.slice(0, closingIndex)
  const afterClosingFence = remainder.slice(closingIndex + closingFence.length)
  const promptBody = afterClosingFence.startsWith(lineBreak)
    ? afterClosingFence.slice(lineBreak.length)
    : afterClosingFence

  return { frontMatter, promptBody }
}

const readString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined

const readNonBlankString = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null
  }

  const normalized = value.trim()
  return normalized === "" ? null : normalized
}

const readOptionalString = (value: unknown): string | null =>
  typeof value === "string" ? value : null

const readObject = (value: unknown): Record<string, unknown> =>
  isRecord(value) ? value : {}

const readStringArray = (
  value: unknown,
  fallback: ReadonlyArray<string>,
): Array<string> => {
  if (!Array.isArray(value)) {
    return [...fallback]
  }

  const items = value.filter(
    (entry): entry is string => typeof entry === "string",
  )
  return items.length > 0 ? items : [...fallback]
}

const parseInteger = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value
  }

  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    return Number.parseInt(value.trim(), 10)
  }

  return undefined
}

const parsePositiveInteger = (value: unknown, fallback: number): number => {
  const parsed = parseInteger(value)
  return parsed !== undefined && parsed > 0 ? parsed : fallback
}

const parseNonNegativeInteger = (value: unknown, fallback: number): number => {
  const parsed = parseInteger(value)
  return parsed !== undefined && parsed >= 0 ? parsed : fallback
}

const isEnvReference = (value: string): boolean =>
  /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(value)

const resolveEnvReference = (
  value: string,
  env: NodeJS.ProcessEnv,
): string | undefined => {
  if (!isEnvReference(value)) {
    return value
  }

  const resolved = env[value.slice(1)]
  if (resolved === undefined || resolved === "") {
    return undefined
  }

  return resolved
}

const resolveTrackerApiKey = (
  rawValue: unknown,
  env: NodeJS.ProcessEnv,
): string | null => {
  const directValue = readString(rawValue)
  const resolvedValue =
    directValue === undefined
      ? env.LINEAR_API_KEY
      : resolveEnvReference(directValue, env)

  return resolvedValue === undefined || resolvedValue.trim() === ""
    ? null
    : resolvedValue
}

const expandHomeDirectory = (value: string, homeDirectory: string): string => {
  if (value === "~") {
    return homeDirectory
  }

  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(homeDirectory, value.slice(2))
  }

  return value
}

const hasPathSeparator = (value: string): boolean =>
  value.includes(path.sep) || value.includes("/") || value.includes("\\")

const resolveWorkspaceRoot = (
  rawValue: unknown,
  options: Required<ResolveWorkflowConfigOptions>,
): string => {
  const defaultRoot = path.join(
    options.temp_directory,
    DEFAULT_WORKSPACE_DIRECTORY,
  )
  const configured = readString(rawValue)

  if (configured === undefined) {
    return defaultRoot
  }

  const resolved = resolveEnvReference(configured, options.env)
  if (resolved === undefined || resolved.trim() === "") {
    return defaultRoot
  }

  const expanded = expandHomeDirectory(resolved, options.home_directory)

  if (expanded === "." || expanded === ".." || hasPathSeparator(expanded)) {
    return path.resolve(options.cwd, expanded)
  }

  return expanded
}

const normalizeStateLimits = (value: unknown): Record<string, number> => {
  if (!isRecord(value)) {
    return {}
  }

  return Object.fromEntries(
    Object.entries(value).flatMap(([state, limit]) => {
      const normalizedState = state.trim().toLowerCase()
      const parsedLimit = parseInteger(limit)

      if (
        normalizedState === "" ||
        parsedLimit === undefined ||
        parsedLimit <= 0
      ) {
        return []
      }

      return [[normalizedState, parsedLimit] as const]
    }),
  )
}

export const parseWorkflowDefinition = (
  content: string,
): Effect.Effect<WorkflowDefinition, StartupError> =>
  Effect.try({
    try: () => {
      const { frontMatter, promptBody } = splitWorkflowContent(content)

      if (frontMatter.trim() === "") {
        return {
          config: {},
          prompt_template: promptBody.trim(),
        }
      }

      const parsed = normalizeKeys(Bun.YAML.parse(frontMatter))
      if (!isRecord(parsed)) {
        throw startupError(
          "workflow_front_matter_not_a_map",
          "workflow front matter must decode to an object",
        )
      }

      return {
        config: toJsonMap(parsed),
        prompt_template: promptBody.trim(),
      }
    },
    catch: (cause) => {
      if (cause instanceof StartupError) {
        return cause
      }

      return startupError(
        "workflow_parse_error",
        "failed to parse workflow file",
        { cause: String(cause) },
      )
    },
  })

export const loadWorkflowDefinition = (
  options: LoadWorkflowDefinitionOptions,
): Effect.Effect<
  {
    readonly workflow_path: string
    readonly workflow: WorkflowDefinition
  },
  StartupError
> => {
  const workflow_path = resolveWorkflowPath(options.cwd, options.workflow_path)

  return Effect.gen(function* () {
    const content = yield* Effect.tryPromise({
      try: () => readFile(workflow_path, "utf8"),
      catch: (cause) =>
        startupError("missing_workflow_file", "failed to read workflow file", {
          workflow_path,
          cause: String(cause),
        }),
    })
    const workflow = yield* parseWorkflowDefinition(content).pipe(
      Effect.mapError((error) =>
        error.code === "workflow_parse_error"
          ? startupError(error.code, error.message, {
              ...error.details,
              workflow_path,
            })
          : error.code === "workflow_front_matter_not_a_map"
            ? startupError(error.code, error.message, {
                workflow_path,
              })
            : error,
      ),
    )

    return {
      workflow_path,
      workflow,
    }
  })
}

export const resolveWorkflowConfig = (
  config: JsonMap,
  options: ResolveWorkflowConfigOptions = {},
): WorkflowConfig => {
  const resolvedOptions: Required<ResolveWorkflowConfigOptions> = {
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    home_directory: options.home_directory ?? process.env.HOME ?? os.homedir(),
    temp_directory: options.temp_directory ?? os.tmpdir(),
  }

  const normalized = readObject(normalizeKeys(config))
  const tracker = readObject(normalized.tracker)
  const polling = readObject(normalized.polling)
  const workspace = readObject(normalized.workspace)
  const hooks = readObject(normalized.hooks)
  const agent = readObject(normalized.agent)
  const codex = readObject(normalized.codex)
  const turnSandboxPolicy = codex.turn_sandbox_policy

  return {
    tracker: {
      kind: readNonBlankString(tracker.kind),
      endpoint: readNonBlankString(tracker.endpoint) ?? DEFAULT_LINEAR_ENDPOINT,
      api_key: resolveTrackerApiKey(tracker.api_key, resolvedOptions.env),
      project_slug: readNonBlankString(tracker.project_slug),
      active_states: readStringArray(
        tracker.active_states,
        DEFAULT_ACTIVE_STATES,
      ),
      terminal_states: readStringArray(
        tracker.terminal_states,
        DEFAULT_TERMINAL_STATES,
      ),
    },
    polling: {
      interval_ms: parsePositiveInteger(
        polling.interval_ms,
        DEFAULT_POLL_INTERVAL_MS,
      ),
    },
    workspace: {
      root: resolveWorkspaceRoot(workspace.root, resolvedOptions),
    },
    hooks: {
      after_create: readOptionalString(hooks.after_create),
      before_run: readOptionalString(hooks.before_run),
      after_run: readOptionalString(hooks.after_run),
      before_remove: readOptionalString(hooks.before_remove),
      timeout_ms: parsePositiveInteger(
        hooks.timeout_ms,
        DEFAULT_HOOK_TIMEOUT_MS,
      ),
    },
    agent: {
      max_concurrent_agents: parsePositiveInteger(
        agent.max_concurrent_agents,
        DEFAULT_MAX_CONCURRENT_AGENTS,
      ),
      max_turns: parsePositiveInteger(agent.max_turns, DEFAULT_MAX_TURNS),
      max_retry_backoff_ms: parsePositiveInteger(
        agent.max_retry_backoff_ms,
        DEFAULT_MAX_RETRY_BACKOFF_MS,
      ),
      max_concurrent_agents_by_state: normalizeStateLimits(
        agent.max_concurrent_agents_by_state,
      ),
    },
    codex: {
      command: readString(codex.command) ?? DEFAULT_CODEX_COMMAND,
      approval_policy: codex.approval_policy ?? null,
      thread_sandbox: readNonBlankString(codex.thread_sandbox),
      turn_sandbox_policy: isRecord(turnSandboxPolicy)
        ? toJsonMap(normalizeKeys(turnSandboxPolicy) as Record<string, unknown>)
        : null,
      turn_timeout_ms: parsePositiveInteger(
        codex.turn_timeout_ms,
        DEFAULT_CODEX_TURN_TIMEOUT_MS,
      ),
      read_timeout_ms: parsePositiveInteger(
        codex.read_timeout_ms,
        DEFAULT_CODEX_READ_TIMEOUT_MS,
      ),
      stall_timeout_ms: parseNonNegativeInteger(
        codex.stall_timeout_ms,
        DEFAULT_CODEX_STALL_TIMEOUT_MS,
      ),
    },
  }
}

export const validateWorkflowStartupConfig = (
  config: WorkflowConfig,
): Effect.Effect<void, StartupError> => {
  const errors: Array<string> = []

  if (config.tracker.kind === null) {
    errors.push("tracker.kind is required")
  } else if (config.tracker.kind !== "linear") {
    errors.push(`tracker.kind '${config.tracker.kind}' is not supported`)
  }

  if (config.tracker.kind === "linear" && config.tracker.api_key === null) {
    errors.push("tracker.api_key is required for linear")
  }

  if (
    config.tracker.kind === "linear" &&
    config.tracker.project_slug === null
  ) {
    errors.push("tracker.project_slug is required for linear")
  }

  if (config.codex.command.trim() === "") {
    errors.push("codex.command must not be empty")
  }

  return errors.length === 0
    ? Effect.void
    : Effect.fail(
        startupError(
          "startup_validation_failed",
          "workflow startup validation failed",
          { errors },
        ),
      )
}
