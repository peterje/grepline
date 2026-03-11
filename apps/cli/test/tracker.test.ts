import { describe, expect, it } from "bun:test"
import { Effect } from "effect"

import type { TrackerConfig } from "../src/domain/models"
import { LinearTrackerClient } from "../src/service/tracker"

const makeTrackerConfig = (
  overrides: Partial<TrackerConfig> = {},
): TrackerConfig => ({
  kind: "linear",
  endpoint: "https://linear.example/graphql",
  api_key: "linear-token",
  project_slug: "grepline",
  active_states: ["Todo", "In Progress"],
  terminal_states: ["Done"],
  ...overrides,
})

const makeIssueNode = (
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id,
  identifier: id.toUpperCase(),
  title: `Issue ${id}`,
  description: `Description ${id}`,
  priority: 2,
  state: {
    name: "  In Progress  ",
  },
  branchName: `branch/${id}`,
  url: `https://linear.app/example/issue/${id}`,
  labels: {
    nodes: [{ name: "Backend" }, { name: " Urgent " }],
  },
  inverseRelations: {
    nodes: [
      {
        type: "  blocks  ",
        issue: {
          id: `blocker-${id}`,
          identifier: `BLOCK-${id}`,
          state: {
            name: "Todo",
          },
        },
      },
      {
        type: "relates",
        issue: {
          id: `related-${id}`,
          identifier: `REL-${id}`,
          state: {
            name: "Done",
          },
        },
      },
    ],
  },
  createdAt: "2026-03-10T12:34:56-05:00",
  updatedAt: "2026-03-11T12:34:56Z",
  ...overrides,
})

const response = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  })

const readJsonBody = (
  body: BodyInit | null | undefined,
): Record<string, unknown> => {
  if (typeof body !== "string") {
    throw new Error("expected a json request body")
  }

  return JSON.parse(body) as Record<string, unknown>
}

const readHeaders = (
  headers: HeadersInit | undefined,
): Record<string, string> => {
  if (headers === undefined) {
    return {}
  }

  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries())
  }

  if (Array.isArray(headers)) {
    return Object.fromEntries(headers)
  }

  return headers
}

const provideTrackerClient = <A, E>(
  effect: Effect.Effect<A, E, LinearTrackerClient>,
  overrides: Partial<TrackerConfig> = {},
  options: Parameters<typeof LinearTrackerClient.layer>[1] = {},
): Effect.Effect<A, E> =>
  effect.pipe(
    Effect.provide(
      LinearTrackerClient.layer(makeTrackerConfig(overrides), options),
    ),
  )

describe("linear tracker adapter", () => {
  it("fetches candidate issues with project and active-state filters across pages", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = []
    const issues = await Effect.runPromise(
      provideTrackerClient(
        LinearTrackerClient.fetchCandidateIssues(),
        {},
        {
          fetch: async (url, init) => {
            requests.push({ url, init })

            const body = readJsonBody(init.body)
            const after = body.variables as Record<string, unknown>

            return after.after === null
              ? response({
                  data: {
                    issues: {
                      nodes: [makeIssueNode("one")],
                      pageInfo: {
                        hasNextPage: true,
                        endCursor: "cursor-1",
                      },
                    },
                  },
                })
              : response({
                  data: {
                    issues: {
                      nodes: [makeIssueNode("two")],
                      pageInfo: {
                        hasNextPage: false,
                        endCursor: null,
                      },
                    },
                  },
                })
          },
        },
      ),
    )

    expect(requests).toHaveLength(2)
    expect(requests[0]?.url).toEqual("https://linear.example/graphql")
    expect(readHeaders(requests[0]?.init.headers)).toEqual({
      Authorization: "linear-token",
      "Content-Type": "application/json",
    })

    const firstBody = readJsonBody(requests[0]?.init.body)
    expect(firstBody.query).toContain("project: {slugId: {eq: $projectSlug}}")
    expect(firstBody.query).toContain("state: {name: {in: $stateNames}}")
    expect(firstBody.variables).toEqual({
      projectSlug: "grepline",
      stateNames: ["Todo", "In Progress"],
      first: 50,
      relationFirst: 50,
      after: null,
    })

    expect(issues).toEqual([
      {
        id: "one",
        identifier: "ONE",
        title: "Issue one",
        description: "Description one",
        priority: 2,
        state: "In Progress",
        branch_name: "branch/one",
        url: "https://linear.app/example/issue/one",
        labels: ["backend", "urgent"],
        blocked_by: [
          {
            id: "blocker-one",
            identifier: "BLOCK-one",
            state: "Todo",
          },
        ],
        created_at: "2026-03-10T17:34:56.000Z",
        updated_at: "2026-03-11T12:34:56.000Z",
      },
      {
        id: "two",
        identifier: "TWO",
        title: "Issue two",
        description: "Description two",
        priority: 2,
        state: "In Progress",
        branch_name: "branch/two",
        url: "https://linear.app/example/issue/two",
        labels: ["backend", "urgent"],
        blocked_by: [
          {
            id: "blocker-two",
            identifier: "BLOCK-two",
            state: "Todo",
          },
        ],
        created_at: "2026-03-10T17:34:56.000Z",
        updated_at: "2026-03-11T12:34:56.000Z",
      },
    ])
  })

  it("fetches issues by states for startup cleanup", async () => {
    const issues = await Effect.runPromise(
      provideTrackerClient(
        LinearTrackerClient.fetchIssuesByStates(["Done", "Cancelled"]),
        {},
        {
          fetch: async (_url, init) => {
            const body = readJsonBody(init.body)

            expect(body.variables).toEqual({
              projectSlug: "grepline",
              stateNames: ["Done", "Cancelled"],
              first: 50,
              relationFirst: 50,
              after: null,
            })

            return response({
              data: {
                issues: {
                  nodes: [makeIssueNode("done-1")],
                  pageInfo: {
                    hasNextPage: false,
                    endCursor: null,
                  },
                },
              },
            })
          },
        },
      ),
    )

    expect(issues.map((issue) => issue.id)).toEqual(["done-1"])
  })

  it("refreshes issue states by ids and preserves requested order across batches", async () => {
    const requestedIds = Array.from(
      { length: 51 },
      (_, index) => `issue-${index + 1}`,
    )
    const requestBodies: Array<Record<string, unknown>> = []
    const issues = await Effect.runPromise(
      provideTrackerClient(
        LinearTrackerClient.fetchIssueStatesByIds(requestedIds),
        {},
        {
          fetch: async (_url, init) => {
            const body = readJsonBody(init.body)
            requestBodies.push(body)

            const variables = body.variables as Record<string, unknown>
            const ids = variables.ids as Array<string>
            const reversed = [...ids].reverse().map((id) => makeIssueNode(id))

            return response({
              data: {
                issues: {
                  nodes: reversed,
                },
              },
            })
          },
        },
      ),
    )

    expect(requestBodies).toHaveLength(2)
    expect(String(requestBodies[0]?.query)).toContain("$ids: [ID!]!")
    expect(
      (requestBodies[0]?.variables as Record<string, unknown>).first,
    ).toEqual(50)
    expect(
      (requestBodies[1]?.variables as Record<string, unknown>).first,
    ).toEqual(1)
    expect(issues.map((issue) => issue.id)).toEqual(requestedIds)
  })

  it("normalizes invalid priority and timestamps to null", async () => {
    const [issue] = await Effect.runPromise(
      provideTrackerClient(
        LinearTrackerClient.fetchCandidateIssues(),
        {},
        {
          fetch: async () =>
            response({
              data: {
                issues: {
                  nodes: [
                    makeIssueNode("odd", {
                      priority: 2.5,
                      createdAt: "not-a-date",
                      updatedAt: null,
                    }),
                  ],
                  pageInfo: {
                    hasNextPage: false,
                    endCursor: null,
                  },
                },
              },
            }),
        },
      ),
    )

    expect(issue).toMatchObject({
      priority: null,
      created_at: null,
      updated_at: null,
    })
  })

  it("fails pagination when hasNextPage is missing an endCursor", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        provideTrackerClient(
          LinearTrackerClient.fetchCandidateIssues(),
          {},
          {
            fetch: async () =>
              response({
                data: {
                  issues: {
                    nodes: [makeIssueNode("one")],
                    pageInfo: {
                      hasNextPage: true,
                      endCursor: null,
                    },
                  },
                },
              }),
          },
        ),
      ),
    )

    expect(error.code).toEqual("linear_missing_end_cursor")
  })

  it("maps transport failures into stable adapter errors", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        provideTrackerClient(
          LinearTrackerClient.fetchCandidateIssues(),
          {},
          {
            fetch: async () => {
              throw new Error("socket hang up")
            },
          },
        ),
      ),
    )

    expect(error.code).toEqual("linear_api_request")
  })

  it("maps non-success http statuses into stable adapter errors", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        provideTrackerClient(
          LinearTrackerClient.fetchCandidateIssues(),
          {},
          {
            fetch: async () => response({ error: "forbidden" }, 403),
          },
        ),
      ),
    )

    expect(error.code).toEqual("linear_api_status")
    expect(error.details?.status).toEqual(403)
  })

  it("maps graphql errors into stable adapter errors", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        provideTrackerClient(
          LinearTrackerClient.fetchCandidateIssues(),
          {},
          {
            fetch: async () =>
              response({
                errors: [{ message: "bad query" }],
              }),
          },
        ),
      ),
    )

    expect(error.code).toEqual("linear_graphql_errors")
  })

  it("maps invalid payloads into stable adapter errors", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        provideTrackerClient(
          LinearTrackerClient.fetchCandidateIssues(),
          {},
          {
            fetch: async () => response({ data: { nope: true } }),
          },
        ),
      ),
    )

    expect(error.code).toEqual("linear_unknown_payload")
  })

  it("fails fast when an issue node does not match the expected schema", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        provideTrackerClient(
          LinearTrackerClient.fetchCandidateIssues(),
          {},
          {
            fetch: async () =>
              response({
                data: {
                  issues: {
                    nodes: [
                      {
                        id: "broken-1",
                      },
                    ],
                    pageInfo: {
                      hasNextPage: false,
                      endCursor: null,
                    },
                  },
                },
              }),
          },
        ),
      ),
    )

    expect(error.code).toEqual("linear_unknown_payload")
  })
})
