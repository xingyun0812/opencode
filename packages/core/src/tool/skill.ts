export * as SkillTool from "./skill"

import path from "path"
import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Option, Schema } from "effect"
import { UserContext } from "@opencode-ai/schema/user-context"
import { makeLocationNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { Location } from "../location"
import { SkillV2 } from "../skill"
import { PermissionV2 } from "../permission"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "skill"
const FILE_LIMIT = 10

const ScopeType = Schema.Literals(["global", "department", "user"])

export const Input = Schema.Struct({
  name: Schema.String.annotate({ description: "The name of the skill from the available skills list, or the name to create" }),
  action: Schema.Literals(["load", "create"]).pipe(Schema.optional).annotate({
    description: "load (default) an existing skill, or create a new skill at a scope owned by the current user",
  }),
  description: Schema.String.pipe(Schema.optional).annotate({
    description: "create only: one-line description written into SKILL.md frontmatter",
  }),
  content: Schema.String.pipe(Schema.optional).annotate({
    description: "create only: full SKILL.md body (required for create)",
  }),
  scope: Schema.Struct({ type: ScopeType }).pipe(Schema.optional).annotate({
    description: "create only: scope type — user (default), department (your department), or global (global_admin only). Identity is always taken from the current user, never from this input.",
  }),
})

export const Output = Schema.Struct({
  name: Schema.String,
  directory: Schema.String,
  output: Schema.String,
})

export const description = [
  "Load a specialized skill when the task at hand matches one of the available skills in the system context, or create a new skill.",
  "",
  "Use this tool to inject the skill's instructions and resources into the current conversation. The output may contain detailed workflow guidance as well as references to scripts, files, etc. in the same directory as the skill.",
  "",
  "The skill name must match one of the available skills in the system context.",
  "",
  "To create a skill, pass action: \"create\" with content and an optional scope { type: \"user\" | \"department\" | \"global\" }. Scope identity (userID/departmentCode) is always taken from the current user, so the created skill is owned by the caller; only global administrators may create global skills. Creating requires an authenticated (multi-tenant) session.",
].join("\n")

export const toModelOutput = (skill: SkillV2.Info, files: ReadonlyArray<string>) => {
  const directory = path.dirname(skill.location)
  return [
    `<skill_content name="${skill.name}">`,
    `# Skill: ${skill.name}`,
    "",
    skill.content.trim(),
    "",
    `Base directory for this skill: ${directory}`,
    "Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.",
    "Note: file list is sampled.",
    "",
    "<skill_files>",
    ...files.map((file) => `<file>${file}</file>`),
    "</skill_files>",
    "</skill_content>",
  ].join("\n")
}

const unableToLoad = (name: string, error?: unknown) =>
  new ToolFailure({ message: `Unable to load skill ${name}`, error })

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const fs = yield* FSUtil.Service
    const skills = yield* SkillV2.Service
    const permission = yield* PermissionV2.Service
    const location = yield* Location.Service
    const { checkScopeAccess, resolveCreateScope } = SkillV2
    yield* tools
      .register({
        [name]: Tool.make({
          description,
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: output.output }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const action = input.action ?? "load"

              // Identity is taken from the live request context. The HTTP
              // middleware injects UserContext into the request Effect, and the v1
              // engine (Runner.make + Effect.forkIn) inherits it into the tool
              // execute fiber, so serviceOption yields Some during a conversation.
              // The v2 coordinator builds its runtime at startup with no
              // UserContext, so it yields None there — creation is refused below.
              //
              // `Tool.make`'s execute signature declares a `never` requirement,
              // but reading a request-scoped service necessarily declares one.
              // Cast keeps the requirement out of the tool's type (it is satisfied
              // at runtime by the enclosing request fiber), mirroring the existing
              // `any`-requirement debt in `skill.ts` (REMAINING-TASKS §4).
              const userContext = Option.getOrUndefined(
                yield* Effect.serviceOption(UserContext.Service) as Effect.Effect<Option.Option<UserContext.Info>>,
              )

              if (action === "create") {
                if (!userContext) {
                  return yield* new ToolFailure({
                    message: "Creating skills requires an authenticated user context",
                  })
                }
                if (input.content === undefined) {
                  return yield* new ToolFailure({
                    message: "Creating a skill requires `content` (the SKILL.md body)",
                  })
                }
                // Identity is enforced from UserContext — the scope input only
                // carries the type; userID/departmentCode are resolved server-side.
                const requestedType = input.scope?.type ?? "user"
                const enforcedScope = yield* resolveCreateScope(userContext, { type: requestedType }).pipe(
                  Effect.mapError((err) => new ToolFailure({ message: err.message })),
                )
                yield* checkScopeAccess(userContext, enforcedScope).pipe(
                  Effect.mapError((err) => new ToolFailure({ message: err.message })),
                )
                const skillsRoot = location.directory
                const created = yield* skills
                  .create({
                    name: input.name,
                    description: input.description,
                    content: input.content,
                    scope: enforcedScope,
                    skillsRoot,
                  })
                  .pipe(
                    // core `create` raises ConflictError (same name) /
                    // InvalidNameError (bad name); both surface to the model as
                    // a ToolFailure carrying the core message.
                    Effect.mapError(
                      (err): ToolFailure =>
                        new ToolFailure({
                          message: err instanceof Error ? err.message : `Failed to create skill ${input.name}`,
                        }),
                    ),
                  )
                const directory = path.dirname(created.location)
                return {
                  name: created.name,
                  directory,
                  output: `Created skill ${created.name} at scope ${enforcedScope.type}\nLocation: ${created.location}`,
                }
              }

              // action === "load" (default). List filtered by identity so a user
              // can only load skills visible to them (read isolation).
              const visible = yield* skills.list(userContext)
              const skill = visible.find((skill) => skill.name === input.name)
              if (!skill) return yield* unableToLoad(input.name)
              return yield* Effect.gen(function* () {
                yield* permission.assert({
                  action: name,
                  resources: [skill.name],
                  save: [skill.name],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
                })
                const directory = path.dirname(skill.location)
                const files =
                  path.basename(skill.location) === "SKILL.md"
                    ? (yield* fs.glob("**/*", { cwd: directory, absolute: true, include: "file", dot: true }))
                        .filter((file) => path.basename(file) !== "SKILL.md")
                        .toSorted()
                        .slice(0, FILE_LIMIT)
                    : []
                return {
                  name: skill.name,
                  directory,
                  output: toModelOutput(skill, files),
                }
              }).pipe(Effect.mapError((error) => unableToLoad(input.name, error)))
            }),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/skill",
  layer,
  deps: [ToolRegistry.node, FSUtil.node, SkillV2.node, PermissionV2.node, Location.node],
})
