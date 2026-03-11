import { Effect, Logger } from "effect"

import type { Issue, LiveSession } from "../domain/models"

export const loggingLayer = Logger.layer([Logger.consoleJson])

export const compactLogFields = (
  fields: Readonly<Record<string, unknown>>,
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  )

export const issueLogFields = (
  issue: Pick<Issue, "id" | "identifier">,
): Record<string, string> => ({
  issue_id: issue.id,
  issue_identifier: issue.identifier,
})

export const sessionLogFields = (
  session: Pick<LiveSession, "session_id" | "thread_id" | "turn_id">,
): Record<string, string> => ({
  session_id: session.session_id,
  thread_id: session.thread_id,
  turn_id: session.turn_id,
})

export const annotateIssueLogs =
  (issue: Pick<Issue, "id" | "identifier">) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.annotateLogs(effect, issueLogFields(issue))

export const annotateSessionLogs =
  (session: Pick<LiveSession, "session_id" | "thread_id" | "turn_id">) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.annotateLogs(effect, sessionLogFields(session))

export const logInfo = (
  message: string,
  fields: Readonly<Record<string, unknown>> = {},
): Effect.Effect<void> =>
  Effect.annotateLogs(Effect.logInfo(message), compactLogFields(fields))

export const logError = (
  message: string,
  fields: Readonly<Record<string, unknown>> = {},
): Effect.Effect<void> =>
  Effect.annotateLogs(Effect.logError(message), compactLogFields(fields))
