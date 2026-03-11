import { describe, expect, it } from "bun:test"
import { Effect, Logger } from "effect"
import * as References from "effect/References"

import {
  annotateIssueLogs,
  annotateSessionLogs,
  logInfo,
} from "../src/observability/logging"

describe("logging", () => {
  it("adds issue and session annotations to structured logs", async () => {
    const annotations: Array<Record<string, unknown>> = []
    const logger = Logger.make<unknown, void>((options) => {
      annotations.push({
        ...options.fiber.getRef(References.CurrentLogAnnotations),
      })
    })

    await Effect.runPromise(
      logInfo("worker update").pipe(
        annotateIssueLogs({ id: "issue-1", identifier: "ABC-123" }),
        annotateSessionLogs({
          session_id: "thread-1-turn-1",
          thread_id: "thread-1",
          turn_id: "turn-1",
        }),
        Effect.provide(Logger.layer([logger])),
      ),
    )

    expect(annotations).toEqual([
      {
        issue_id: "issue-1",
        issue_identifier: "ABC-123",
        session_id: "thread-1-turn-1",
        thread_id: "thread-1",
        turn_id: "turn-1",
      },
    ])
  })
})
