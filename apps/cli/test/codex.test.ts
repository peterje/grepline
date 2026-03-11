import os from "node:os"
import path from "node:path"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"

import { describe, expect, it } from "bun:test"
import { Effect } from "effect"

import type { CodexConfig, Issue } from "../src/domain/models"
import {
  DEFAULT_CODEX_APPROVAL_POLICY,
  DEFAULT_CODEX_THREAD_SANDBOX,
  runCodexTurn,
  startCodexAppServerSession,
  stopCodexAppServerSession,
  type CodexRuntimeEvent,
} from "../src/index"

type FakeServerEmission =
  | {
      readonly type: "response"
      readonly result?: unknown
      readonly error?: unknown
      readonly chunk_sizes?: ReadonlyArray<number>
      readonly delay_ms?: number
    }
  | {
      readonly type: "event"
      readonly payload?: unknown
      readonly raw?: string
      readonly stream?: "stdout" | "stderr"
      readonly chunk_sizes?: ReadonlyArray<number>
      readonly delay_ms?: number
    }
  | {
      readonly type: "exit"
      readonly code: number
      readonly delay_ms?: number
    }

type FakeServerScenario = {
  readonly initialize?: ReadonlyArray<FakeServerEmission>
  readonly thread_start?: ReadonlyArray<FakeServerEmission>
  readonly turns?: ReadonlyArray<ReadonlyArray<FakeServerEmission>>
}

const sampleIssue: Pick<Issue, "identifier" | "title"> = {
  identifier: "ABC-123",
  title: "Ship codex app-server client",
}

const fakeServerScript = String.raw`
import fs from "node:fs"

const [scenarioPath, recordPath] = process.argv.slice(2)
const scenario = JSON.parse(fs.readFileSync(scenarioPath, "utf8"))
const received = []
let stdinBuffer = ""
let pending = Promise.resolve()
let turnIndex = 0

const persistRecord = () => {
  fs.writeFileSync(recordPath, JSON.stringify(received, null, 2))
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const splitText = (text, chunkSizes = []) => {
  if (!Array.isArray(chunkSizes) || chunkSizes.length === 0) {
    return [text]
  }

  const chunks = []
  let offset = 0

  for (const size of chunkSizes) {
    if (typeof size !== "number" || size <= 0 || offset >= text.length) {
      continue
    }

    chunks.push(text.slice(offset, offset + size))
    offset += size
  }

  if (offset < text.length) {
    chunks.push(text.slice(offset))
  }

  return chunks
}

const writeText = async (stream, text, chunkSizes) => {
  for (const chunk of splitText(text, chunkSizes)) {
    stream.write(chunk)
    await sleep(0)
  }
}

const emit = async (entry, request) => {
  if (!entry) {
    return
  }

  if (typeof entry.delay_ms === "number" && entry.delay_ms > 0) {
    await sleep(entry.delay_ms)
  }

  if (entry.type === "response") {
    const payload = {
      id: request.id,
      ...(entry.error !== undefined
        ? { error: entry.error }
        : { result: entry.result ?? {} }),
    }
    await writeText(process.stdout, JSON.stringify(payload) + "\n", entry.chunk_sizes)
    return
  }

  if (entry.type === "event") {
    const stream = entry.stream === "stderr" ? process.stderr : process.stdout
    const text = entry.payload !== undefined ? JSON.stringify(entry.payload) : String(entry.raw ?? "")
    await writeText(stream, text + "\n", entry.chunk_sizes)
    return
  }

  if (entry.type === "exit") {
    process.exit(entry.code)
  }
}

const emitAll = async (entries, request) => {
  for (const entry of entries ?? []) {
    await emit(entry, request)
  }
}

const handleMessage = async (message) => {
  received.push(message)
  persistRecord()

  switch (message.method) {
    case "initialize": {
      await emitAll(scenario.initialize, message)
      return
    }
    case "thread/start": {
      await emitAll(scenario.thread_start, message)
      return
    }
    case "turn/start": {
      const entries = Array.isArray(scenario.turns) ? scenario.turns[turnIndex] ?? [] : []
      turnIndex += 1
      await emitAll(entries, message)
      return
    }
    default: {
      return
    }
  }
}

const handleLine = async (line) => {
  if (line.trim() === "") {
    return
  }

  try {
    const message = JSON.parse(line)
    await handleMessage(message)
  } catch (error) {
    received.push({ malformed: true, raw: line, error: String(error) })
    persistRecord()
  }
}

process.on("exit", () => {
  persistRecord()
})
process.on("SIGTERM", () => {
  persistRecord()
  process.exit(0)
})
process.on("SIGINT", () => {
  persistRecord()
  process.exit(0)
})

process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  pending = pending
    .then(async () => {
      stdinBuffer += chunk

      while (true) {
        const newlineIndex = stdinBuffer.indexOf("\n")
        if (newlineIndex === -1) {
          break
        }

        const line = stdinBuffer.slice(0, newlineIndex)
        stdinBuffer = stdinBuffer.slice(newlineIndex + 1)
        await handleLine(line)
      }
    })
    .catch((error) => {
      received.push({ handlerError: String(error) })
      persistRecord()
    })
})
`

const makeCodexConfig = (
  command: string,
  overrides: Partial<CodexConfig> = {},
): CodexConfig => ({
  command,
  approval_policy: null,
  thread_sandbox: null,
  turn_sandbox_policy: null,
  turn_timeout_ms: 200,
  read_timeout_ms: 100,
  stall_timeout_ms: 60_000,
  ...overrides,
})

const commandForScript = (...parts: ReadonlyArray<string>): string =>
  parts.map((part) => JSON.stringify(part)).join(" ")

const createFakeServer = async (
  tempDirectory: string,
  scenario: FakeServerScenario,
): Promise<{
  readonly command: string
  readonly record_path: string
}> => {
  const serverPath = path.join(tempDirectory, "fake-codex-server.mjs")
  const scenarioPath = path.join(tempDirectory, "fake-codex-scenario.json")
  const record_path = path.join(tempDirectory, "fake-codex-record.json")

  await writeFile(serverPath, fakeServerScript, { encoding: "utf8" })
  await writeFile(scenarioPath, JSON.stringify(scenario, null, 2), {
    encoding: "utf8",
  })

  return {
    command: commandForScript(
      process.execPath,
      serverPath,
      scenarioPath,
      record_path,
    ),
    record_path,
  }
}

const readRecordedMessages = async (
  recordPath: string,
): Promise<Array<Record<string, unknown>>> =>
  JSON.parse(await readFile(recordPath, "utf8")) as Array<
    Record<string, unknown>
  >

const makeWorkspace = async (): Promise<{
  readonly cwd: string
  readonly workspace_root: string
  readonly workspace_path: string
}> => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "grepline-codex-"))
  const workspace_root = path.join(cwd, "workspaces")
  const workspace_path = path.join(workspace_root, "ABC-123")

  await mkdir(workspace_path, { recursive: true })

  return {
    cwd,
    workspace_root,
    workspace_path,
  }
}

describe("codex app-server client", () => {
  it("launches the app-server, preserves message ordering, and streams buffered lines", async () => {
    const { cwd, workspace_root, workspace_path } = await makeWorkspace()
    const fakeServer = await createFakeServer(cwd, {
      initialize: [
        {
          type: "response",
          result: {
            capabilities: {},
          },
        },
      ],
      thread_start: [
        {
          type: "response",
          result: {
            thread: {
              id: "thread-123",
            },
          },
        },
      ],
      turns: [
        [
          {
            type: "response",
            result: {
              turn: {
                id: "turn-1",
              },
            },
            chunk_sizes: [8, 6, 4],
          },
          {
            type: "event",
            raw: "not json",
            chunk_sizes: [3, 4],
          },
          {
            type: "event",
            stream: "stderr",
            raw: "diagnostic only",
          },
          {
            type: "event",
            payload: {
              method: "thread/tokenUsage/updated",
              params: {
                total_token_usage: {
                  input_tokens: 11,
                  output_tokens: 7,
                  total_tokens: 18,
                },
                rate_limits: {
                  remaining_tokens: 99,
                },
              },
            },
          },
          {
            type: "event",
            payload: {
              method: "turn/completed",
              params: {
                usage: {
                  input_tokens: 11,
                  output_tokens: 7,
                  total_tokens: 18,
                },
              },
            },
            chunk_sizes: [5, 7, 9],
          },
        ],
      ],
    })
    const events: Array<CodexRuntimeEvent> = []
    let resolvedWorkspacePath = workspace_path

    try {
      const session = await Effect.runPromise(
        startCodexAppServerSession(workspace_path, {
          cwd,
          workspace_root,
          codex: makeCodexConfig(fakeServer.command),
          on_event: (event) => {
            events.push(event)
          },
        }),
      )

      try {
        resolvedWorkspacePath = session.workspace_path
        const turn = await Effect.runPromise(
          runCodexTurn(session, {
            prompt: "Implement the missing codex client.",
            issue: sampleIssue,
          }),
        )

        expect(turn).toEqual({
          session_id: "thread-123-turn-1",
          thread_id: "thread-123",
          turn_id: "turn-1",
        })
      } finally {
        await Effect.runPromise(stopCodexAppServerSession(session))
      }

      const recordedMessages = await readRecordedMessages(
        fakeServer.record_path,
      )
      expect(recordedMessages.map((message) => message.method)).toEqual([
        "initialize",
        "initialized",
        "thread/start",
        "turn/start",
      ])
      expect(recordedMessages[2]?.params).toMatchObject({
        cwd: resolvedWorkspacePath,
        sandbox: DEFAULT_CODEX_THREAD_SANDBOX,
        approvalPolicy: DEFAULT_CODEX_APPROVAL_POLICY,
      })
      expect(recordedMessages[3]?.params).toMatchObject({
        cwd: resolvedWorkspacePath,
        title: "ABC-123: Ship codex app-server client",
        approvalPolicy: DEFAULT_CODEX_APPROVAL_POLICY,
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: [resolvedWorkspacePath],
        },
      })

      expect(events.map((event) => event.event)).toEqual([
        "session_started",
        "malformed",
        "notification",
        "turn_completed",
      ])
      expect(events[0]).toMatchObject({
        event: "session_started",
        session_id: "thread-123-turn-1",
        thread_id: "thread-123",
        turn_id: "turn-1",
      })
      expect(events[1]).toMatchObject({
        event: "malformed",
        raw: "not json",
      })
      expect(events[2]).toMatchObject({
        event: "notification",
        method: "thread/tokenUsage/updated",
        usage: {
          input_tokens: 11,
          output_tokens: 7,
          total_tokens: 18,
        },
        rate_limits: {
          remaining_tokens: 99,
        },
      })
      expect(events[3]).toMatchObject({
        event: "turn_completed",
        usage: {
          input_tokens: 11,
          output_tokens: 7,
          total_tokens: 18,
        },
      })
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it("rejects invalid workspace cwd values before launch", async () => {
    const { cwd, workspace_root } = await makeWorkspace()
    const events: Array<CodexRuntimeEvent> = []

    try {
      const error = await Effect.runPromise(
        Effect.flip(
          startCodexAppServerSession(workspace_root, {
            cwd,
            workspace_root,
            codex: makeCodexConfig("exit 0"),
            on_event: (event) => {
              events.push(event)
            },
          }),
        ),
      )

      expect(error.code).toEqual("invalid_workspace_cwd")
      expect(events).toMatchObject([
        {
          event: "startup_failed",
          error_code: "invalid_workspace_cwd",
        },
      ])
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it("maps startup read timeouts into response_timeout errors", async () => {
    const { cwd, workspace_root, workspace_path } = await makeWorkspace()
    const fakeServer = await createFakeServer(cwd, {
      initialize: [],
    })
    const events: Array<CodexRuntimeEvent> = []

    try {
      const error = await Effect.runPromise(
        Effect.flip(
          startCodexAppServerSession(workspace_path, {
            cwd,
            workspace_root,
            codex: makeCodexConfig(fakeServer.command, {
              read_timeout_ms: 40,
            }),
            on_event: (event) => {
              events.push(event)
            },
          }),
        ),
      )

      expect(error.code).toEqual("response_timeout")
      expect(events).toMatchObject([
        {
          event: "startup_failed",
          error_code: "response_timeout",
        },
      ])
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it("auto-approves approvals, rejects unsupported tools, and hard-fails on input requests", async () => {
    const { cwd, workspace_root, workspace_path } = await makeWorkspace()
    const fakeServer = await createFakeServer(cwd, {
      initialize: [
        {
          type: "response",
          result: {
            capabilities: {},
          },
        },
      ],
      thread_start: [
        {
          type: "response",
          result: {
            thread: {
              id: "thread-approval",
            },
          },
        },
      ],
      turns: [
        [
          {
            type: "response",
            result: {
              turn: {
                id: "turn-approval",
              },
            },
          },
          {
            type: "event",
            payload: {
              id: "approval-1",
              method: "item/commandExecution/requestApproval",
            },
          },
          {
            type: "event",
            payload: {
              id: "tool-1",
              method: "item/tool/call",
              params: {
                tool: "linear_graphql",
                arguments: {
                  query: "query Example { viewer { id } }",
                },
              },
            },
          },
          {
            type: "event",
            payload: {
              id: "input-1",
              method: "item/tool/requestUserInput",
              params: {
                prompt: "Which branch should I use?",
              },
            },
            delay_ms: 20,
          },
        ],
      ],
    })
    const events: Array<CodexRuntimeEvent> = []

    try {
      const session = await Effect.runPromise(
        startCodexAppServerSession(workspace_path, {
          cwd,
          workspace_root,
          codex: makeCodexConfig(fakeServer.command),
          on_event: (event) => {
            events.push(event)
          },
        }),
      )

      try {
        const error = await Effect.runPromise(
          Effect.flip(
            runCodexTurn(session, {
              prompt: "Continue the existing implementation.",
              issue: sampleIssue,
            }),
          ),
        )

        expect(error.code).toEqual("turn_input_required")
      } finally {
        await Bun.sleep(30)
        await Effect.runPromise(stopCodexAppServerSession(session))
      }

      const recordedMessages = await readRecordedMessages(
        fakeServer.record_path,
      )
      expect(recordedMessages[0]?.method).toEqual("initialize")
      expect(recordedMessages[1]?.method).toEqual("initialized")
      expect(recordedMessages[2]?.method).toEqual("thread/start")
      expect(recordedMessages[3]?.method).toEqual("turn/start")
      expect(recordedMessages[4]).toMatchObject({
        id: "approval-1",
        result: {
          decision: "acceptForSession",
        },
      })
      expect(recordedMessages[5]).toMatchObject({
        id: "tool-1",
        result: {
          success: false,
          error: "unsupported_tool_call",
        },
      })
      expect(events.map((event) => event.event)).toEqual([
        "session_started",
        "approval_auto_approved",
        "unsupported_tool_call",
        "turn_input_required",
        "turn_ended_with_error",
      ])
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  for (const testCase of [
    {
      name: "turn_failed",
      turns: [
        [
          {
            type: "response" as const,
            result: {
              turn: {
                id: "turn-failed",
              },
            },
          },
          {
            type: "event" as const,
            payload: {
              method: "turn/failed",
              params: {
                code: "model_error",
              },
            },
          },
        ],
      ],
      expected_event: "turn_failed",
    },
    {
      name: "turn_cancelled",
      turns: [
        [
          {
            type: "response" as const,
            result: {
              turn: {
                id: "turn-cancelled",
              },
            },
          },
          {
            type: "event" as const,
            payload: {
              method: "turn/cancelled",
              params: {
                reason: "cancelled",
              },
            },
          },
        ],
      ],
      expected_event: "turn_cancelled",
    },
    {
      name: "turn_timeout",
      turns: [
        [
          {
            type: "response" as const,
            result: {
              turn: {
                id: "turn-timeout",
              },
            },
          },
        ],
      ],
      expected_event: "turn_ended_with_error",
      turn_timeout_ms: 40,
      expected_error_code: "turn_timeout",
    },
    {
      name: "port_exit",
      turns: [
        [
          {
            type: "response" as const,
            result: {
              turn: {
                id: "turn-port-exit",
              },
            },
          },
          {
            type: "exit" as const,
            code: 17,
          },
        ],
      ],
      expected_event: "turn_ended_with_error",
    },
  ]) {
    it(`maps ${testCase.name} into normalized errors`, async () => {
      const { cwd, workspace_root, workspace_path } = await makeWorkspace()
      const fakeServer = await createFakeServer(cwd, {
        initialize: [
          {
            type: "response",
            result: {
              capabilities: {},
            },
          },
        ],
        thread_start: [
          {
            type: "response",
            result: {
              thread: {
                id: `thread-${testCase.name}`,
              },
            },
          },
        ],
        turns: testCase.turns,
      })
      const events: Array<CodexRuntimeEvent> = []

      try {
        const session = await Effect.runPromise(
          startCodexAppServerSession(workspace_path, {
            cwd,
            workspace_root,
            codex: makeCodexConfig(fakeServer.command, {
              turn_timeout_ms: testCase.turn_timeout_ms ?? 200,
            }),
            on_event: (event) => {
              events.push(event)
            },
          }),
        )

        try {
          const error = await Effect.runPromise(
            Effect.flip(
              runCodexTurn(session, {
                prompt: "Handle this turn outcome.",
                issue: sampleIssue,
              }),
            ),
          )

          expect(String(error.code)).toEqual(
            testCase.expected_error_code ?? testCase.name,
          )
        } finally {
          await Effect.runPromise(stopCodexAppServerSession(session))
        }

        expect(
          events.some((event) => event.event === testCase.expected_event),
        ).toEqual(true)
      } finally {
        await rm(cwd, { recursive: true, force: true })
      }
    })
  }
})
