import { Effect, Layer, Option, Schema, ServiceMap } from "effect"

import {
  TrackerAdapterError,
  trackerAdapterError,
  type TrackerAdapterErrorCode,
} from "../domain/errors"
import {
  DEFAULT_LINEAR_ENDPOINT,
  DEFAULT_LINEAR_PAGE_SIZE,
  DEFAULT_LINEAR_TIMEOUT_MS,
  JsonMap,
  type BlockerRef,
  type Issue,
  type TrackerConfig,
} from "../domain/models"

export type LinearFetch = (url: string, init: RequestInit) => Promise<Response>

export type LinearGraphqlRequest = {
  readonly query: string
  readonly variables?: Record<string, unknown>
}

export type LinearTrackerClientOptions = {
  readonly fetch?: LinearFetch
  readonly page_size?: number
  readonly timeout_ms?: number
}

export type LinearTrackerClientService = {
  readonly executeGraphql: (
    request: LinearGraphqlRequest,
  ) => Effect.Effect<JsonMap, TrackerAdapterError>
  readonly fetchCandidateIssues: () => Effect.Effect<
    Array<Issue>,
    TrackerAdapterError
  >
  readonly fetchIssuesByStates: (
    stateNames: ReadonlyArray<string>,
  ) => Effect.Effect<Array<Issue>, TrackerAdapterError>
  readonly fetchIssueStatesByIds: (
    issueIds: ReadonlyArray<string>,
  ) => Effect.Effect<Array<Issue>, TrackerAdapterError>
}

const LINEAR_ISSUE_FIELDS = `
  id
  identifier
  title
  description
  priority
  state {
    name
  }
  branchName
  url
  labels {
    nodes {
      name
    }
  }
  inverseRelations(first: $relationFirst) {
    nodes {
      type
      issue {
        id
        identifier
        state {
          name
        }
      }
    }
  }
  createdAt
  updatedAt
`

const LINEAR_ISSUES_BY_STATES_QUERY = `
  query GreplineLinearIssuesByStates(
    $projectSlug: String!
    $stateNames: [String!]!
    $first: Int!
    $relationFirst: Int!
    $after: String
  ) {
    issues(
      filter: {
        project: {slugId: {eq: $projectSlug}}
        state: {name: {in: $stateNames}}
      }
      first: $first
      after: $after
    ) {
      nodes {
        ${LINEAR_ISSUE_FIELDS}
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`

const LINEAR_ISSUES_BY_IDS_QUERY = `
  query GreplineLinearIssuesByIds(
    $ids: [ID!]!
    $first: Int!
    $relationFirst: Int!
  ) {
    issues(filter: {id: {in: $ids}}, first: $first) {
      nodes {
        ${LINEAR_ISSUE_FIELDS}
      }
    }
  }
`

const LinearStateNode = Schema.Struct({
  name: Schema.String,
})
type LinearStateNode = Schema.Schema.Type<typeof LinearStateNode>

const LinearLabelNode = Schema.Struct({
  name: Schema.String,
})

const LinearIssueReferenceNode = Schema.Struct({
  id: Schema.NullOr(Schema.String),
  identifier: Schema.NullOr(Schema.String),
  state: Schema.NullOr(LinearStateNode),
})
type LinearIssueReferenceNode = Schema.Schema.Type<
  typeof LinearIssueReferenceNode
>

const LinearInverseRelationNode = Schema.Struct({
  type: Schema.String,
  issue: Schema.NullOr(LinearIssueReferenceNode),
})

const LinearIssueNode = Schema.Struct({
  id: Schema.String,
  identifier: Schema.String,
  title: Schema.String,
  description: Schema.NullOr(Schema.String),
  priority: Schema.NullOr(Schema.Number),
  state: LinearStateNode,
  branchName: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
  labels: Schema.Struct({
    nodes: Schema.Array(LinearLabelNode),
  }),
  inverseRelations: Schema.Struct({
    nodes: Schema.Array(LinearInverseRelationNode),
  }),
  createdAt: Schema.NullOr(Schema.String),
  updatedAt: Schema.NullOr(Schema.String),
})
type LinearIssueNode = Schema.Schema.Type<typeof LinearIssueNode>

const LinearIssuesPage = Schema.Struct({
  data: Schema.Struct({
    issues: Schema.Struct({
      nodes: Schema.Array(LinearIssueNode),
      pageInfo: Schema.Struct({
        hasNextPage: Schema.Boolean,
        endCursor: Schema.NullOr(Schema.String),
      }),
    }),
  }),
})
type LinearIssuesPage = Schema.Schema.Type<typeof LinearIssuesPage>

const LinearIssuesList = Schema.Struct({
  data: Schema.Struct({
    issues: Schema.Struct({
      nodes: Schema.Array(LinearIssueNode),
    }),
  }),
})
type LinearIssuesList = Schema.Schema.Type<typeof LinearIssuesList>

const LinearGraphqlErrors = Schema.Struct({
  errors: Schema.Array(JsonMap),
})
type LinearGraphqlErrors = Schema.Schema.Type<typeof LinearGraphqlErrors>

const decodeJsonMap = Schema.decodeUnknownSync(JsonMap)
const decodeLinearGraphqlErrors =
  Schema.decodeUnknownOption(LinearGraphqlErrors)
const decodeLinearIssuesPage = Schema.decodeUnknownSync(LinearIssuesPage)
const decodeLinearIssuesList = Schema.decodeUnknownSync(LinearIssuesList)
const PositiveInteger = Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)))
const decodePositiveInteger = Schema.decodeUnknownOption(PositiveInteger)

const normalizeString = (value: string | null): string | null => {
  if (value === null) {
    return null
  }

  const trimmed = value.trim()
  return trimmed === "" ? null : trimmed
}

const normalizeTimestamp = (value: string | null): string | null => {
  const timestamp = normalizeString(value)
  if (timestamp === null) {
    return null
  }

  const parsedAt = Date.parse(timestamp)
  return Number.isNaN(parsedAt) ? null : new Date(parsedAt).toISOString()
}

const normalizePriority = (value: number | null): number | null =>
  typeof value === "number" && Number.isInteger(value) ? value : null

const normalizeLabels = (
  value: LinearIssueNode["labels"]["nodes"],
): Array<string> => value.map((label) => label.name.trim().toLowerCase())

const normalizeBlocker = (
  value: LinearIssueReferenceNode | null,
): BlockerRef => ({
  id: normalizeString(value?.id ?? null),
  identifier: normalizeString(value?.identifier ?? null),
  state: normalizeString(value?.state?.name ?? null),
})

const normalizeBlockers = (
  value: LinearIssueNode["inverseRelations"]["nodes"],
): Array<BlockerRef> => {
  return value.flatMap((relation) => {
    const relationType = normalizeString(relation.type)

    if (relationType?.toLowerCase() !== "blocks") {
      return []
    }

    return [normalizeBlocker(relation.issue)]
  })
}

const normalizeIssue = (issue: LinearIssueNode): Issue => {
  const stateName = normalizeString(issue.state.name) ?? issue.state.name.trim()

  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: normalizeString(issue.description),
    priority: normalizePriority(issue.priority),
    state: stateName,
    branch_name: normalizeString(issue.branchName),
    url: normalizeString(issue.url),
    labels: normalizeLabels(issue.labels.nodes),
    blocked_by: normalizeBlockers(issue.inverseRelations.nodes),
    created_at: normalizeTimestamp(issue.createdAt),
    updated_at: normalizeTimestamp(issue.updatedAt),
  }
}

const fail = (
  code: TrackerAdapterErrorCode,
  message: string,
  details?: Record<string, unknown>,
): TrackerAdapterError => trackerAdapterError(code, message, details)

const decodeWithSchema = <Value>(
  decode: (value: unknown) => Value,
  value: unknown,
  message: string,
): Effect.Effect<Value, TrackerAdapterError> =>
  Effect.try({
    try: () => decode(value),
    catch: (cause) =>
      fail("linear_unknown_payload", message, {
        cause: String(cause),
      }),
  })

const normalizeStateNames = (
  stateNames: ReadonlyArray<string>,
): Array<string> => [
  ...new Set(
    stateNames
      .map((stateName) => normalizeString(stateName))
      .filter((value) => value !== null),
  ),
]

const normalizeIssueIds = (issueIds: ReadonlyArray<string>): Array<string> => [
  ...new Set(
    issueIds
      .map((issueId) => normalizeString(issueId))
      .filter((value) => value !== null),
  ),
]

const chunk = <Value>(
  values: ReadonlyArray<Value>,
  size: number,
): Array<Array<Value>> => {
  const chunks: Array<Array<Value>> = []

  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size))
  }

  return chunks
}

const sortIssuesByRequestedIds = (
  issues: ReadonlyArray<Issue>,
  issueIds: ReadonlyArray<string>,
): Array<Issue> => {
  const indexById = new Map(issueIds.map((issueId, index) => [issueId, index]))
  const fallbackIndex = issueIds.length

  return [...issues].sort(
    (left, right) =>
      (indexById.get(left.id) ?? fallbackIndex) -
      (indexById.get(right.id) ?? fallbackIndex),
  )
}

const resolvePageSize = (value: number | undefined): number =>
  Option.getOrElse(decodePositiveInteger(value), () => DEFAULT_LINEAR_PAGE_SIZE)

const resolveTimeoutMs = (value: number | undefined): number =>
  Option.getOrElse(
    decodePositiveInteger(value),
    () => DEFAULT_LINEAR_TIMEOUT_MS,
  )

const validateTrackerConfig = (
  config: TrackerConfig,
  options: {
    readonly require_project_slug: boolean
  },
): Effect.Effect<
  {
    readonly endpoint: string
    readonly api_key: string
    readonly project_slug: string | null
  },
  TrackerAdapterError
> => {
  if (config.kind !== "linear") {
    return Effect.fail(
      fail("unsupported_tracker_kind", "tracker kind is not supported", {
        kind: config.kind,
      }),
    )
  }

  const endpoint = normalizeString(config.endpoint) ?? DEFAULT_LINEAR_ENDPOINT
  const api_key = normalizeString(config.api_key)

  if (api_key === null) {
    return Effect.fail(
      fail("missing_tracker_api_key", "tracker api key is required", {
        endpoint,
      }),
    )
  }

  const project_slug = normalizeString(config.project_slug)
  if (options.require_project_slug && project_slug === null) {
    return Effect.fail(
      fail("missing_tracker_project_slug", "tracker project slug is required", {
        endpoint,
      }),
    )
  }

  return Effect.succeed({ endpoint, api_key, project_slug })
}

const decodeGraphqlBody = (
  payload: JsonMap,
): Effect.Effect<JsonMap, TrackerAdapterError> => {
  return Option.match(decodeLinearGraphqlErrors(payload), {
    onNone: () => Effect.succeed(payload),
    onSome: ({ errors }: LinearGraphqlErrors) =>
      errors.length === 0
        ? Effect.succeed(payload)
        : Effect.fail(
            fail("linear_graphql_errors", "linear graphql returned errors", {
              errors,
            }),
          ),
  })
}

const decodeIssuesPage = (
  payload: JsonMap,
): Effect.Effect<
  {
    readonly issues: Array<Issue>
    readonly has_next_page: boolean
    readonly end_cursor: string | null
  },
  TrackerAdapterError
> =>
  decodeGraphqlBody(payload).pipe(
    Effect.flatMap((body) =>
      decodeWithSchema(
        decodeLinearIssuesPage,
        body,
        "linear response did not include a paginated issues connection",
      ),
    ),
    Effect.map((body: LinearIssuesPage) => ({
      issues: body.data.issues.nodes.map(normalizeIssue),
      has_next_page: body.data.issues.pageInfo.hasNextPage,
      end_cursor: normalizeString(body.data.issues.pageInfo.endCursor),
    })),
  )

const decodeIssuesList = (
  payload: JsonMap,
): Effect.Effect<Array<Issue>, TrackerAdapterError> =>
  decodeGraphqlBody(payload).pipe(
    Effect.flatMap((body) =>
      decodeWithSchema(
        decodeLinearIssuesList,
        body,
        "linear response did not include an issues list",
      ),
    ),
    Effect.map((body: LinearIssuesList) =>
      body.data.issues.nodes.map(normalizeIssue),
    ),
  )

const makeLinearTrackerClientService = (
  config: TrackerConfig,
  options: LinearTrackerClientOptions = {},
): Effect.Effect<LinearTrackerClientService> => {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const pageSize = resolvePageSize(options.page_size)
  const timeoutMs = resolveTimeoutMs(options.timeout_ms)

  const executeGraphql = (
    request: LinearGraphqlRequest,
  ): Effect.Effect<JsonMap, TrackerAdapterError> =>
    Effect.gen(function* () {
      const tracker = yield* validateTrackerConfig(config, {
        require_project_slug: false,
      })

      const controller = new AbortController()
      const timeout = globalThis.setTimeout(() => {
        controller.abort()
      }, timeoutMs)

      const payload = yield* Effect.tryPromise({
        try: async () => {
          try {
            const response = await fetchImpl(tracker.endpoint, {
              method: "POST",
              headers: {
                Authorization: tracker.api_key,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                query: request.query,
                variables: request.variables ?? {},
              }),
              signal: controller.signal,
            })

            if (!response.ok) {
              const body = await response.text().catch(() => "")

              throw fail(
                "linear_api_status",
                "linear request returned a non-success status",
                {
                  endpoint: tracker.endpoint,
                  status: response.status,
                  status_text: response.statusText,
                  body,
                },
              )
            }

            try {
              return decodeJsonMap(await response.json())
            } catch (cause) {
              throw fail(
                "linear_unknown_payload",
                "linear response body was not a json object",
                {
                  endpoint: tracker.endpoint,
                  cause: String(cause),
                },
              )
            }
          } finally {
            globalThis.clearTimeout(timeout)
          }
        },
        catch: (cause) =>
          cause instanceof TrackerAdapterError
            ? cause
            : fail("linear_api_request", "linear request failed", {
                endpoint: tracker.endpoint,
                cause: String(cause),
              }),
      })

      return payload as JsonMap
    })

  const fetchIssuesByStates = (
    stateNames: ReadonlyArray<string>,
  ): Effect.Effect<Array<Issue>, TrackerAdapterError> =>
    Effect.gen(function* () {
      const tracker = yield* validateTrackerConfig(config, {
        require_project_slug: true,
      })
      const normalizedStates = normalizeStateNames(stateNames)

      if (normalizedStates.length === 0) {
        return []
      }

      const fetchPage = (
        after: string | null,
        acc: Array<Issue>,
      ): Effect.Effect<Array<Issue>, TrackerAdapterError> =>
        executeGraphql({
          query: LINEAR_ISSUES_BY_STATES_QUERY,
          variables: {
            projectSlug: tracker.project_slug,
            stateNames: normalizedStates,
            first: pageSize,
            relationFirst: pageSize,
            after,
          },
        }).pipe(
          Effect.flatMap(decodeIssuesPage),
          Effect.flatMap((page) => {
            const issues = [...acc, ...page.issues]

            if (!page.has_next_page) {
              return Effect.succeed(issues)
            }

            if (page.end_cursor === null) {
              return Effect.fail(
                fail(
                  "linear_missing_end_cursor",
                  "linear pagination returned hasNextPage without an endCursor",
                ),
              )
            }

            return fetchPage(page.end_cursor, issues)
          }),
        )

      return yield* fetchPage(null, [])
    })

  const fetchCandidateIssues = (): Effect.Effect<
    Array<Issue>,
    TrackerAdapterError
  > => fetchIssuesByStates(config.active_states)

  const fetchIssueStatesByIds = (
    issueIds: ReadonlyArray<string>,
  ): Effect.Effect<Array<Issue>, TrackerAdapterError> =>
    Effect.gen(function* () {
      yield* validateTrackerConfig(config, {
        require_project_slug: false,
      })

      const normalizedIds = normalizeIssueIds(issueIds)
      if (normalizedIds.length === 0) {
        return []
      }

      const batches = chunk(normalizedIds, pageSize)
      const issuePages = yield* Effect.forEach(
        batches,
        (ids) =>
          executeGraphql({
            query: LINEAR_ISSUES_BY_IDS_QUERY,
            variables: {
              ids,
              first: ids.length,
              relationFirst: pageSize,
            },
          }).pipe(Effect.flatMap(decodeIssuesList)),
        {
          concurrency: 1,
        },
      )

      return sortIssuesByRequestedIds(issuePages.flat(), normalizedIds)
    })

  return Effect.succeed({
    executeGraphql,
    fetchCandidateIssues,
    fetchIssuesByStates,
    fetchIssueStatesByIds,
  })
}

export class LinearTrackerClient extends ServiceMap.Service<
  LinearTrackerClient,
  LinearTrackerClientService
>()("grepline/LinearTrackerClient") {
  static layer = (
    config: TrackerConfig,
    options: LinearTrackerClientOptions = {},
  ): Layer.Layer<LinearTrackerClient> =>
    Layer.effect(this, makeLinearTrackerClientService(config, options))

  static executeGraphql(
    request: LinearGraphqlRequest,
  ): Effect.Effect<JsonMap, TrackerAdapterError, LinearTrackerClient> {
    return this.use((service) => service.executeGraphql(request))
  }

  static fetchCandidateIssues(): Effect.Effect<
    Array<Issue>,
    TrackerAdapterError,
    LinearTrackerClient
  > {
    return this.use((service) => service.fetchCandidateIssues())
  }

  static fetchIssuesByStates(
    stateNames: ReadonlyArray<string>,
  ): Effect.Effect<Array<Issue>, TrackerAdapterError, LinearTrackerClient> {
    return this.use((service) => service.fetchIssuesByStates(stateNames))
  }

  static fetchIssueStatesByIds(
    issueIds: ReadonlyArray<string>,
  ): Effect.Effect<Array<Issue>, TrackerAdapterError, LinearTrackerClient> {
    return this.use((service) => service.fetchIssueStatesByIds(issueIds))
  }
}
