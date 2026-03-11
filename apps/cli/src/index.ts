import { makeProgram } from "./cli"

export * from "./cli"
export * from "./domain/errors"
export * from "./domain/models"
export * from "./observability/logging"
export * from "./service/shell"

export const program = makeProgram()
