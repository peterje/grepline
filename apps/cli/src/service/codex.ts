import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { lstat, realpath } from "node:fs/promises"
import path from "node:path"

import { Effect } from "effect"

import { RuntimeError, runtimeError } from "../domain/errors"
import {
  DEFAULT_CODEX_APPROVAL_POLICY,
  DEFAULT_CODEX_THREAD_SANDBOX,
  makeDefaultCodexTurnSandboxPolicy,
  type CodexConfig,
  type Issue,
  type JsonMap,
} from "../domain/models"
import { logInfo, logWarning } from "../observability/logging"
import { assertWorkspacePathWithinRoot } from "./workspace"

const INITIALIZE_REQUEST_ID = 1
const THREAD_START_REQUEST_ID = 2
const FIRST_TURN_REQUEST_ID = 3
const MAX_PROTOCOL_LINE_BYTES = 10 * 1024 * 1024
const MAX_DIAGNOSTIC_LINES = 20

const CLIENT_INFO = {
  name: "grepline",
  version: "0.0.0",
} as const

export const DEFAULT_CODEX_INTERACTION_POLICY = {
  approval_requests: "auto_approve_for_session",
  user_input_requests: "fail_turn",
  unsupported_tool_calls: "return_failure_result",
} as const

export type CodexInteractionPolicy = typeof DEFAULT_CODEX_INTERACTION_POLICY

export type CodexUsage = {
  readonly input_tokens: number
  readonly output_tokens: number
  readonly total_tokens: number
}

export type CodexRuntimeEventName =
  | "session_started"
  | "startup_failed"
  | "turn_completed"
  | "turn_failed"
  | "turn_cancelled"
  | "turn_ended_with_error"
  | "turn_input_required"
  | "approval_auto_approved"
  | "unsupported_tool_call"
  | "notification"
  | "other_message"
  | "malformed"

export type CodexRuntimeEvent = {
  readonly event: CodexRuntimeEventName
  readonly timestamp: string
  readonly codex_app_server_pid: string | null
  readonly usage?: CodexUsage
  readonly rate_limits?: JsonMap
  readonly thread_id?: string
  readonly turn_id?: string
  readonly session_id?: string
  readonly method?: string
  readonly message?: string
  readonly error_code?: string
  readonly payload?: unknown
  readonly raw?: string
}

export type CodexToolCallRequest = {
  readonly tool_name: string | null
  readonly arguments: unknown
  readonly payload: Readonly<Record<string, unknown>>
}

export type CodexToolCallResult = Readonly<Record<string, unknown>>

export type StartCodexAppServerSessionOptions = {
  readonly workspace_root: string
  readonly codex: CodexConfig
  readonly cwd?: string
  readonly dynamic_tools?: ReadonlyArray<JsonMap>
  readonly on_event?: (event: CodexRuntimeEvent) => void
  readonly tool_call_handler?: (
    request: CodexToolCallRequest,
  ) => CodexToolCallResult | PromiseLike<CodexToolCallResult>
}

export type RunCodexTurnOptions = {
  readonly prompt: string
  readonly issue: Pick<Issue, "identifier" | "title">
}

export type CodexTurnResult = {
  readonly session_id: string
  readonly thread_id: string
  readonly turn_id: string
}

type ParsedProtocolMessage =
  | {
      readonly _tag: "json"
      readonly raw: string
      readonly payload: unknown
    }
  | {
      readonly _tag: "malformed"
      readonly raw: string
      readonly message: string
    }

type ProcessExitState = {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
}

type ResolvedCodexRuntimeConfig = {
  readonly command: string
  readonly approval_policy: unknown
  readonly thread_sandbox: string
  readonly turn_sandbox_policy: JsonMap
  readonly read_timeout_ms: number
  readonly turn_timeout_ms: number
}

type CodexProcessRuntime = {
  readonly child: ChildProcessWithoutNullStreams
  readonly workspace_path: string
  readonly workspace_root: string
  readonly codex_app_server_pid: string | null
  readonly codex: ResolvedCodexRuntimeConfig
  readonly interaction_policy: CodexInteractionPolicy
  readonly dynamic_tools: ReadonlyArray<JsonMap>
  readonly on_event: ((event: CodexRuntimeEvent) => void) | undefined
  readonly tool_call_handler:
    | ((
        request: CodexToolCallRequest,
      ) => CodexToolCallResult | PromiseLike<CodexToolCallResult>)
    | undefined
  readonly diagnostics: Array<string>
  readonly queue: Array<ParsedProtocolMessage>
  readonly state_waiters: Set<() => void>
  stdout_buffer: string
  stderr_buffer: string
  exit_state: ProcessExitState | null
  spawn_error: Error | null
  closing: Promise<void> | null
  next_request_id: number
}

export type CodexAppServerSession = {
  readonly workspace_path: string
  readonly workspace_root: string
  readonly thread_id: string
  readonly codex_app_server_pid: string | null
  readonly interaction_policy: CodexInteractionPolicy
  readonly _runtime: CodexProcessRuntime
}

type TurnContext = {
  readonly thread_id: string
  readonly turn_id: string
  readonly session_id: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const readRecord = (value: unknown): Record<string, unknown> | null =>
  isRecord(value) ? value : null

const readString = (value: unknown): string | null =>
  typeof value === "string" ? value : null

const readNonBlankString = (value: unknown): string | null => {
  const string = readString(value)

  if (string === null) {
    return null
  }

  const trimmed = string.trim()
  return trimmed === "" ? null : trimmed
}

const readNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null

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

const codexError = (
  code:
    | "codex_not_found"
    | "invalid_workspace_cwd"
    | "response_timeout"
    | "turn_timeout"
    | "port_exit"
    | "response_error"
    | "turn_failed"
    | "turn_cancelled"
    | "turn_input_required",
  message: string,
  details?: Readonly<Record<string, unknown>>,
): RuntimeError => runtimeError(code, message, details)

const unexpectedCodexError = (
  cause: unknown,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): RuntimeError => {
  if (cause instanceof RuntimeError) {
    return cause
  }

  return runtimeError("unexpected_runtime_error", message, {
    ...details,
    cause: String(cause),
  })
}

const trimTrailingCarriageReturn = (line: string): string =>
  line.endsWith("\r") ? line.slice(0, -1) : line

const normalizeUsage = (value: unknown): CodexUsage | null => {
  const usage = readRecord(value)
  if (usage === null) {
    return null
  }

  const input_tokens =
    readNumber(usage.input_tokens) ??
    readNumber(usage.inputTokens) ??
    readNumber(usage.input)
  const output_tokens =
    readNumber(usage.output_tokens) ??
    readNumber(usage.outputTokens) ??
    readNumber(usage.output)
  const total_tokens =
    readNumber(usage.total_tokens) ??
    readNumber(usage.totalTokens) ??
    readNumber(usage.total)

  return input_tokens === null ||
    output_tokens === null ||
    total_tokens === null
    ? null
    : {
        input_tokens,
        output_tokens,
        total_tokens,
      }
}

const extractUsage = (payload: unknown): CodexUsage | null => {
  const record = readRecord(payload)
  if (record === null) {
    return null
  }

  const params = readRecord(record.params)
  const result = readRecord(record.result)

  const candidates = [
    record.usage,
    params?.usage,
    result?.usage,
    record.total_token_usage,
    params?.total_token_usage,
    result?.total_token_usage,
    record.totalTokenUsage,
    params?.totalTokenUsage,
    result?.totalTokenUsage,
    record.token_usage,
    params?.token_usage,
    result?.token_usage,
    record.tokenUsage,
    params?.tokenUsage,
    result?.tokenUsage,
  ]

  for (const candidate of candidates) {
    const usage = normalizeUsage(candidate)
    if (usage !== null) {
      return usage
    }
  }

  return null
}

const extractRateLimits = (payload: unknown): JsonMap | null => {
  const record = readRecord(payload)
  if (record === null) {
    return null
  }

  const params = readRecord(record.params)
  const result = readRecord(record.result)
  const candidates = [
    record.rate_limits,
    params?.rate_limits,
    result?.rate_limits,
    record.rateLimits,
    params?.rateLimits,
    result?.rateLimits,
  ]

  for (const candidate of candidates) {
    const rate_limits = readRecord(candidate)
    if (rate_limits !== null) {
      return rate_limits
    }
  }

  return null
}

const extractMethod = (payload: unknown): string | null => {
  const record = readRecord(payload)
  return record === null ? null : readNonBlankString(record.method)
}

const extractThreadId = (result: unknown): string | null => {
  const record = readRecord(result)
  const thread = readRecord(record?.thread)

  return readNonBlankString(thread?.id)
}

const extractTurnId = (result: unknown): string | null => {
  const record = readRecord(result)
  const turn = readRecord(record?.turn)

  return readNonBlankString(turn?.id)
}

const extractToolName = (params: unknown): string | null => {
  const record = readRecord(params)

  return readNonBlankString(record?.tool) ?? readNonBlankString(record?.name)
}

const extractToolArguments = (params: unknown): unknown => {
  const record = readRecord(params)

  return record?.arguments ?? {}
}

const requestPayloadRequiresInput = (payload: unknown): boolean => {
  const record = readRecord(payload)
  if (record === null) {
    return false
  }

  return (
    record.requiresInput === true ||
    record.needsInput === true ||
    record.input_required === true ||
    record.inputRequired === true ||
    record.type === "input_required" ||
    record.type === "needs_input"
  )
}

const isInputRequiredMessage = (payload: unknown): boolean => {
  const method = extractMethod(payload)
  const record = readRecord(payload)
  const params = readRecord(record?.params)

  return (
    method === "item/tool/requestUserInput" ||
    method === "turn/input_required" ||
    method === "turn/needs_input" ||
    method === "turn/need_input" ||
    method === "turn/request_input" ||
    method === "turn/request_response" ||
    method === "turn/provide_input" ||
    method === "turn/approval_required" ||
    requestPayloadRequiresInput(record) ||
    requestPayloadRequiresInput(params)
  )
}

const responseErrorFromPayload = (
  requestId: number,
  payload: Readonly<Record<string, unknown>>,
): RuntimeError =>
  codexError("response_error", "codex app-server returned an error response", {
    request_id: requestId,
    payload,
  })

const emitRuntimeEvent = (
  target:
    | CodexProcessRuntime
    | {
        readonly on_event: ((event: CodexRuntimeEvent) => void) | undefined
        readonly codex_app_server_pid: string | null
      },
  event: Omit<CodexRuntimeEvent, "timestamp" | "codex_app_server_pid">,
): void => {
  target.on_event?.({
    ...event,
    timestamp: new Date().toISOString(),
    codex_app_server_pid: target.codex_app_server_pid,
  })
}

const emitProtocolEvent = (
  runtime: CodexProcessRuntime,
  event: CodexRuntimeEventName,
  payload: unknown,
  context: TurnContext | null,
  raw?: string,
  message?: string,
  error_code?: string,
): void => {
  const method = extractMethod(payload) ?? undefined
  const usage = extractUsage(payload) ?? undefined
  const rate_limits = extractRateLimits(payload) ?? undefined

  emitRuntimeEvent(runtime, {
    event,
    ...(context === null
      ? {}
      : {
          thread_id: context.thread_id,
          turn_id: context.turn_id,
          session_id: context.session_id,
        }),
    ...(method === undefined ? {} : { method }),
    ...(message === undefined ? {} : { message }),
    ...(error_code === undefined ? {} : { error_code }),
    ...(payload === undefined ? {} : { payload }),
    ...(raw === undefined ? {} : { raw }),
    ...(usage === undefined ? {} : { usage }),
    ...(rate_limits === undefined ? {} : { rate_limits }),
  })
}

const notifyStateWaiters = (runtime: CodexProcessRuntime): void => {
  for (const waiter of runtime.state_waiters) {
    waiter()
  }

  runtime.state_waiters.clear()
}

const appendDiagnostic = (runtime: CodexProcessRuntime, line: string): void => {
  runtime.diagnostics.push(line)

  while (runtime.diagnostics.length > MAX_DIAGNOSTIC_LINES) {
    runtime.diagnostics.shift()
  }
}

const flushDiagnosticLine = (
  runtime: CodexProcessRuntime,
  stream: "stdout" | "stderr",
  line: string,
): void => {
  const trimmed = line.trim()
  if (trimmed === "") {
    return
  }

  appendDiagnostic(runtime, `${stream}: ${trimmed}`)
  const logger = /\b(error|warn|warning|failed|fatal|panic|exception)\b/i.test(
    trimmed,
  )
    ? logWarning
    : logInfo

  Effect.runFork(
    logger("codex app-server diagnostic", {
      stream,
      workspace_path: runtime.workspace_path,
      codex_app_server_pid: runtime.child.pid?.toString() ?? null,
      message: trimmed,
    }),
  )
}

const enqueueMessage = (
  runtime: CodexProcessRuntime,
  message: ParsedProtocolMessage,
): void => {
  runtime.queue.push(message)
  notifyStateWaiters(runtime)
}

const processStdoutLine = (
  runtime: CodexProcessRuntime,
  line: string,
): void => {
  const raw = trimTrailingCarriageReturn(line)

  if (raw === "") {
    return
  }

  try {
    enqueueMessage(runtime, {
      _tag: "json",
      raw,
      payload: JSON.parse(raw),
    })
  } catch {
    enqueueMessage(runtime, {
      _tag: "malformed",
      raw,
      message: "failed to parse codex protocol message",
    })
  }
}

const processStdoutChunk = (
  runtime: CodexProcessRuntime,
  chunk: string,
): void => {
  runtime.stdout_buffer += chunk

  while (true) {
    const newlineIndex = runtime.stdout_buffer.indexOf("\n")
    if (newlineIndex === -1) {
      break
    }

    const line = runtime.stdout_buffer.slice(0, newlineIndex)
    runtime.stdout_buffer = runtime.stdout_buffer.slice(newlineIndex + 1)
    processStdoutLine(runtime, line)
  }

  if (Buffer.byteLength(runtime.stdout_buffer) > MAX_PROTOCOL_LINE_BYTES) {
    enqueueMessage(runtime, {
      _tag: "malformed",
      raw: runtime.stdout_buffer,
      message: "codex protocol line exceeded maximum size",
    })
    runtime.stdout_buffer = ""
  }
}

const processStderrChunk = (
  runtime: CodexProcessRuntime,
  chunk: string,
): void => {
  runtime.stderr_buffer += chunk

  while (true) {
    const newlineIndex = runtime.stderr_buffer.indexOf("\n")
    if (newlineIndex === -1) {
      break
    }

    const line = runtime.stderr_buffer.slice(0, newlineIndex)
    runtime.stderr_buffer = runtime.stderr_buffer.slice(newlineIndex + 1)
    flushDiagnosticLine(runtime, "stderr", trimTrailingCarriageReturn(line))
  }
}

const waitForStateChange = (
  runtime: CodexProcessRuntime,
  timeoutMs: number,
): Promise<void> =>
  new Promise((resolve, reject) => {
    if (
      runtime.queue.length > 0 ||
      runtime.exit_state !== null ||
      runtime.spawn_error !== null
    ) {
      resolve()
      return
    }

    const timer = setTimeout(() => {
      runtime.state_waiters.delete(onStateChange)
      reject(new Error("timeout"))
    }, timeoutMs)

    const onStateChange = (): void => {
      clearTimeout(timer)
      runtime.state_waiters.delete(onStateChange)
      resolve()
    }

    runtime.state_waiters.add(onStateChange)
  })

const exitError = (
  runtime: CodexProcessRuntime,
  during: "startup" | "turn",
): RuntimeError => {
  if (runtime.spawn_error?.name === "ENOENT") {
    return codexError("codex_not_found", "failed to launch codex app-server", {
      command: runtime.codex.command,
      workspace_path: runtime.workspace_path,
      cause: runtime.spawn_error.message,
    })
  }

  if (during === "startup" && runtime.exit_state?.code === 127) {
    return codexError(
      "codex_not_found",
      "codex app-server command was not found",
      {
        command: runtime.codex.command,
        workspace_path: runtime.workspace_path,
        exit_code: runtime.exit_state.code,
        diagnostics: [...runtime.diagnostics],
      },
    )
  }

  return codexError("port_exit", "codex app-server exited unexpectedly", {
    command: runtime.codex.command,
    workspace_path: runtime.workspace_path,
    exit_code: runtime.exit_state?.code ?? null,
    signal: runtime.exit_state?.signal ?? null,
    diagnostics: [...runtime.diagnostics],
    phase: during,
  })
}

const writeProtocolMessage = (
  runtime: CodexProcessRuntime,
  payload: Readonly<Record<string, unknown>>,
): Promise<void> =>
  new Promise((resolve, reject) => {
    runtime.child.stdin.write(`${JSON.stringify(payload)}\n`, (cause) => {
      if (cause === null || cause === undefined) {
        resolve()
        return
      }

      reject(cause)
    })
  })

const takeQueuedResponse = (
  runtime: CodexProcessRuntime,
  requestId: number,
  context: TurnContext | null,
):
  | {
      readonly _tag: "response"
      readonly payload: Readonly<Record<string, unknown>>
    }
  | {
      readonly _tag: "none"
    } => {
  while (runtime.queue.length > 0) {
    const message = runtime.queue.shift()
    if (message === undefined) {
      break
    }

    if (message._tag === "malformed") {
      emitProtocolEvent(
        runtime,
        "malformed",
        undefined,
        context,
        message.raw,
        message.message,
      )
      continue
    }

    const payload = readRecord(message.payload)
    if (payload !== null && payload.id === requestId) {
      return {
        _tag: "response",
        payload,
      }
    }

    const method = extractMethod(message.payload)
    if (method !== null) {
      emitProtocolEvent(
        runtime,
        "notification",
        message.payload,
        context,
        message.raw,
      )
    } else {
      emitProtocolEvent(
        runtime,
        "other_message",
        message.payload,
        context,
        message.raw,
      )
    }
  }

  return { _tag: "none" }
}

const awaitResponse = async (
  runtime: CodexProcessRuntime,
  requestId: number,
  context: TurnContext | null,
): Promise<unknown> => {
  const deadline = Date.now() + runtime.codex.read_timeout_ms

  while (true) {
    const queued = takeQueuedResponse(runtime, requestId, context)
    if (queued._tag === "response") {
      if (queued.payload.error !== undefined) {
        throw responseErrorFromPayload(requestId, queued.payload)
      }

      if (!("result" in queued.payload)) {
        throw responseErrorFromPayload(requestId, queued.payload)
      }

      return queued.payload.result
    }

    if (runtime.spawn_error !== null || runtime.exit_state !== null) {
      throw exitError(runtime, "startup")
    }

    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) {
      throw codexError(
        "response_timeout",
        "timed out waiting for codex app-server response",
        {
          request_id: requestId,
          timeout_ms: runtime.codex.read_timeout_ms,
        },
      )
    }

    try {
      await waitForStateChange(runtime, remainingMs)
    } catch {
      throw codexError(
        "response_timeout",
        "timed out waiting for codex app-server response",
        {
          request_id: requestId,
          timeout_ms: runtime.codex.read_timeout_ms,
        },
      )
    }
  }
}

const approvalDecisionForMethod = (method: string): string | null => {
  switch (method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval": {
      return "acceptForSession"
    }
    case "execCommandApproval":
    case "applyPatchApproval": {
      return "approved_for_session"
    }
    default: {
      return null
    }
  }
}

const sendApprovalResponse = async (
  runtime: CodexProcessRuntime,
  payload: Readonly<Record<string, unknown>>,
  method: string,
  context: TurnContext,
  raw: string,
): Promise<void> => {
  const decision = approvalDecisionForMethod(method)
  const id = payload.id

  if (decision === null || (typeof id !== "number" && typeof id !== "string")) {
    return
  }

  await writeProtocolMessage(runtime, {
    id,
    result: {
      decision,
    },
  })

  emitProtocolEvent(
    runtime,
    "approval_auto_approved",
    payload,
    context,
    raw,
    `auto-approved ${method}`,
  )
}

const unsupportedToolCallResult = (): CodexToolCallResult => ({
  success: false,
  error: "unsupported_tool_call",
})

const sendToolCallResult = async (
  runtime: CodexProcessRuntime,
  payload: Readonly<Record<string, unknown>>,
  context: TurnContext,
  raw: string,
): Promise<void> => {
  const id = payload.id
  const params = readRecord(payload.params) ?? {}
  const request: CodexToolCallRequest = {
    tool_name: extractToolName(params),
    arguments: extractToolArguments(params),
    payload: params,
  }

  const result =
    runtime.tool_call_handler === undefined
      ? unsupportedToolCallResult()
      : await runtime.tool_call_handler(request)

  if (typeof id === "number" || typeof id === "string") {
    await writeProtocolMessage(runtime, {
      id,
      result,
    })
  }

  if (result.error === "unsupported_tool_call") {
    emitProtocolEvent(
      runtime,
      "unsupported_tool_call",
      payload,
      context,
      raw,
      request.tool_name === null
        ? "unsupported codex tool call"
        : `unsupported codex tool call: ${request.tool_name}`,
    )
    return
  }

  emitProtocolEvent(runtime, "notification", payload, context, raw)
}

const handleTurnProtocolMessage = async (
  runtime: CodexProcessRuntime,
  message: ParsedProtocolMessage,
  context: TurnContext,
): Promise<"continue" | "completed"> => {
  if (message._tag === "malformed") {
    emitProtocolEvent(
      runtime,
      "malformed",
      undefined,
      context,
      message.raw,
      message.message,
    )
    return "continue"
  }

  const payload = readRecord(message.payload)
  const method = extractMethod(message.payload)

  if (payload !== null && method === "turn/completed") {
    emitProtocolEvent(
      runtime,
      "turn_completed",
      message.payload,
      context,
      message.raw,
    )
    return "completed"
  }

  if (payload !== null && method === "turn/failed") {
    emitProtocolEvent(
      runtime,
      "turn_failed",
      message.payload,
      context,
      message.raw,
    )
    throw codexError("turn_failed", "codex app-server reported turn failure", {
      payload,
    })
  }

  if (payload !== null && method === "turn/cancelled") {
    emitProtocolEvent(
      runtime,
      "turn_cancelled",
      message.payload,
      context,
      message.raw,
    )
    throw codexError(
      "turn_cancelled",
      "codex app-server reported turn cancellation",
      {
        payload,
      },
    )
  }

  if (payload !== null && method !== null) {
    const approvalDecision = approvalDecisionForMethod(method)
    if (approvalDecision !== null) {
      await sendApprovalResponse(runtime, payload, method, context, message.raw)
      return "continue"
    }

    if (method === "item/tool/call") {
      await sendToolCallResult(runtime, payload, context, message.raw)
      return "continue"
    }

    if (isInputRequiredMessage(payload)) {
      emitProtocolEvent(
        runtime,
        "turn_input_required",
        message.payload,
        context,
        message.raw,
      )
      throw codexError(
        "turn_input_required",
        "codex app-server requested user input during a non-interactive turn",
        {
          payload,
        },
      )
    }

    emitProtocolEvent(
      runtime,
      "notification",
      message.payload,
      context,
      message.raw,
    )
    return "continue"
  }

  emitProtocolEvent(
    runtime,
    "other_message",
    message.payload,
    context,
    message.raw,
  )
  return "continue"
}

const awaitTurnCompletion = async (
  runtime: CodexProcessRuntime,
  context: TurnContext,
): Promise<void> => {
  const deadline = Date.now() + runtime.codex.turn_timeout_ms

  while (true) {
    while (runtime.queue.length > 0) {
      const message = runtime.queue.shift()
      if (message === undefined) {
        break
      }

      const outcome = await handleTurnProtocolMessage(runtime, message, context)
      if (outcome === "completed") {
        return
      }
    }

    if (runtime.spawn_error !== null || runtime.exit_state !== null) {
      throw exitError(runtime, "turn")
    }

    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) {
      throw codexError("turn_timeout", "codex turn timed out", {
        session_id: context.session_id,
        timeout_ms: runtime.codex.turn_timeout_ms,
      })
    }

    try {
      await waitForStateChange(runtime, remainingMs)
    } catch {
      throw codexError("turn_timeout", "codex turn timed out", {
        session_id: context.session_id,
        timeout_ms: runtime.codex.turn_timeout_ms,
      })
    }
  }
}

const resolveCodexRuntimeConfig = (
  codex: CodexConfig,
  workspacePath: string,
): ResolvedCodexRuntimeConfig => ({
  command: codex.command,
  approval_policy: codex.approval_policy ?? DEFAULT_CODEX_APPROVAL_POLICY,
  thread_sandbox: codex.thread_sandbox ?? DEFAULT_CODEX_THREAD_SANDBOX,
  turn_sandbox_policy:
    codex.turn_sandbox_policy ??
    makeDefaultCodexTurnSandboxPolicy(workspacePath),
  read_timeout_ms: codex.read_timeout_ms,
  turn_timeout_ms: codex.turn_timeout_ms,
})

const validateWorkspaceCwd = async (
  workspacePath: string,
  options: Pick<StartCodexAppServerSessionOptions, "workspace_root" | "cwd">,
): Promise<string> => {
  const cwdOptions = options.cwd === undefined ? {} : { cwd: options.cwd }
  const { workspace_path, workspace_root } = await Effect.runPromise(
    assertWorkspacePathWithinRoot(
      workspacePath,
      options.workspace_root,
      cwdOptions,
    ),
  ).catch((cause) => {
    throw codexError(
      "invalid_workspace_cwd",
      "workspace path is outside the configured workspace root",
      cause instanceof RuntimeError
        ? {
            ...cause.details,
          }
        : {
            cause: String(cause),
          },
    )
  })

  let workspaceEntry
  try {
    workspaceEntry = await lstat(workspace_path)
  } catch (cause) {
    throw codexError("invalid_workspace_cwd", "workspace path does not exist", {
      workspace_path,
      workspace_root,
      cause: String(cause),
    })
  }

  if (!workspaceEntry.isDirectory() || workspaceEntry.isSymbolicLink()) {
    throw codexError(
      "invalid_workspace_cwd",
      "workspace path must be a real directory under the workspace root",
      {
        workspace_path,
        workspace_root,
      },
    )
  }

  const [realWorkspaceRoot, realWorkspacePath] = await Promise.all([
    realpath(workspace_root),
    realpath(workspace_path),
  ]).catch((cause) => {
    throw codexError(
      "invalid_workspace_cwd",
      "failed to resolve workspace path before launch",
      {
        workspace_path,
        workspace_root,
        cause: String(cause),
      },
    )
  })

  if (!isSubdirectory(realWorkspaceRoot, realWorkspacePath)) {
    throw codexError(
      "invalid_workspace_cwd",
      "workspace directory escapes the configured workspace root",
      {
        workspace_path,
        workspace_root,
        real_workspace_root: realWorkspaceRoot,
        real_workspace_path: realWorkspacePath,
      },
    )
  }

  return realWorkspacePath
}

const createCodexProcessRuntime = async (
  workspacePath: string,
  options: StartCodexAppServerSessionOptions,
): Promise<CodexProcessRuntime> => {
  const child = spawn("bash", ["-lc", options.codex.command], {
    cwd: workspacePath,
    stdio: ["pipe", "pipe", "pipe"],
  })
  const runtime: CodexProcessRuntime = {
    child,
    workspace_path: workspacePath,
    workspace_root: path.resolve(
      options.cwd ?? process.cwd(),
      options.workspace_root,
    ),
    codex_app_server_pid: child.pid?.toString() ?? null,
    codex: resolveCodexRuntimeConfig(options.codex, workspacePath),
    interaction_policy: DEFAULT_CODEX_INTERACTION_POLICY,
    dynamic_tools: options.dynamic_tools ?? [],
    on_event: options.on_event,
    tool_call_handler: options.tool_call_handler,
    diagnostics: [],
    queue: [],
    state_waiters: new Set(),
    stdout_buffer: "",
    stderr_buffer: "",
    exit_state: null,
    spawn_error: null,
    closing: null,
    next_request_id: FIRST_TURN_REQUEST_ID,
  }

  child.stdout.on("data", (chunk: Buffer | string) => {
    processStdoutChunk(runtime, chunk.toString())
  })
  child.stderr.on("data", (chunk: Buffer | string) => {
    processStderrChunk(runtime, chunk.toString())
  })
  child.once("error", (cause) => {
    runtime.spawn_error = cause
    notifyStateWaiters(runtime)
  })
  child.once("close", (code, signal) => {
    if (runtime.stderr_buffer.trim() !== "") {
      flushDiagnosticLine(
        runtime,
        "stderr",
        trimTrailingCarriageReturn(runtime.stderr_buffer),
      )
      runtime.stderr_buffer = ""
    }

    runtime.exit_state = { code, signal }
    notifyStateWaiters(runtime)
  })

  return runtime
}

const initializeSession = async (
  runtime: CodexProcessRuntime,
): Promise<string> => {
  await writeProtocolMessage(runtime, {
    id: INITIALIZE_REQUEST_ID,
    method: "initialize",
    params: {
      clientInfo: CLIENT_INFO,
      capabilities: {},
    },
  })
  await awaitResponse(runtime, INITIALIZE_REQUEST_ID, null)

  await writeProtocolMessage(runtime, {
    method: "initialized",
    params: {},
  })

  const threadStartParams: Record<string, unknown> = {
    approvalPolicy: runtime.codex.approval_policy,
    sandbox: runtime.codex.thread_sandbox,
    cwd: runtime.workspace_path,
  }

  if (runtime.dynamic_tools.length > 0) {
    threadStartParams.dynamicTools = runtime.dynamic_tools
  }

  await writeProtocolMessage(runtime, {
    id: THREAD_START_REQUEST_ID,
    method: "thread/start",
    params: threadStartParams,
  })

  const threadResult = await awaitResponse(
    runtime,
    THREAD_START_REQUEST_ID,
    null,
  )
  const thread_id = extractThreadId(threadResult)

  if (thread_id === null) {
    throw codexError(
      "response_error",
      "codex app-server returned an invalid thread/start response",
      {
        payload: threadResult,
      },
    )
  }

  return thread_id
}

const startTurn = async (
  session: CodexAppServerSession,
  options: RunCodexTurnOptions,
): Promise<CodexTurnResult> => {
  const runtime = session._runtime
  const request_id = runtime.next_request_id++

  await writeProtocolMessage(runtime, {
    id: request_id,
    method: "turn/start",
    params: {
      threadId: session.thread_id,
      input: [
        {
          type: "text",
          text: options.prompt,
        },
      ],
      cwd: session.workspace_path,
      title: `${options.issue.identifier}: ${options.issue.title}`,
      approvalPolicy: runtime.codex.approval_policy,
      sandboxPolicy: runtime.codex.turn_sandbox_policy,
    },
  })

  const turnResult = await awaitResponse(runtime, request_id, null)
  const turn_id = extractTurnId(turnResult)

  if (turn_id === null) {
    throw codexError(
      "response_error",
      "codex app-server returned an invalid turn/start response",
      {
        payload: turnResult,
      },
    )
  }

  return {
    thread_id: session.thread_id,
    turn_id,
    session_id: `${session.thread_id}-${turn_id}`,
  }
}

export const stopCodexAppServerSession = (
  session: CodexAppServerSession,
): Effect.Effect<void, RuntimeError> =>
  Effect.tryPromise({
    try: async () => {
      const runtime = session._runtime
      if (runtime.closing !== null) {
        await runtime.closing
        return
      }

      runtime.closing = (async () => {
        if (runtime.exit_state !== null) {
          return
        }

        runtime.child.stdin.end()
        runtime.child.kill("SIGTERM")

        try {
          await waitForStateChange(runtime, 250)
        } catch {
          runtime.child.kill("SIGKILL")
          try {
            await waitForStateChange(runtime, 250)
          } catch {
            return
          }
        }
      })()

      await runtime.closing
    },
    catch: (cause) =>
      unexpectedCodexError(cause, "failed to stop codex app-server session"),
  })

export const startCodexAppServerSession = (
  workspacePath: string,
  options: StartCodexAppServerSessionOptions,
): Effect.Effect<CodexAppServerSession, RuntimeError> =>
  Effect.tryPromise({
    try: async () => {
      let runtime: CodexProcessRuntime | null = null

      try {
        const resolvedWorkspacePath = await validateWorkspaceCwd(
          workspacePath,
          options,
        )
        runtime = await createCodexProcessRuntime(
          resolvedWorkspacePath,
          options,
        )
        const thread_id = await initializeSession(runtime)

        return {
          workspace_path: resolvedWorkspacePath,
          workspace_root: runtime.workspace_root,
          thread_id,
          codex_app_server_pid: runtime.codex_app_server_pid,
          interaction_policy: runtime.interaction_policy,
          _runtime: runtime,
        }
      } catch (cause) {
        const error = unexpectedCodexError(
          cause,
          "failed to start codex app-server session",
          {
            workspace_path: workspacePath,
          },
        )

        emitRuntimeEvent(
          runtime ?? {
            on_event: options.on_event,
            codex_app_server_pid: null,
          },
          {
            event: "startup_failed",
            message: error.message,
            error_code: error.code,
            payload: error.details,
          },
        )

        if (runtime !== null) {
          await Effect.runPromise(
            stopCodexAppServerSession({
              workspace_path: runtime.workspace_path,
              workspace_root: runtime.workspace_root,
              thread_id: "",
              codex_app_server_pid: runtime.codex_app_server_pid,
              interaction_policy: runtime.interaction_policy,
              _runtime: runtime,
            }),
          )
        }
        throw error
      }
    },
    catch: (cause) =>
      unexpectedCodexError(cause, "failed to start codex app-server session", {
        workspace_path: workspacePath,
      }),
  })

export const runCodexTurn = (
  session: CodexAppServerSession,
  options: RunCodexTurnOptions,
): Effect.Effect<CodexTurnResult, RuntimeError> =>
  Effect.tryPromise({
    try: async () => {
      let turnContext: TurnContext | null = null

      try {
        const turn = await startTurn(session, options)
        turnContext = turn

        emitRuntimeEvent(session._runtime, {
          event: "session_started",
          session_id: turn.session_id,
          thread_id: turn.thread_id,
          turn_id: turn.turn_id,
          message: `${options.issue.identifier}: ${options.issue.title}`,
        })

        await awaitTurnCompletion(session._runtime, turn)
        return turn
      } catch (cause) {
        const error = unexpectedCodexError(cause, "codex turn failed", {
          workspace_path: session.workspace_path,
          thread_id: session.thread_id,
        })

        if (turnContext === null) {
          emitRuntimeEvent(session._runtime, {
            event: "startup_failed",
            message: error.message,
            error_code: error.code,
            payload: error.details,
          })
        } else {
          emitRuntimeEvent(session._runtime, {
            event: "turn_ended_with_error",
            session_id: turnContext.session_id,
            thread_id: turnContext.thread_id,
            turn_id: turnContext.turn_id,
            message: error.message,
            error_code: error.code,
            payload: error.details,
          })
        }

        throw error
      }
    },
    catch: (cause) =>
      unexpectedCodexError(cause, "failed to run codex turn", {
        workspace_path: session.workspace_path,
        thread_id: session.thread_id,
      }),
  })
