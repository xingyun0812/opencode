import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SkillV2 } from "@opencode-ai/core/skill"
import { SkillDiscovery } from "@opencode-ai/core/skill/discovery"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const urls = new Map<string, AbsolutePath[]>()
let pulls = 0
const discovery = Layer.succeed(
  SkillDiscovery.Service,
  SkillDiscovery.Service.of({
    pull: (url) => {
      pulls++
      return Effect.succeed(urls.get(url) ?? [])
    },
  }),
)
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([SkillV2.node, AgentV2.node]), [[SkillDiscovery.node, discovery]]),
)

function write(directory: string, name: string, description: string) {
  return fs.writeFile(
    path.join(directory, name, "SKILL.md"),
    `---
name: ${name}
description: ${description}
---
# ${name}`,
  )
}

describe("SkillV2", () => {
  it.live("registers sources and resolves later source precedence", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const first = path.join(tmp.path, "first")
          const second = path.join(tmp.path, "second")
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(first, "review"), { recursive: true })
            await fs.mkdir(path.join(second, "review"), { recursive: true })
            await write(first, "review", "First")
            await write(second, "review", "Second")
            await fs.writeFile(path.join(first, "foo.md"), "---\nslash: true\n---\n# foo")
          })

          const skill = yield* SkillV2.Service
          yield* skill.transform((editor) => {
            editor.source({ type: "directory", path: AbsolutePath.make(first) })
            editor.source({ type: "directory", path: AbsolutePath.make(first) })
            editor.source({ type: "directory", path: AbsolutePath.make(second) })
            expect(editor.list()).toEqual([
              { type: "directory", path: AbsolutePath.make(first) },
              { type: "directory", path: AbsolutePath.make(second) },
            ])
          })

          expect(yield* skill.sources()).toEqual([
            { type: "directory", path: AbsolutePath.make(first) },
            { type: "directory", path: AbsolutePath.make(second) },
          ])
          expect(yield* skill.list()).toEqual([
            SkillV2.Info.make({
              name: "foo",
              slash: true,
              location: AbsolutePath.make(path.join(first, "foo.md")),
              content: "# foo",
            }),
            {
              name: "review",
              description: "Second",
              location: AbsolutePath.make(path.join(second, "review", "SKILL.md")),
              content: "# review",
            },
          ])
        }),
      ),
    ),
  )

  it.live("loads URL sources and filters skills for agents", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(tmp.path, "deploy"), { recursive: true })
            await write(tmp.path, "deploy", "Deploy production")
          })
          pulls = 0
          urls.set("https://example.test/skills/", [AbsolutePath.make(tmp.path)])

          const agents = yield* AgentV2.Service
          yield* agents.transform((editor) =>
            editor.update(AgentV2.ID.make("reviewer"), (agent) => {
              agent.permissions.push({ action: "skill", resource: "deploy", effect: "deny" })
            }),
          )

          const skill = yield* SkillV2.Service
          yield* skill.transform((editor) => editor.source({ type: "url", url: "https://example.test/skills/" }))

          expect((yield* skill.list()).map((item) => item.name)).toEqual(["deploy"])
          expect((yield* skill.list()).map((item) => item.name)).toEqual(["deploy"])
          expect(pulls).toBe(1)
          expect(SkillV2.available(yield* skill.list(), (yield* agents.get(AgentV2.ID.make("reviewer")))!)).toEqual([])
        }),
      ),
    ),
  )

  it.live("create writes a scoped skill to disk and makes it visible to list", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const skill = yield* SkillV2.Service
          yield* skill.transform((editor) =>
            editor.source({ type: "directory", path: AbsolutePath.make(tmp.path) }),
          )

          const created = yield* skill.create({
            name: "deploy",
            description: "Deploy guidance",
            content: "# Deploy\n\nSteps",
            scope: { type: "department", departmentCode: "D1" },
            skillsRoot: tmp.path,
          })
          expect(created.name).toBe("deploy")
          expect(created.scope).toEqual({ type: "department", departmentCode: "D1" })

          // Written to <skillsRoot>/dept_<code>/<name>/SKILL.md
          const onDisk = (yield* Effect.promise(() =>
            fs.readFile(path.join(tmp.path, "dept_D1", "deploy", "SKILL.md"), "utf8"),
          )) as string
          expect(onDisk).toContain("name: deploy")
          expect(onDisk).toContain("# Deploy")

          // Visible via list() (no userContext → all scopes)
          const all = yield* skill.list()
          expect(all.map((s) => s.name)).toContain("deploy")
        }),
      ),
    ),
  )

  it.live("create refuses to overwrite a same-name skill in the same scope (ConflictError)", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const skill = yield* SkillV2.Service
          yield* skill.transform((editor) =>
            editor.source({ type: "directory", path: AbsolutePath.make(tmp.path) }),
          )
          yield* skill.create({
            name: "deploy",
            content: "first",
            scope: { type: "user", userID: "u1" },
            skillsRoot: tmp.path,
          })
          const again = yield* skill
            .create({
              name: "deploy",
              content: "second",
              scope: { type: "user", userID: "u1" },
              skillsRoot: tmp.path,
            })
            .pipe(Effect.exit)
          expect(Exit.isFailure(again)).toBe(true)
          expect(String(again)).toContain("already exists")
          // Cross-scope same name is allowed (isolated by list(userContext))
          const cross = yield* skill
            .create({
              name: "deploy",
              content: "other-user",
              scope: { type: "user", userID: "u2" },
              skillsRoot: tmp.path,
            })
            .pipe(Effect.exit)
          expect(Exit.isSuccess(cross)).toBe(true)
        }),
      ),
    ),
  )

  it.live("create rejects invalid skill names (InvalidNameError)", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const skill = yield* SkillV2.Service
          for (const badName of ["Deploy", "with space", "has/slash", "traversal.."]) {
            const res = yield* skill
              .create({
                name: badName,
                content: "x",
                scope: { type: "user", userID: "u1" },
                skillsRoot: tmp.path,
              })
              .pipe(Effect.exit)
            expect(Exit.isFailure(res)).toBe(true)
            expect(String(res)).toContain("Invalid skill name")
          }
        }),
      ),
    ),
  )

  it.live("list(userContext) isolates skills by scope (read isolation)", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const skill = yield* SkillV2.Service
          yield* skill.transform((editor) =>
            editor.source({ type: "directory", path: AbsolutePath.make(tmp.path) }),
          )
          yield* skill.create({
            name: "personal-a",
            content: "a",
            scope: { type: "user", userID: "u1" },
            skillsRoot: tmp.path,
          })
          yield* skill.create({
            name: "personal-b",
            content: "b",
            scope: { type: "user", userID: "u2" },
            skillsRoot: tmp.path,
          })
          yield* skill.create({
            name: "dept-skill",
            content: "d",
            scope: { type: "department", departmentCode: "D1" },
            skillsRoot: tmp.path,
          })

          const u1 = { userID: "u1", username: "a", departmentCode: "D1", role: "user" as const, permissions: [] }
          const visibleToU1 = (yield* skill.list(u1)).map((s) => s.name)
          expect(visibleToU1).toContain("personal-a")
          expect(visibleToU1).toContain("dept-skill")
          expect(visibleToU1).not.toContain("personal-b")

          const u2 = { userID: "u2", username: "b", departmentCode: "D2", role: "user" as const, permissions: [] }
          const visibleToU2 = (yield* skill.list(u2)).map((s) => s.name)
          expect(visibleToU2).toContain("personal-b")
          expect(visibleToU2).not.toContain("personal-a")
          expect(visibleToU2).not.toContain("dept-skill")
        }),
      ),
    ),
  )
})
