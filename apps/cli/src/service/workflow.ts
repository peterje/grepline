import os from "node:os"
import path from "node:path"
import { readFile } from "node:fs/promises"

import {
  Array as Arr,
  Effect,
  Option,
  Predicate,
  Schema,
  SchemaTransformation,
} from "effect"

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
  DEFAULT_WORKSPACE_DIRECTORY,
  JsonMap,
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

const NonBlankString = Schema.String.pipe(
  Schema.decode(SchemaTransformation.trim()),
  Schema.check(Schema.isNonEmpty()),
)

const IntegerLike = Schema.Union([
  Schema.Int,
  Schema.NumberFromString.pipe(Schema.check(Schema.isInt())),
])

const PositiveInteger = IntegerLike.pipe(Schema.check(Schema.isGreaterThan(0)))

const NonNegativeInteger = IntegerLike.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(0)),
)

const decodeJsonMap = Schema.decodeUnknownOption(JsonMap)
const decodeString = Schema.decodeUnknownOption(Schema.String)
const decodeUnknownArray = Schema.decodeUnknownOption(
  Schema.Array(Schema.Unknown),
)
const decodeNonBlankString = Schema.decodeUnknownOption(NonBlankString)
const decodePositiveInteger = Schema.decodeUnknownOption(PositiveInteger)
const decodeNonNegativeInteger = Schema.decodeUnknownOption(NonNegativeInteger)

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
  Option.match(decodeString(value), {
    onNone: () => undefined,
    onSome: (string) => string,
  })

const readNonBlankString = (value: unknown): string | null => {
  return Option.match(decodeNonBlankString(value), {
    onNone: () => null,
    onSome: (string) => string,
  })
}

const readOptionalString = (value: unknown): string | null =>
  Option.match(decodeString(value), {
    onNone: () => null,
    onSome: (string) => string,
  })

const readJsonMap = (value: unknown): JsonMap =>
  Option.getOrElse(decodeJsonMap(value), () => ({}))

const readStringArray = (
  value: unknown,
  fallback: ReadonlyArray<string>,
): Array<string> => {
  return Option.match(decodeUnknownArray(value), {
    onNone: () => [...fallback],
    onSome: (entries) => {
      const items = Arr.filter(entries, Predicate.isString)
      return items.length === 0 ? [...fallback] : items
    },
  })
}

const parsePositiveInteger = (value: unknown, fallback: number): number => {
  return Option.getOrElse(decodePositiveInteger(value), () => fallback)
}

const parseNonNegativeInteger = (value: unknown, fallback: number): number => {
  return Option.getOrElse(decodeNonNegativeInteger(value), () => fallback)
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
  return Option.match(decodeJsonMap(value), {
    onNone: () => ({}),
    onSome: (limits) =>
      Object.fromEntries(
        Object.entries(limits).flatMap(([state, limit]) => {
          const normalizedState = state.trim().toLowerCase()

          if (normalizedState === "") {
            return []
          }

          return Option.match(decodePositiveInteger(limit), {
            onNone: () => [],
            onSome: (parsedLimit) => [[normalizedState, parsedLimit] as const],
          })
        }),
      ),
  })
}

export const parseWorkflowDefinition = (
  content: string,
): Effect.Effect<WorkflowDefinition, StartupError> =>
  Effect.try({
    try: () => {
      const { frontMatter, promptBody } = splitWorkflowContent(content)
      const config =
        frontMatter.trim() === ""
          ? {}
          : Option.match(decodeJsonMap(Bun.YAML.parse(frontMatter)), {
              onNone: () => {
                throw startupError(
                  "workflow_front_matter_not_a_map",
                  "workflow front matter must decode to an object",
                )
              },
              onSome: (parsed) => parsed,
            })

      return {
        config,
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

  return Effect.tryPromise({
    try: () => readFile(workflow_path, "utf8"),
    catch: (cause) =>
      startupError("missing_workflow_file", "failed to read workflow file", {
        workflow_path,
        cause: String(cause),
      }),
  }).pipe(
    Effect.flatMap((content) => parseWorkflowDefinition(content)),
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
    Effect.map((workflow) => ({
      workflow_path,
      workflow,
    })),
  )
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

  const normalized = readJsonMap(config)
  const tracker = readJsonMap(normalized.tracker)
  const polling = readJsonMap(normalized.polling)
  const workspace = readJsonMap(normalized.workspace)
  const hooks = readJsonMap(normalized.hooks)
  const agent = readJsonMap(normalized.agent)
  const codex = readJsonMap(normalized.codex)
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
      turn_sandbox_policy: Option.getOrElse(
        decodeJsonMap(turnSandboxPolicy),
        () => null,
      ),
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
  const errors = Arr.filter(
    [
      config.tracker.kind === null
        ? "tracker.kind is required"
        : config.tracker.kind !== "linear"
          ? `tracker.kind '${config.tracker.kind}' is not supported`
          : null,
      config.tracker.kind === "linear" && config.tracker.api_key === null
        ? "tracker.api_key is required for linear"
        : null,
      config.tracker.kind === "linear" && config.tracker.project_slug === null
        ? "tracker.project_slug is required for linear"
        : null,
      config.codex.command.trim() === ""
        ? "codex.command must not be empty"
        : null,
    ],
    Predicate.isNotNull,
  )

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
