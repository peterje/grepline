import path from "node:path"

import { Effect } from "effect"

import {
  DEFAULT_WORKFLOW_FILE,
  type OrchestratorState,
  type ServiceShell,
  makeInitialOrchestratorState,
} from "../domain/models"
import { logInfo } from "../observability/logging"

export type BootstrapServiceShellOptions = {
  readonly cwd: string
  readonly workflow_path?: string
  readonly started_at?: string
  readonly orchestrator_state?: OrchestratorState
}

export const resolveWorkflowPath = (
  cwd: string,
  workflowPath?: string,
): string => {
  if (workflowPath === undefined) {
    return path.resolve(cwd, DEFAULT_WORKFLOW_FILE)
  }

  return path.isAbsolute(workflowPath)
    ? workflowPath
    : path.resolve(cwd, workflowPath)
}

export const bootstrapServiceShell = (
  options: BootstrapServiceShellOptions,
): Effect.Effect<ServiceShell> => {
  const workflow_path = resolveWorkflowPath(options.cwd, options.workflow_path)
  const started_at = options.started_at ?? new Date().toISOString()
  const orchestrator_state =
    options.orchestrator_state ?? makeInitialOrchestratorState()

  return logInfo("service shell started", {
    cwd: options.cwd,
    workflow_path,
    poll_interval_ms: orchestrator_state.poll_interval_ms,
    max_concurrent_agents: orchestrator_state.max_concurrent_agents,
  }).pipe(
    Effect.as({
      cwd: options.cwd,
      workflow_path,
      started_at,
      orchestrator_state,
    }),
  )
}
