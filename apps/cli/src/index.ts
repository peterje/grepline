import { BunServices } from "@effect/platform-bun"
import { Console, Effect } from "effect"
import { Command } from "effect/unstable/cli"

export const cli = Command.make("grepline", {}, () =>
  Console.log("Hello, world!"),
).pipe(Command.withDescription("Print a hello world greeting"))

export const program = Command.run(cli, { version: "0.0.0" }).pipe(
  Effect.provide(BunServices.layer),
)
