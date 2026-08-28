import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { UserContext } from "@opencode-ai/schema/user-context"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Location } from "@opencode-ai/core/location"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SkillV2 } from "@opencode-ai/core/skill"
import { SkillTool } from "@opencode-ai/core/tool/skill"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { location as locationRef } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { it } from "./lib/effect"
import { toolIdentity, executeTool, settleTool, toolDefinitions } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_skill_tool_test")

describe("SkillTool", () => {
  it.live("lists available skills, authorizes the selected name, and loads model-facing content", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const directory = path.join(tmp.path, "effect")
          const location = path.join(directory, "SKILL.md")
          const reference = path.join(directory, "reference.md")
          yield* Effect.promise(() => fs.mkdir(directory, { recursive: true }))
          yield* Effect.promise(() =>
            Promise.all([fs.writeFile(location, "unused"), fs.writeFile(reference, "reference")]),
          )

          const info: SkillV2.Info = {
            name: "effect",
            description: "Use Effect",
            location: AbsolutePath.make(location),
            content: "# Effect\n\nGuidance",
          }
          let current = [info]
          const assertions: PermissionV2.AssertInput[] = []
          let deny = false
          const permission = Layer.succeed(
            PermissionV2.Service,
            PermissionV2.Service.of({
              assert: (input) =>
                Effect.sync(() => assertions.push(input)).pipe(
                  Effect.andThen(deny ? Effect.fail(new PermissionV2.BlockedError({ rules: [] })) : Effect.void),
                ),
              ask: () => Effect.die("unused"),
              reply: () => Effect.die("unused"),
              get: () => Effect.die("unused"),
              forSession: () => Effect.die("unused"),
              list: () => Effect.die("unused"),
            }),
          )
          const skills = Layer.succeed(
            SkillV2.Service,
            SkillV2.Service.of({
              transform: (_transform) => Effect.die("unused"),
              reload: () => Effect.die("unused"),
              sources: () => Effect.die("unused"),
              list: () => Effect.succeed(current),
              create: () => Effect.die("unused"),
              update: () => Effect.die("unused"),
              remove: () => Effect.die("unused"),
            }),
          )
          const skillToolLayer = AppNodeBuilder.build(
            LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, SkillTool.node]),
            [
              [PermissionV2.node, permission],
              [SkillV2.node, skills],
              [Location.node, Layer.succeed(Location.Service, Location.Service.of(locationRef(Location.Ref.make({ directory: AbsolutePath.make(tmp.path) }))))],
              [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
            ],
          )

          return yield* Effect.gen(function* () {
            const registry = yield* ToolRegistry.Service
            expect((yield* toolDefinitions(registry))[0]).toMatchObject({
              name: "skill",
              description: SkillTool.description,
            })
            expect(
              yield* executeTool(registry, {
                sessionID,
                ...toolIdentity,
                call: { type: "tool-call", id: "call-skill", name: "skill", input: { name: "effect" } },
              }),
            ).toEqual({
              type: "text",
              value: SkillTool.toModelOutput(info, [reference]),
            })
            expect(SkillTool.toModelOutput(info, [reference])).toContain(`Base directory for this skill: ${directory}`)
            expect(
              yield* settleTool(registry, {
                sessionID,
                ...toolIdentity,
                call: { type: "tool-call", id: "call-skill-overflow", name: "skill", input: { name: "effect" } },
              }),
            ).toMatchObject({
              result: { type: "text", value: SkillTool.toModelOutput(info, [reference]) },
              output: { structured: { name: "effect" } },
            })
            expect(assertions).toMatchObject([
              { sessionID, action: "skill", resources: ["effect"], save: ["effect"] },
              { sessionID, action: "skill", resources: ["effect"], save: ["effect"] },
            ])
            expect(
              yield* executeTool(registry, {
                sessionID,
                ...toolIdentity,
                call: { type: "tool-call", id: "call-missing-skill", name: "skill", input: { name: "missing" } },
              }),
            ).toEqual({ type: "error", value: "Unable to load skill missing" })
            deny = true
            expect(
              yield* executeTool(registry, {
                sessionID,
                ...toolIdentity,
                call: { type: "tool-call", id: "call-denied-skill", name: "skill", input: { name: "effect" } },
              }),
            ).toEqual({ type: "error", value: "Unable to load skill effect" })
            deny = false
            const flat = SkillV2.Info.make({
              name: "public",
              description: "Public guidance",
              location: AbsolutePath.make(path.join(tmp.path, "public.md")),
              content: "Public",
            })
            yield* Effect.promise(() =>
              Promise.all([
                fs.writeFile(flat.location, "public"),
                fs.writeFile(path.join(tmp.path, "secret.md"), "secret"),
              ]),
            )
            current = [flat]
            expect(
              yield* executeTool(registry, {
                sessionID,
                ...toolIdentity,
                call: { type: "tool-call", id: "call-flat-skill", name: "skill", input: { name: "public" } },
              }),
            ).toEqual({ type: "text", value: SkillTool.toModelOutput(flat, []) })
          }).pipe(Effect.provide(skillToolLayer))
        }),
      ),
    ),
  )
})

function userContext(partial: Partial<UserContext.Info> = {}): UserContext.Info {
  return {
    userID: "u1",
    username: "alice",
    departmentCode: "D1",
    role: "user",
    permissions: [],
    ...partial,
  }
}

const allowPermission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: () => Effect.void,
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

describe("SkillTool create", () => {
  // Builds a real skill-tool layer against a temp Location directory so created
  // skills land on disk and can be read back. SkillV2/FSUtil/SkillDiscovery use
  // their default (real) layers; only Permission/Location/ToolOutputStore are
  // overridden. UserContext is injected per-call via Effect.provideService.
  function realLayer(tmpPath: string) {
    return AppNodeBuilder.build(
      LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, SkillTool.node]),
      [
        [PermissionV2.node, allowPermission],
        [Location.node, Layer.succeed(Location.Service, Location.Service.of(locationRef(Location.Ref.make({ directory: AbsolutePath.make(tmpPath) }))))],
        [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
      ],
    )
  }

  it.live("creates a personal (user) skill for an authenticated user and writes to user_<id>/", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          const result = yield* executeTool(registry, {
            sessionID,
            ...toolIdentity,
            call: { type: "tool-call", id: "call-create-user", name: "skill", input: { action: "create", name: "my-skill", content: "# Mine\n\nSteps" } },
          })
          expect(result).toMatchObject({ type: "text" })
          const onDisk = (yield* Effect.promise(() =>
            fs.readFile(path.join(tmp.path, "user_u1", "my-skill", "SKILL.md"), "utf8"),
          )) as string
          expect(onDisk).toContain("name: my-skill")
          expect(onDisk).toContain("# Mine")
        }).pipe(Effect.provide(realLayer(tmp.path)), Effect.provideService(UserContext.Service, userContext())),
      ),
    ),
  )

  it.live("creates a department skill pinned to the caller's department", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          const result = yield* executeTool(registry, {
            sessionID,
            ...toolIdentity,
            call: { type: "tool-call", id: "call-create-dept", name: "skill", input: { action: "create", name: "team-skill", scope: { type: "department" }, content: "# Team" } },
          })
          expect(result).toMatchObject({ type: "text" })
          expect(
            (yield* Effect.promise(() =>
              fs.readFile(path.join(tmp.path, "dept_D1", "team-skill", "SKILL.md"), "utf8"),
            )) as string,
          ).toContain("name: team-skill")
        }).pipe(Effect.provide(realLayer(tmp.path)), Effect.provideService(UserContext.Service, userContext({ departmentCode: "D1" }))),
      ),
    ),
  )

  it.live("refuses to create without an authenticated user context", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          // No UserContext provided → serviceOption yields None.
          const result = yield* executeTool(registry, {
            sessionID,
            ...toolIdentity,
            call: { type: "tool-call", id: "call-create-noauth", name: "skill", input: { action: "create", name: "x", content: "y" } },
          })
          expect(result).toEqual({ type: "error", value: "Creating skills requires an authenticated user context" })
        }).pipe(Effect.provide(realLayer(tmp.path))),
      ),
    ),
  )

  it.live("refuses contentless create with a clear message", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          const result = yield* executeTool(registry, {
            sessionID,
            ...toolIdentity,
            call: { type: "tool-call", id: "call-create-nocontent", name: "skill", input: { action: "create", name: "x" } },
          })
          expect(result).toEqual({ type: "error", value: "Creating a skill requires `content` (the SKILL.md body)" })
        }).pipe(Effect.provide(realLayer(tmp.path)), Effect.provideService(UserContext.Service, userContext())),
      ),
    ),
  )

  it.live("rejects a plain user creating a global skill (only global_admin)", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          const result = yield* executeTool(registry, {
            sessionID,
            ...toolIdentity,
            call: { type: "tool-call", id: "call-create-global-deny", name: "skill", input: { action: "create", name: "g", scope: { type: "global" }, content: "g" } },
          })
          expect(result).toMatchObject({ type: "error" })
          if (result.type === "error") expect(result.value).toContain("Only global administrators")
        }).pipe(Effect.provide(realLayer(tmp.path)), Effect.provideService(UserContext.Service, userContext({ role: "user" }))),
      ),
    ),
  )

  it.live("allows a global_admin to create a global skill", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          const result = yield* executeTool(registry, {
            sessionID,
            ...toolIdentity,
            call: { type: "tool-call", id: "call-create-global-ok", name: "skill", input: { action: "create", name: "g", scope: { type: "global" }, content: "g" } },
          })
          expect(result).toMatchObject({ type: "text" })
          expect(
            (yield* Effect.promise(() => fs.readFile(path.join(tmp.path, "global", "g", "SKILL.md"), "utf8"))) as string,
          ).toContain("name: g")
        }).pipe(Effect.provide(realLayer(tmp.path)), Effect.provideService(UserContext.Service, userContext({ role: "global_admin" }))),
      ),
    ),
  )

  it.live("rejects a same-name create in the same scope (ConflictError → ToolFailure)", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          const first = yield* executeTool(registry, {
            sessionID,
            ...toolIdentity,
            call: { type: "tool-call", id: "call-create-dup-1", name: "skill", input: { action: "create", name: "dup", content: "first" } },
          })
          expect(first).toMatchObject({ type: "text" })
          const second = yield* executeTool(registry, {
            sessionID,
            ...toolIdentity,
            call: { type: "tool-call", id: "call-create-dup-2", name: "skill", input: { action: "create", name: "dup", content: "second" } },
          })
          expect(second).toMatchObject({ type: "error" })
          if (second.type === "error") expect(second.value).toContain("already exists")
        }).pipe(Effect.provide(realLayer(tmp.path)), Effect.provideService(UserContext.Service, userContext())),
      ),
    ),
  )

  it.live("rejects an invalid skill name (InvalidNameError → ToolFailure)", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          const result = yield* executeTool(registry, {
            sessionID,
            ...toolIdentity,
            call: { type: "tool-call", id: "call-create-badname", name: "skill", input: { action: "create", name: "Bad Name", content: "x" } },
          })
          expect(result).toMatchObject({ type: "error" })
          if (result.type === "error") expect(result.value).toContain("Invalid skill name")
        }).pipe(Effect.provide(realLayer(tmp.path)), Effect.provideService(UserContext.Service, userContext())),
      ),
    ),
  )
})
