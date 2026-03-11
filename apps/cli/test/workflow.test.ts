import os from "node:os"
import path from "node:path"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"

import { describe, expect, it } from "bun:test"
import { Effect, Logger } from "effect"

import { runCli } from "../src/cli"
import type { Issue } from "../src/domain/models"
import { renderPromptTemplate } from "../src/service/prompt"
import {
  loadWorkflowDefinition,
  parseWorkflowDefinition,
  resolveWorkflowConfig,
  validateWorkflowStartupConfig,
} from "../src/service/workflow"

const silentLogger = Logger.layer([Logger.make(() => undefined)])

const sampleIssue: Issue = {
  id: "issue-1",
  identifier: "ABC-123",
  title: "Ship workflow parsing",
  description: "Implement workflow parsing and prompting.",
  priority: 2,
  state: "Todo",
  branch_name: null,
  url: "https://linear.app/example/issue/ABC-123",
  labels: ["backend", "urgent"],
  blocked_by: [],
  created_at: "2026-03-10T00:00:00.000Z",
  updated_at: "2026-03-10T01:00:00.000Z",
}

describe("workflow config and prompting", () => {
  it("surfaces missing workflow files", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        loadWorkflowDefinition({
          cwd: "/tmp/grepline",
          workflow_path: "./missing/WORKFLOW.md",
        }),
      ),
    )

    expect(error.code).toEqual("missing_workflow_file")
  })

  it("surfaces yaml parse failures", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        parseWorkflowDefinition(["---", "tracker: [", "---"].join("\n")),
      ),
    )

    expect(error.code).toEqual("workflow_parse_error")
  })

  it("rejects non-object front matter", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        parseWorkflowDefinition(
          ["---", "- linear", "---", "prompt"].join("\n"),
        ),
      ),
    )

    expect(error.code).toEqual("workflow_front_matter_not_a_map")
  })

  it("applies defaults and resolves env-backed config values", () => {
    const config = resolveWorkflowConfig(
      {
        tracker: {
          kind: "linear",
          api_key: "$LINEAR_TOKEN",
          project_slug: "demo",
        },
        workspace: {
          root: "$WORKSPACE_ROOT",
        },
        hooks: {
          timeout_ms: 0,
        },
        agent: {
          max_concurrent_agents_by_state: {
            "In Progress": 2,
            Todo: "0",
          },
        },
      },
      {
        cwd: "/repo/project",
        env: {
          LINEAR_TOKEN: "linear-token",
          WORKSPACE_ROOT: "~/grepline/workspaces",
        },
        home_directory: "/Users/tester",
        temp_directory: "/tmp/runtime",
      },
    )

    expect(config.tracker.endpoint).toEqual("https://api.linear.app/graphql")
    expect(config.tracker.api_key).toEqual("linear-token")
    expect(config.workspace.root).toEqual("/Users/tester/grepline/workspaces")
    expect(config.hooks.timeout_ms).toEqual(60_000)
    expect(config.agent.max_turns).toEqual(20)
    expect(config.agent.max_concurrent_agents_by_state).toEqual({
      "in progress": 2,
    })
  })

  it("validates startup-critical workflow settings", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        validateWorkflowStartupConfig(
          resolveWorkflowConfig({
            tracker: {
              kind: "github",
            },
            codex: {
              command: "   ",
            },
          }),
        ),
      ),
    )

    expect(error.code).toEqual("startup_validation_failed")
    expect(error.details?.errors).toEqual([
      "tracker.kind 'github' is not supported",
      "codex.command must not be empty",
    ])
  })

  it("requires linear auth and project slug for dispatch", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        validateWorkflowStartupConfig(
          resolveWorkflowConfig({
            tracker: {
              kind: "linear",
            },
          }),
        ),
      ),
    )

    expect(error.details?.errors).toEqual([
      "tracker.api_key is required for linear",
      "tracker.project_slug is required for linear",
    ])
  })

  it("renders prompts strictly for issue and attempt", () => {
    const rendered = renderPromptTemplate(
      [
        "Issue {{ issue.identifier }}: {{ issue.title | upcase }}",
        'Attempt {{ attempt | default: "first" }}',
        "{% if issue.description %}{{ issue.description | strip }}{% endif %}",
      ].join("\n"),
      {
        issue: sampleIssue,
        attempt: null,
      },
    )

    expect(rendered).toContain("Issue ABC-123: SHIP WORKFLOW PARSING")
    expect(rendered).toContain("Attempt first")
    expect(rendered).toContain("Implement workflow parsing and prompting.")
  })

  it("fails on unknown variables and unknown filters", () => {
    let variableError: unknown
    let filterError: unknown

    try {
      renderPromptTemplate("{{ issue.missing_field }}", {
        issue: sampleIssue,
        attempt: null,
      })
    } catch (error) {
      variableError = error
    }

    try {
      renderPromptTemplate("{{ issue.identifier | mystery }}", {
        issue: sampleIssue,
        attempt: null,
      })
    } catch (error) {
      filterError = error
    }

    expect(variableError).toMatchObject({
      code: "template_render_error",
    })
    expect(filterError).toMatchObject({
      code: "template_render_error",
    })
  })

  it("falls back to the minimal default prompt when the body is empty", () => {
    expect(
      renderPromptTemplate("   ", {
        issue: sampleIssue,
        attempt: null,
      }),
    ).toEqual("You are working on an issue from Linear.")
  })

  it("loads workflow files from disk with trimmed prompt bodies", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "grepline-workflow-"))

    try {
      const workflowPath = path.join(cwd, "WORKFLOW.md")

      await mkdir(path.dirname(workflowPath), { recursive: true })
      await writeFile(
        workflowPath,
        [
          "---",
          "tracker:",
          "  kind: linear",
          "  api_key: token",
          "  project_slug: demo",
          "---",
          "",
          "  hello {{ issue.identifier }}  ",
          "",
        ].join("\n"),
        { encoding: "utf8" },
      )

      const loaded = await Effect.runPromise(loadWorkflowDefinition({ cwd }))

      expect(loaded.workflow.prompt_template).toEqual(
        "hello {{ issue.identifier }}",
      )
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it("smoke tests a real workflow file from boot through prompt rendering", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "grepline-smoke-"))
    const previousApiKey = process.env.LINEAR_API_KEY

    try {
      process.env.LINEAR_API_KEY = "smoke-linear-token"

      const workflowPath = path.join(cwd, "WORKFLOW.md")
      await mkdir(path.dirname(workflowPath), { recursive: true })
      await writeFile(
        workflowPath,
        [
          "---",
          "tracker:",
          "  kind: linear",
          "  api_key: $LINEAR_API_KEY",
          "  project_slug: smoke-demo",
          "polling:",
          "  interval_ms: 7000",
          "workspace:",
          "  root: ./tmp/workspaces",
          "hooks:",
          "  timeout_ms: 45000",
          "agent:",
          "  max_concurrent_agents: 4",
          "  max_turns: 12",
          "  max_concurrent_agents_by_state:",
          '    "in progress": 2',
          "codex:",
          "  command: codex app-server",
          "---",
          "Issue {{ issue.identifier }}",
          "Title {{ issue.title }}",
          'Attempt {{ attempt | default: "first" }}',
          'Labels {{ issue.labels | join: ", " }}',
        ].join("\n"),
        { encoding: "utf8" },
      )

      const shell = await Effect.runPromise(
        runCli([], { cwd }).pipe(Effect.provide(silentLogger)),
      )
      const loaded = await Effect.runPromise(loadWorkflowDefinition({ cwd }))
      const config = resolveWorkflowConfig(loaded.workflow.config, { cwd })
      await Effect.runPromise(validateWorkflowStartupConfig(config))

      const prompt = renderPromptTemplate(loaded.workflow.prompt_template, {
        issue: sampleIssue,
        attempt: 2,
      })

      expect(shell.workflow_path).toEqual(path.join(cwd, "WORKFLOW.md"))
      expect(shell.orchestrator_state.poll_interval_ms).toEqual(7000)
      expect(shell.orchestrator_state.max_concurrent_agents).toEqual(4)
      expect(config.tracker.api_key).toEqual("smoke-linear-token")
      expect(config.tracker.project_slug).toEqual("smoke-demo")
      expect(config.workspace.root).toEqual(path.join(cwd, "tmp", "workspaces"))
      expect(config.hooks.timeout_ms).toEqual(45_000)
      expect(config.agent.max_turns).toEqual(12)
      expect(config.agent.max_concurrent_agents_by_state).toEqual({
        "in progress": 2,
      })
      expect(prompt).toContain("Issue ABC-123")
      expect(prompt).toContain("Title Ship workflow parsing")
      expect(prompt).toContain("Attempt 2")
      expect(prompt).toContain("Labels backend, urgent")
    } finally {
      if (previousApiKey === undefined) {
        delete process.env.LINEAR_API_KEY
      } else {
        process.env.LINEAR_API_KEY = previousApiKey
      }

      await rm(cwd, { recursive: true, force: true })
    }
  })
})
