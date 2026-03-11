import { runtimeError, type RuntimeError } from "../domain/errors"
import { DEFAULT_WORKFLOW_PROMPT, type Issue } from "../domain/models"

type PromptContext = {
  readonly issue: Issue
  readonly attempt: number | null
}

type PathSegment = string | number

type ValueExpression =
  | {
      readonly _tag: "literal"
      readonly value: unknown
    }
  | {
      readonly _tag: "path"
      readonly segments: ReadonlyArray<PathSegment>
    }

type FilterExpression = {
  readonly name: string
  readonly args: ReadonlyArray<ValueExpression>
}

type TemplateExpression = {
  readonly source: ValueExpression
  readonly filters: ReadonlyArray<FilterExpression>
}

type TemplateToken =
  | {
      readonly _tag: "text"
      readonly value: string
    }
  | {
      readonly _tag: "output"
      readonly value: string
    }
  | {
      readonly _tag: "statement"
      readonly value: string
    }

type TemplateNode =
  | {
      readonly _tag: "text"
      readonly value: string
    }
  | {
      readonly _tag: "output"
      readonly expression: TemplateExpression
    }
  | {
      readonly _tag: "if"
      readonly condition: TemplateExpression
      readonly consequent: ReadonlyArray<TemplateNode>
      readonly alternate: ReadonlyArray<TemplateNode>
    }

const splitByDelimiter = (source: string, delimiter: string): Array<string> => {
  const parts: Array<string> = []
  let current = ""
  let quote: string | null = null

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]

    if (quote !== null) {
      current += character

      if (character === quote && source[index - 1] !== "\\") {
        quote = null
      }

      continue
    }

    if (character === '"' || character === "'") {
      quote = character
      current += character
      continue
    }

    if (character === delimiter) {
      parts.push(current.trim())
      current = ""
      continue
    }

    current += character
  }

  parts.push(current.trim())
  return parts
}

const parseLiteral = (source: string): ValueExpression | undefined => {
  if (source === "true") {
    return { _tag: "literal", value: true }
  }

  if (source === "false") {
    return { _tag: "literal", value: false }
  }

  if (source === "null") {
    return { _tag: "literal", value: null }
  }

  if (/^-?\d+$/.test(source)) {
    return { _tag: "literal", value: Number.parseInt(source, 10) }
  }

  if (
    (source.startsWith('"') && source.endsWith('"')) ||
    (source.startsWith("'") && source.endsWith("'"))
  ) {
    return {
      _tag: "literal",
      value: source.slice(1, -1).replaceAll(/\\(['"\\])/g, "$1"),
    }
  }

  return undefined
}

const parsePath = (source: string): ValueExpression => {
  const segments: Array<PathSegment> = []
  let index = 0

  const readIdentifier = (): string => {
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(index))
    if (match === null) {
      throw runtimeError("template_parse_error", "invalid template path", {
        expression: source,
      })
    }

    index += match[0].length
    return match[0]
  }

  segments.push(readIdentifier())

  while (index < source.length) {
    const character = source[index]

    if (character === ".") {
      index += 1
      segments.push(readIdentifier())
      continue
    }

    if (character === "[") {
      index += 1
      const endIndex = source.indexOf("]", index)
      if (endIndex === -1) {
        throw runtimeError("template_parse_error", "unclosed path segment", {
          expression: source,
        })
      }

      const inner = source.slice(index, endIndex).trim()
      const literal = parseLiteral(inner)

      if (literal?._tag === "literal") {
        if (
          typeof literal.value === "number" ||
          typeof literal.value === "string"
        ) {
          segments.push(literal.value)
        } else {
          throw runtimeError(
            "template_parse_error",
            "path brackets must contain a string or integer",
            { expression: source },
          )
        }
      } else if (/^\d+$/.test(inner)) {
        segments.push(Number.parseInt(inner, 10))
      } else {
        throw runtimeError(
          "template_parse_error",
          "path brackets must contain a string or integer",
          { expression: source },
        )
      }

      index = endIndex + 1
      continue
    }

    throw runtimeError("template_parse_error", "invalid template path", {
      expression: source,
    })
  }

  return {
    _tag: "path",
    segments,
  }
}

const parseValueExpression = (source: string): ValueExpression => {
  const trimmed = source.trim()
  if (trimmed === "") {
    throw runtimeError("template_parse_error", "empty template expression")
  }

  return parseLiteral(trimmed) ?? parsePath(trimmed)
}

const parseFilter = (source: string): FilterExpression => {
  const colonIndex = source.indexOf(":")
  if (colonIndex === -1) {
    return { name: source.trim(), args: [] }
  }

  const name = source.slice(0, colonIndex).trim()
  const args = splitByDelimiter(source.slice(colonIndex + 1), ",").map(
    (entry) => parseValueExpression(entry),
  )

  return { name, args }
}

const parseTemplateExpression = (source: string): TemplateExpression => {
  const segments = splitByDelimiter(source, "|")
  const [firstSegment, ...filterSegments] = segments

  if (firstSegment === undefined || firstSegment === "") {
    throw runtimeError("template_parse_error", "empty template output", {
      expression: source,
    })
  }

  return {
    source: parseValueExpression(firstSegment),
    filters: filterSegments.map((segment) => parseFilter(segment)),
  }
}

const tokenizeTemplate = (template: string): Array<TemplateToken> => {
  const tokens: Array<TemplateToken> = []
  let index = 0

  while (index < template.length) {
    const outputIndex = template.indexOf("{{", index)
    const statementIndex = template.indexOf("{%", index)
    const nextIndex =
      outputIndex === -1
        ? statementIndex
        : statementIndex === -1
          ? outputIndex
          : Math.min(outputIndex, statementIndex)

    if (nextIndex === -1) {
      tokens.push({ _tag: "text", value: template.slice(index) })
      break
    }

    if (nextIndex > index) {
      tokens.push({ _tag: "text", value: template.slice(index, nextIndex) })
    }

    const isOutput = template.startsWith("{{", nextIndex)
    const closeDelimiter = isOutput ? "}}" : "%}"
    const closeIndex = template.indexOf(closeDelimiter, nextIndex + 2)

    if (closeIndex === -1) {
      throw runtimeError("template_parse_error", "unclosed template tag", {
        template,
      })
    }

    const value = template.slice(nextIndex + 2, closeIndex).trim()
    tokens.push({ _tag: isOutput ? "output" : "statement", value })
    index = closeIndex + 2
  }

  return tokens
}

const readStatementName = (statement: string): string =>
  statement.split(/\s+/, 1)[0] ?? ""

const parseNodes = (
  tokens: ReadonlyArray<TemplateToken>,
  index: number,
  stopStatements: ReadonlyArray<string> = [],
): {
  readonly nodes: ReadonlyArray<TemplateNode>
  readonly index: number
  readonly stop: string | null
} => {
  const nodes: Array<TemplateNode> = []
  let currentIndex = index

  while (currentIndex < tokens.length) {
    const token = tokens[currentIndex]

    if (token === undefined) {
      break
    }

    if (token._tag === "text") {
      nodes.push({ _tag: "text", value: token.value })
      currentIndex += 1
      continue
    }

    if (token._tag === "output") {
      nodes.push({
        _tag: "output",
        expression: parseTemplateExpression(token.value),
      })
      currentIndex += 1
      continue
    }

    const statementName = readStatementName(token.value)
    if (stopStatements.includes(statementName)) {
      return {
        nodes,
        index: currentIndex,
        stop: statementName,
      }
    }

    if (statementName !== "if") {
      throw runtimeError("template_parse_error", "unknown template tag", {
        tag: statementName,
      })
    }

    const conditionSource = token.value.slice(2).trim()
    if (conditionSource === "") {
      throw runtimeError("template_parse_error", "if tag requires a condition")
    }

    const consequentResult = parseNodes(tokens, currentIndex + 1, [
      "else",
      "endif",
    ])
    if (consequentResult.stop === null) {
      throw runtimeError("template_parse_error", "missing endif for if tag")
    }

    let alternate: ReadonlyArray<TemplateNode> = []
    let nextIndex = consequentResult.index

    if (consequentResult.stop === "else") {
      const alternateResult = parseNodes(tokens, consequentResult.index + 1, [
        "endif",
      ])
      if (alternateResult.stop !== "endif") {
        throw runtimeError("template_parse_error", "missing endif for else tag")
      }

      alternate = alternateResult.nodes
      nextIndex = alternateResult.index
    }

    nodes.push({
      _tag: "if",
      condition: parseTemplateExpression(conditionSource),
      consequent: consequentResult.nodes,
      alternate,
    })
    currentIndex = nextIndex + 1
  }

  return {
    nodes,
    index: currentIndex,
    stop: null,
  }
}

const parseTemplate = (template: string): ReadonlyArray<TemplateNode> => {
  const tokens = tokenizeTemplate(template)
  const parsed = parseNodes(tokens, 0)

  if (parsed.stop !== null) {
    throw runtimeError(
      "template_parse_error",
      "unexpected template terminator",
      {
        tag: parsed.stop,
      },
    )
  }

  return parsed.nodes
}

const hasKey = (value: unknown, key: string): boolean =>
  typeof value === "object" && value !== null && key in value

const resolvePathValue = (
  expression: Extract<ValueExpression, { readonly _tag: "path" }>,
  context: PromptContext,
): unknown => {
  let current: unknown = context

  for (const segment of expression.segments) {
    if (typeof segment === "number") {
      if (!Array.isArray(current) || current[segment] === undefined) {
        throw runtimeError(
          "template_render_error",
          "unknown template variable",
          {
            path: expression.segments.join("."),
          },
        )
      }

      current = current[segment]
      continue
    }

    if (!hasKey(current, segment)) {
      throw runtimeError("template_render_error", "unknown template variable", {
        path: expression.segments.join("."),
      })
    }

    current = (current as Record<string, unknown>)[segment]
  }

  return current
}

const evaluateValue = (
  expression: ValueExpression,
  context: PromptContext,
): unknown =>
  expression._tag === "literal"
    ? expression.value
    : resolvePathValue(expression, context)

const normalizeOutput = (value: unknown): string => {
  if (value === null || value === undefined) {
    return ""
  }

  if (typeof value === "string") {
    return value
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value)
  }

  return JSON.stringify(value)
}

const isBlank = (value: unknown): boolean => {
  if (value === null || value === undefined) {
    return true
  }

  if (typeof value === "string") {
    return value.trim() === ""
  }

  if (Array.isArray(value)) {
    return value.length === 0
  }

  return false
}

const applyFilter = (
  filter: FilterExpression,
  value: unknown,
  context: PromptContext,
): unknown => {
  const args = filter.args.map((entry) => evaluateValue(entry, context))

  switch (filter.name) {
    case "default": {
      return isBlank(value) ? (args[0] ?? "") : value
    }
    case "downcase": {
      return normalizeOutput(value).toLowerCase()
    }
    case "upcase": {
      return normalizeOutput(value).toUpperCase()
    }
    case "strip": {
      return normalizeOutput(value).trim()
    }
    case "join": {
      if (!Array.isArray(value)) {
        return normalizeOutput(value)
      }

      return value
        .map((entry) => normalizeOutput(entry))
        .join(normalizeOutput(args[0] ?? ", "))
    }
    case "json": {
      return JSON.stringify(value, null, 2)
    }
    case "size": {
      if (typeof value === "string" || Array.isArray(value)) {
        return value.length
      }

      if (typeof value === "object" && value !== null) {
        return Object.keys(value).length
      }

      return 0
    }
    default: {
      throw runtimeError("template_render_error", "unknown template filter", {
        filter: filter.name,
      })
    }
  }
}

const evaluateExpression = (
  expression: TemplateExpression,
  context: PromptContext,
): unknown =>
  expression.filters.reduce(
    (current, filter) => applyFilter(filter, current, context),
    evaluateValue(expression.source, context),
  )

const isTruthy = (value: unknown): boolean => {
  if (isBlank(value)) {
    return false
  }

  return value !== false
}

const renderNodes = (
  nodes: ReadonlyArray<TemplateNode>,
  context: PromptContext,
): string =>
  nodes
    .map((node) => {
      switch (node._tag) {
        case "text": {
          return node.value
        }
        case "output": {
          return normalizeOutput(evaluateExpression(node.expression, context))
        }
        case "if": {
          return isTruthy(evaluateExpression(node.condition, context))
            ? renderNodes(node.consequent, context)
            : renderNodes(node.alternate, context)
        }
      }
    })
    .join("")

export const renderPromptTemplate = (
  template: string,
  context: PromptContext,
): string => {
  const effectiveTemplate =
    template.trim() === "" ? DEFAULT_WORKFLOW_PROMPT : template

  return renderNodes(parseTemplate(effectiveTemplate), context)
}

export type { PromptContext, RuntimeError }
