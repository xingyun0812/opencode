import { SkillV2 } from "@opencode-ai/core/skill"
import { UserContext } from "@opencode-ai/schema/user-context"
import { Location } from "@opencode-ai/core/location"
import { Effect, Option } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"
import { ForbiddenError } from "@opencode-ai/protocol/errors"
import { SkillNotFoundError } from "@opencode-ai/protocol/groups/skill"

// ─── Scope validation ─────────────────────────────────────────────

// Exported for direct unit testing of the scope-access rules.
// Department scope is open to any member of the target department (any role),
// not restricted to `dept_admin`. `global_admin` still short-circuits to allow.
export function checkScopeAccess(
  userContext: UserContext.Info | undefined,
  scope: { type: "global" | "department" | "user"; departmentCode?: string; userID?: string },
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
      // `userContext` is present (the `if (!userContext)` branch above handles
      // absence), so userID — non-optional on UserContext.Info — always exists.
      // Guard only against a scope targeting someone else.
      if (scope.userID !== undefined && scope.userID !== userContext.userID) {
        return Effect.fail(new ForbiddenError({ message: "You can only manage your own personal skills" }))
      }
      return Effect.void
  }
}

// The scope the create path will actually write, with identity enforced from
// UserContext for ordinary users. `global_admin` keeps the requested scope (it
// may create for any department, so its departmentCode comes from the request).
// Exported so the enforce-identity contract is unit-tested without mounting the
// full HTTP handler stack.
export function resolveCreateScope(
  userContext: UserContext.Info,
  requested: { type: "global" | "department" | "user"; departmentCode?: string; userID?: string },
): Effect.Effect<
  { type: "global" } | { type: "department"; departmentCode: string } | { type: "user"; userID: string },
  ForbiddenError
> {
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

export const SkillHandler = HttpApiBuilder.group(Api, "server.skill", (handlers) =>
  Effect.gen(function* () {
    return handlers
      .handle(
        "skill.list",
        () =>
          response(
            Effect.gen(function* () {
              const userContext = yield* UserContext.Service.pipe(Effect.option)
              return yield* SkillV2.Service.use((skill) => skill.list(Option.getOrUndefined(userContext)))
            }),
          ),
      )
      .handle(
        "skill.create",
        Effect.fn(function* (ctx) {
          const userContext = Option.getOrUndefined(yield* UserContext.Service.pipe(Effect.option))
          const location = yield* Location.Service
          const skillsRoot = location.directory

          // Caller-side gate: creation requires an authenticated user context.
          // `checkScopeAccess` still returns Effect.void when userContext is
          // undefined (to keep read-only list/load paths unchanged), so the
          // create path enforces identity here instead.
          if (!userContext) {
            return yield* Effect.fail(
              new ForbiddenError({ message: "Creating skills requires an authenticated user context" }),
            )
          }

          // Enforce identity from UserContext, never trusting the request body
          // for ordinary users. `global_admin` keeps the requested scope (it
          // may create for any department); everyone else is pinned to their
          // own identity. This closes the hole where omitting departmentCode
          // would short-circuit the ownership check.
          const enforcedScope = yield* resolveCreateScope(userContext, ctx.payload.scope)

          yield* checkScopeAccess(userContext, enforcedScope)

          const result = yield* SkillV2.Service.use((skill) =>
            skill.create({
              name: ctx.payload.name,
              description: ctx.payload.description,
              content: ctx.payload.content,
              scope: enforcedScope,
              skillsRoot,
            }),
          )
          return { data: result }
        }),
      )
      .handle(
        "skill.update",
        Effect.fn(function* (ctx) {
          const userContext = Option.getOrUndefined(yield* UserContext.Service.pipe(Effect.option))

          const all = yield* SkillV2.Service.use((skill) => skill.list())
          const existing = all.find((s) => s.name === ctx.params.name)
          if (!existing) {
            return yield* Effect.fail(new SkillNotFoundError({
              name: ctx.params.name,
              message: `Skill not found: ${ctx.params.name}`,
            }))
          }

          yield* checkScopeAccess(userContext, {
            type: existing.scope?.type ?? "global",
            departmentCode: existing.scope?.departmentCode,
            userID: existing.scope?.userID,
          })

          return {
            data: yield* SkillV2.Service.use((skill) =>
              skill.update({
                name: ctx.params.name,
                description: ctx.payload.description,
                content: ctx.payload.content,
              }),
            ),
          }
        }),
      )
      .handle(
        "skill.remove",
        Effect.fn(function* (ctx) {
          const userContext = Option.getOrUndefined(yield* UserContext.Service.pipe(Effect.option))

          const all = yield* SkillV2.Service.use((skill) => skill.list())
          const existing = all.find((s) => s.name === ctx.params.name)
          if (!existing) {
            return yield* Effect.fail(new SkillNotFoundError({
              name: ctx.params.name,
              message: `Skill not found: ${ctx.params.name}`,
            }))
          }

          yield* checkScopeAccess(userContext, {
            type: existing.scope?.type ?? "global",
            departmentCode: existing.scope?.departmentCode,
            userID: existing.scope?.userID,
          })

          yield* SkillV2.Service.use((skill) => skill.remove(ctx.params.name))
          return HttpApiSchema.NoContent.make()
        }),
      )
  }),
)