import { SkillV2 } from "@opencode-ai/core/skill"
import { UserContext } from "@opencode-ai/schema/user-context"
import { Location } from "@opencode-ai/core/location"
import { Effect, Option } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"
import { ForbiddenError, InvalidRequestError } from "@opencode-ai/protocol/errors"
import { SkillNotFoundError, SkillNameConflictError } from "@opencode-ai/protocol/groups/skill"

// Scope-access + identity resolution live in core so the HTTP handler and the
// conversation tool share one implementation. They raise core-owned errors
// (`SkillV2.ForbiddenError` / `ConflictError` / `InvalidNameError`); this
// handler maps them to the protocol error shapes the HTTP API exposes.
const { checkScopeAccess, resolveCreateScope, ConflictError: SkillConflictError, InvalidNameError: SkillInvalidNameError } = SkillV2

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
          const enforcedScope = yield* resolveCreateScope(userContext, ctx.payload.scope).pipe(
            Effect.mapError((err) => new ForbiddenError({ message: err.message })),
          )

          yield* checkScopeAccess(userContext, enforcedScope).pipe(
            Effect.mapError((err) => new ForbiddenError({ message: err.message })),
          )

          // core `create` raises ConflictError (same name) / InvalidNameError
          // (bad name); map to the protocol shapes the HTTP API exposes.
          const result = yield* SkillV2.Service.use((skill) =>
            skill.create({
              name: ctx.payload.name,
              description: ctx.payload.description,
              content: ctx.payload.content,
              scope: enforcedScope,
              skillsRoot,
            }),
          ).pipe(
            Effect.mapError((err): ForbiddenError | SkillNameConflictError | InvalidRequestError => {
              if (err instanceof SkillConflictError) {
                return new SkillNameConflictError({ name: err.name, message: err.message })
              }
              if (err instanceof SkillInvalidNameError) {
                return new InvalidRequestError({ message: err.message })
              }
              // `ConflictError | InvalidNameError` are exhausted above; this is
              // a defensive fallback for any future core error type.
              return new ForbiddenError({ message: "Failed to create skill" })
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
          }).pipe(Effect.mapError((err) => new ForbiddenError({ message: err.message })))

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
          }).pipe(Effect.mapError((err) => new ForbiddenError({ message: err.message })))

          yield* SkillV2.Service.use((skill) => skill.remove(ctx.params.name))
          return HttpApiSchema.NoContent.make()
        }),
      )
  }),
)