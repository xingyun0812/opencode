export * as SkillV2 from "./skill"

import { makeLocationNode } from "./effect/app-node"
import path from "path"
import { Context, Effect, Layer, Schema, Types } from "effect"
import { Skill } from "@opencode-ai/schema/skill"
import { AgentV2 } from "./agent"
import { ConfigMarkdown } from "./config/markdown"
import { FSUtil } from "./fs-util"
import { PermissionV2 } from "./permission"
import { AbsolutePath } from "./schema"
import { SkillDiscovery } from "./skill/discovery"
import { State } from "./state"
import type { UserContext } from "@opencode-ai/schema/user-context"

export const DirectorySource = Skill.DirectorySource
export type DirectorySource = Skill.DirectorySource

export const UrlSource = Skill.UrlSource
export type UrlSource = Skill.UrlSource

export const EmbeddedSource = Skill.EmbeddedSource
export type EmbeddedSource = Skill.EmbeddedSource

export const Source = Skill.Source
export type Source = typeof Source.Type

export const Info = Skill.Info
export type Info = Skill.Info

export const available = (skills: ReadonlyArray<Info>, agent: AgentV2.Info) =>
  skills.filter((skill) => PermissionV2.evaluate("skill", skill.name, agent.permissions).effect !== "deny")

// ─── Scope parsing ────────────────────────────────────────────────

const SCOPE_GLOBAL = "global"

// A skill name must be lowercase, non-empty, and free of path separators or
// traversal sequences — it becomes a directory name on disk
// (`<skillsRoot>/<scopeDir>/<name>/SKILL.md`).
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/
function isValidSkillName(name: string): boolean {
  if (!name) return false
  if (name.includes("..")) return false
  if (/[\/\\]/.test(name)) return false
  return SKILL_NAME_RE.test(name)
}

function parseScopeDir(dirname: string): { type: "global" | "department" | "user"; owner?: string } | undefined {
  if (dirname === SCOPE_GLOBAL) return { type: "global" }
  const deptMatch = dirname.match(/^dept_(.+)$/)
  if (deptMatch) return { type: "department", owner: deptMatch[1] }
  const userMatch = dirname.match(/^user_(.+)$/)
  if (userMatch) return { type: "user", owner: userMatch[1] }
  return undefined
}

function parseScope(info: Skill.Info): Skill.Info {
  const dir = path.dirname(info.location)
  const parent = path.dirname(dir)
  const grandparent = path.dirname(parent)

  // Check: /skills_root/<scope>/<name>/SKILL.md
  const scope = parseScopeDir(path.basename(parent))
  if (scope) {
    if (scope.type === "department") {
      return { ...info, scope: { type: "department", departmentCode: scope.owner } }
    }
    if (scope.type === "user") {
      return { ...info, scope: { type: "user", userID: scope.owner } }
    }
    return { ...info, scope: { type: "global" } }
  }

  // Legacy: no scope directory, default to global
  return { ...info, scope: { type: "global" } }
}

const Frontmatter = Schema.Struct({
  name: Schema.String.pipe(Schema.optional),
  description: Schema.String.pipe(Schema.optional),
  slash: Schema.Boolean.pipe(Schema.optional),
})
const decodeFrontmatter = Schema.decodeUnknownOption(Frontmatter)

// ─── Scope access (shared by HTTP handler + conversation tool) ────

// The requested-by-client scope shape: type plus optional identity fields.
// Identity fields are only honored for `global_admin` (which may target any
// department); ordinary users are pinned to their own identity by
// `resolveCreateScope` before this is called.
export type RequestedScope = {
  type: "global" | "department" | "user"
  departmentCode?: string
  userID?: string
}

// The resolved scope that `create` writes to disk: identity is always present.
export type ResolvedScope =
  | { type: "global" }
  | { type: "department"; departmentCode: string }
  | { type: "user"; userID: string }

// Check whether `userContext` may manage `scope`. Read-only paths call this
// with `userContext === undefined` (returns void — passthrough); the create
// path gates absence itself before calling. Department scope is open to any
// member of the target department (any role), not restricted to `dept_admin`;
// `global_admin` short-circuits to allow. `global`/`user` rules are unchanged.
export function checkScopeAccess(
  userContext: UserContext.Info | undefined,
  scope: RequestedScope,
): Effect.Effect<void, ForbiddenError> {
  if (!userContext) return Effect.void
  switch (scope.type) {
    case "global":
      if (userContext.role === "global_admin") return Effect.void
      return Effect.fail(new ForbiddenError({ message: "Only global administrators can manage global skills" }))
    case "department":
      if (userContext.role === "global_admin") return Effect.void
      if (userContext.departmentCode === undefined) {
        return Effect.fail(new ForbiddenError({ message: "You are not a member of any department" }))
      }
      if (scope.departmentCode !== userContext.departmentCode) {
        return Effect.fail(new ForbiddenError({ message: "You can only manage skills in your own department" }))
      }
      return Effect.void
    case "user":
      if (scope.userID !== undefined && scope.userID !== userContext.userID) {
        return Effect.fail(new ForbiddenError({ message: "You can only manage your own personal skills" }))
      }
      return Effect.void
  }
}

// Resolve the scope the create path will actually write, enforcing identity
// from `userContext` for ordinary users. `global_admin` keeps the requested
// scope (it may create for any department, so its departmentCode comes from
// the request body); everyone else is pinned to their own identity.
export function resolveCreateScope(
  userContext: UserContext.Info,
  requested: RequestedScope,
): Effect.Effect<ResolvedScope, ForbiddenError> {
  const isGlobalAdmin = userContext.role === "global_admin"
  if (requested.type === "department") {
    const departmentCode = isGlobalAdmin ? requested.departmentCode : userContext.departmentCode
    if (departmentCode === undefined) {
      return Effect.fail(
        new ForbiddenError({
          message: isGlobalAdmin
            ? "Creating a department skill requires a departmentCode"
            : "You are not a member of any department",
        }),
      )
    }
    return Effect.succeed({ type: "department", departmentCode })
  }
  if (requested.type === "user") {
    return Effect.succeed({ type: "user", userID: userContext.userID })
  }
  return Effect.succeed({ type: "global" })
}

export type Data = {
  sources: Types.DeepMutable<Source>[]
}

export type Draft = {
  source: (source: Source) => void
  list: () => readonly Source[]
}

export interface Interface extends State.Transformable<Draft> {
  readonly sources: () => Effect.Effect<Source[]>
  readonly list: (userContext?: UserContext.Info) => Effect.Effect<Info[]>
  readonly create: (input: {
    name: string
    description?: string
    content: string
    scope: { type: "global" } | { type: "department"; departmentCode: string } | { type: "user"; userID: string }
    skillsRoot: string
  }) => Effect.Effect<Info, ConflictError | InvalidNameError>
  readonly update: (input: {
    name: string
    description?: string
    content?: string
  }) => Effect.Effect<Info, NotFoundError>
  readonly remove: (name: string) => Effect.Effect<void, NotFoundError>
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("SkillV2.NotFoundError", {
  name: Schema.String,
  message: Schema.String,
}) {}

// Raised by `checkScopeAccess` / `resolveCreateScope` when the current user is
// not allowed to manage the requested scope. Core-owned so the skill service,
// the HTTP handler, and the conversation tool all share one implementation; each
// call site maps it to its own error shape (HTTP 403 ForbiddenError, tool ToolFailure).
export class ForbiddenError extends Schema.TaggedErrorClass<ForbiddenError>()("SkillV2.ForbiddenError", {
  message: Schema.String,
}) {}

// Raised by `create` when a skill with the same name already exists in the
// target scope directory. Call sites map to HTTP 409 SkillNameConflictError /
// tool ToolFailure.
export class ConflictError extends Schema.TaggedErrorClass<ConflictError>()("SkillV2.ConflictError", {
  name: Schema.String,
  message: Schema.String,
}) {}

// Raised by `create` when the requested name is not a legal skill name.
export class InvalidNameError extends Schema.TaggedErrorClass<InvalidNameError>()("SkillV2.InvalidNameError", {
  name: Schema.String,
  message: Schema.String,
}) {}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Skill") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const discovery = yield* SkillDiscovery.Service
    const fs = yield* FSUtil.Service

    const state = State.create<Data, Draft>({
      initial: () => ({ sources: [] }),
      draft: (draft) => ({
        source: (source) => {
          if (draft.sources.some((item) => Source.equals(item, source))) return
          draft.sources.push(source as Types.DeepMutable<Source>)
        },
        list: () => draft.sources as Source[],
      }),
    })

    const load = Effect.fn("SkillV2.load")(function* (source: Source) {
      const skills: Info[] = []
      if (source.type === "embedded") {
        const skill = { ...source.skill, scope: { type: "global" } as const }
        return [skill]
      }
      const directories =
        source.type === "directory" ? [source.path] : yield* discovery.pull(source.url)
      for (const directory of directories) {
        // First, check if this directory has scope subdirectories
        const entries = yield* fs
          .readDirectoryEntries(directory)
          .pipe(Effect.catch(() => Effect.succeed([] as {name: string; type: string}[])))
        const dirs = entries.filter((e) => e.type === "directory")
        const scopeDirs = dirs.filter((e) => parseScopeDir(e.name) !== undefined)
        const flatDirs = dirs.filter((e) => parseScopeDir(e.name) === undefined)

        // Process scope-based directories (global/, dept_<code>/, user_<id>/)
        for (const scopeDir of scopeDirs) {
          const scope = parseScopeDir(scopeDir.name)
          if (!scope) continue
          const scopePath = path.join(directory, scopeDir.name)
          const files = yield* fs
            .glob("{*.md,**/SKILL.md}", {
              cwd: scopePath,
              absolute: true,
              include: "file",
              symlink: true,
              dot: true,
            })
            .pipe(Effect.catch(() => Effect.succeed([] as string[])))
          for (const filepath of files.toSorted()) {
            const skill = yield* loadSkillFile(fs, filepath, directory)
            if (!skill) continue
            if (scope.type === "department") {
              skills.push({ ...skill, scope: { type: "department", departmentCode: scope.owner } })
            } else if (scope.type === "user") {
              skills.push({ ...skill, scope: { type: "user", userID: scope.owner } })
            } else {
              skills.push({ ...skill, scope: { type: "global" } })
            }
          }
        }

        // Process flat directories (migration compat: existing skills outside any scope dir)
        for (const flatDir of flatDirs) {
          const flatPath = path.join(directory, flatDir.name)
          const files = yield* fs
            .glob("{*.md,**/SKILL.md}", {
              cwd: flatPath,
              absolute: true,
              include: "file",
              symlink: true,
              dot: true,
            })
            .pipe(Effect.catch(() => Effect.succeed([] as string[])))
          for (const filepath of files.toSorted()) {
            const skill = yield* loadSkillFile(fs, filepath, directory)
            if (skill) skills.push({ ...skill, scope: { type: "global" } })
          }
        }

        // Also handle top-level markdown files (completely flat structure with no subdirectories)
        if (dirs.length === 0) {
          const files = yield* fs
            .glob("{*.md,**/SKILL.md}", {
              cwd: directory,
              absolute: true,
              include: "file",
              symlink: true,
              dot: true,
            })
            .pipe(Effect.catch(() => Effect.succeed([] as string[])))
          for (const filepath of files.toSorted()) {
            const skill = yield* loadSkillFile(fs, filepath, directory)
            if (skill) skills.push({ ...skill, scope: { type: "global" } })
          }
        }
      }
      return skills
    })

    function* loadSkillFile(
      fs: FSUtil.Interface,
      filepath: string,
      directory: string,
    ): Generator<Effect.Effect<never, never, any>, Info | undefined, any> {
      const content = yield* fs.readFileStringSafe(filepath).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!content) return undefined
      const markdown = ConfigMarkdown.parseOption(content)
      if (!markdown) return undefined
      const frontmatter = decodeFrontmatter(markdown.data).valueOrUndefined
      if (!frontmatter) return undefined
      const name =
        frontmatter.name !== undefined
          ? frontmatter.name
          : path.dirname(filepath) === directory
            ? path.basename(filepath, ".md")
            : path.basename(path.dirname(filepath))
      if (!name) return undefined
      return {
        name,
        description: frontmatter.description,
        slash: frontmatter.slash,
        location: AbsolutePath.make(filepath),
        content: markdown.content,
      }
    }

    function scopeDirName(scope: ResolvedScope): string {
      switch (scope.type) {
        case "global": return "global"
        case "department": return `dept_${scope.departmentCode}`
        case "user": return `user_${scope.userID}`
      }
    }

    const cache = new Map<string, Info[]>()
    function invalidateCache() {
      cache.clear()
    }
    const list = Effect.fn("SkillV2.list")(function* (userContext?: UserContext.Info) {
      const skills = new Map<string, Info>()
      for (const source of state.get().sources) {
        const key = Source.key(source)
        const loaded = cache.get(key) ?? (yield* load(source))
        cache.set(key, loaded)
        for (const skill of loaded) skills.set(skill.name, skill)
      }
      const all = Array.from(skills.values())

      // Filter by user context if provided
      if (!userContext) return all
      return all.filter((skill) => {
        const scope = skill.scope
        if (!scope || scope.type === "global") return true
        if (scope.type === "department") return scope.departmentCode === userContext.departmentCode
        if (scope.type === "user") return scope.userID === userContext.userID
        return true
      })
    })

    return Service.of({
      transform: state.transform,
      reload: state.reload,
      sources: Effect.fn("SkillV2.sources")(function* () {
        return state.get().sources
      }),
      list,
      create: Effect.fn("SkillV2.create")(function* (input) {
        // Name validation: lowercase, no spaces/path separators/traversal.
        // Mirrors the on-disk layout (<skillsRoot>/<scopeDir>/<name>/SKILL.md)
        // so a bad name can never escape its scope directory.
        if (!isValidSkillName(input.name)) {
          return yield* new InvalidNameError({
            name: input.name,
            message: `Invalid skill name: ${input.name} (must be lowercase, no spaces or path separators)`,
          })
        }
        const scopePath = scopeDirName(input.scope)
        const dir = path.join(input.skillsRoot, scopePath, input.name)
        const filepath = path.join(dir, "SKILL.md")
        // Same-name check: refuse to silently overwrite an existing skill in
        // the same scope directory. Cross-scope same names are allowed (each
        // isolated by `list(userContext)`).
        if (yield* fs.existsSafe(filepath)) {
          return yield* new ConflictError({
            name: input.name,
            message: `A skill named ${input.name} already exists in this scope`,
          })
        }
        const frontmatter: Record<string, string | undefined> = { name: input.name }
        if (input.description) frontmatter.description = input.description
        const frontmatterStr = Object.entries(frontmatter)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\n")
        const content = `---\n${frontmatterStr}\n---\n\n${input.content}`
        yield* fs.writeWithDirs(filepath, content).pipe(Effect.orDie)
        invalidateCache()
        const result: Info = {
          name: input.name,
          description: input.description,
          location: AbsolutePath.make(filepath),
          content: input.content,
          scope: input.scope.type === "global"
            ? { type: "global" }
            : input.scope.type === "department"
              ? { type: "department", departmentCode: input.scope.departmentCode }
              : { type: "user", userID: input.scope.userID },
        }
        return result
      }),
      update: Effect.fn("SkillV2.update")(function* (input) {
        const all = yield* list()
        const existing = all.find((s) => s.name === input.name)
        if (!existing) return yield* new NotFoundError({ name: input.name, message: `Skill not found: ${input.name}` })
        const content = yield* fs.readFileStringSafe(existing.location)
        if (!content) return yield* new NotFoundError({ name: input.name, message: `Skill file not found: ${input.name}` })
        const markdown = ConfigMarkdown.parseOption(content)
        if (!markdown) return yield* new NotFoundError({ name: input.name, message: `Invalid skill file: ${input.name}` })
        const updatedFrontmatter = { ...markdown.data }
        if (input.description !== undefined) updatedFrontmatter.description = input.description
        const frontmatterStr = Object.entries(updatedFrontmatter)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\n")
        const newContent = input.content !== undefined ? input.content : markdown.content
        const fileContent = `---\n${frontmatterStr}\n---\n\n${newContent}`
        yield* fs.writeFileString(existing.location, fileContent).pipe(Effect.orDie)
        invalidateCache()
        return {
          ...existing,
          description: input.description ?? existing.description,
          content: newContent,
        }
      }),
      remove: Effect.fn("SkillV2.remove")(function* (name) {
        const all = yield* list()
        const existing = all.find((s) => s.name === name)
        if (!existing) return yield* new NotFoundError({ name, message: `Skill not found: ${name}` })
        const dir = path.dirname(existing.location)
        yield* fs.remove(dir, { recursive: true, force: true }).pipe(Effect.orDie)
        invalidateCache()
      }),
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [SkillDiscovery.node, FSUtil.node] })
