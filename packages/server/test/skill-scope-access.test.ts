import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { ForbiddenError } from "@opencode-ai/protocol/errors"
import type { UserContext } from "@opencode-ai/schema/user-context"
import { checkScopeAccess, resolveCreateScope } from "@opencode-ai/server/handlers/skill"

// `checkScopeAccess` is a pure function over (UserContext | undefined, scope)
// → Effect<void, ForbiddenError>. These tests exercise the scope-access rules
// directly, asserting external authorization behavior rather than internal
// call structure.

type Scope = {
  type: "global" | "department" | "user"
  departmentCode?: string
  userID?: string
}

function user(partial: Partial<UserContext.Info> = {}): UserContext.Info {
  return {
    userID: "u1",
    username: "alice",
    departmentCode: "D1",
    role: "user",
    permissions: [],
    ...partial,
  }
}

// Run the effect and return "ok" on success, or the ForbiddenError message on
// failure. Keeps table-driven assertions readable.
async function verdict(
  userContext: UserContext.Info | undefined,
  scope: Scope,
): Promise<"ok" | string> {
  const either = await Effect.runPromise(
    checkScopeAccess(userContext, scope).pipe(
      Effect.map(() => "ok" as const),
      Effect.catchTag("ForbiddenError", (e: ForbiddenError) => Effect.succeed(e.message)),
    ),
  )
  return either
}

describe("checkScopeAccess — department scope (widened to department members)", () => {
  test("plain user (role=user) in the target department is allowed", async () => {
    expect(await verdict(user({ role: "user", departmentCode: "D1" }), { type: "department", departmentCode: "D1" })).toBe("ok")
  })

  test("dept_admin in own department is allowed", async () => {
    expect(await verdict(user({ role: "dept_admin", departmentCode: "D1" }), { type: "department", departmentCode: "D1" })).toBe("ok")
  })

  test("global_admin short-circuits any department", async () => {
    expect(await verdict(user({ role: "global_admin", departmentCode: "G" }), { type: "department", departmentCode: "D2" })).toBe("ok")
  })

  test("plain user in a different department is rejected", async () => {
    const msg = await verdict(user({ role: "user", departmentCode: "D1" }), { type: "department", departmentCode: "D2" })
    expect(msg).toBe("You can only manage skills in your own department")
  })

  test("dept_admin from another department is rejected (no cross-dept)", async () => {
    const msg = await verdict(user({ role: "dept_admin", departmentCode: "D1" }), { type: "department", departmentCode: "D2" })
    expect(msg).toBe("You can only manage skills in your own department")
  })

  test("user with no department is rejected", async () => {
    const msg = await verdict(user({ role: "user", departmentCode: undefined }), { type: "department", departmentCode: "D1" })
    expect(msg).toBe("You are not a member of any department")
  })

  test("user with no department targeting an undefined target departmentCode is still rejected", async () => {
    // This is the hole the widening must close: previously `scope.departmentCode
    // && ...` short-circuited on missing departmentCode. Now membership is
    // required first.
    const msg = await verdict(user({ role: "user", departmentCode: undefined }), { type: "department" })
    expect(msg).toBe("You are not a member of any department")
  })

  test("member with matching department but target omits departmentCode is rejected (direct call)", async () => {
    // When called directly with a missing target departmentCode, the function
    // refuses (undefined !== "D1"). The create handler avoids this by
    // overriding scope.departmentCode with the user's own identity before
    // calling, so this path only arises from a direct/misused call — and it
    // correctly does not let a missing target slip through.
    const msg = await verdict(user({ role: "user", departmentCode: "D1" }), { type: "department" })
    expect(msg).toBe("You can only manage skills in your own department")
  })
})

describe("checkScopeAccess — global scope (unchanged)", () => {
  test("global_admin allowed", async () => {
    expect(await verdict(user({ role: "global_admin" }), { type: "global" })).toBe("ok")
  })

  test("dept_admin rejected", async () => {
    expect(await verdict(user({ role: "dept_admin" }), { type: "global" })).toBe("Only global administrators can manage global skills")
  })

  test("plain user rejected", async () => {
    expect(await verdict(user({ role: "user" }), { type: "global" })).toBe("Only global administrators can manage global skills")
  })
})

describe("checkScopeAccess — user scope", () => {
  test("own userID allowed", async () => {
    expect(await verdict(user({ userID: "u1" }), { type: "user", userID: "u1" })).toBe("ok")
  })

  test("another userID rejected", async () => {
    expect(await verdict(user({ userID: "u1" }), { type: "user", userID: "u2" })).toBe("You can only manage your own personal skills")
  })
})

describe("checkScopeAccess — no user context (read-only path passthrough)", () => {
  // The function still returns Effect.void when userContext is undefined to
  // preserve the read-only list/load behavior. The create path enforces
  // identity with a caller-side gate before calling this function.
  test("undefined userContext is allowed by the function itself", async () => {
    expect(await verdict(undefined, { type: "global" })).toBe("ok")
    expect(await verdict(undefined, { type: "department", departmentCode: "D1" })).toBe("ok")
    expect(await verdict(undefined, { type: "user", userID: "u1" })).toBe("ok")
  })
})

// `resolveCreateScope` is the create-path identity-enforcement contract: it
// decides which scope is actually written, given the caller (always
// authenticated — the handler rejects undefined userContext first) and the
// requested scope. This is the core of the security fix, so it is tested
// directly rather than through the full HTTP stack.
async function resolve(
  userContext: UserContext.Info,
  requested: Scope,
): Promise<{ ok: true; scope: unknown } | { ok: false; message: string }> {
  const either = await Effect.runPromise(
    resolveCreateScope(userContext, requested).pipe(
      Effect.map((scope) => ({ ok: true as const, scope })),
      Effect.catchTag("ForbiddenError", (e: ForbiddenError) => Effect.succeed({ ok: false as const, message: e.message })),
    ),
  )
  return either
}

describe("resolveCreateScope — create-path identity enforcement", () => {
  test("plain user creating department is pinned to own departmentCode (ignores request body)", async () => {
    const res = await resolve(user({ role: "user", departmentCode: "D1" }), { type: "department", departmentCode: "D2" })
    expect(res).toEqual({ ok: true, scope: { type: "department", departmentCode: "D1" } })
  })

  test("plain user creating department without departmentCode in request still pinned to own", async () => {
    const res = await resolve(user({ role: "user", departmentCode: "D1" }), { type: "department" })
    expect(res).toEqual({ ok: true, scope: { type: "department", departmentCode: "D1" } })
  })

  test("plain user with no department is rejected", async () => {
    const res = await resolve(user({ role: "user", departmentCode: undefined }), { type: "department", departmentCode: "D1" })
    expect(res).toEqual({ ok: false, message: "You are not a member of any department" })
  })

  test("global_admin creating a foreign department keeps the requested departmentCode (regression: must not be rewired to own or rejected)", async () => {
    // global_admin may create for ANY department; do not override with their
    // own departmentCode, and do not reject when their departmentCode differs.
    const res = await resolve(user({ role: "global_admin", departmentCode: "D1" }), { type: "department", departmentCode: "D2" })
    expect(res).toEqual({ ok: true, scope: { type: "department", departmentCode: "D2" } })
  })

  test("global_admin with no department can still create a department skill (uses requested code)", async () => {
    const res = await resolve(user({ role: "global_admin", departmentCode: undefined }), { type: "department", departmentCode: "D2" })
    expect(res).toEqual({ ok: true, scope: { type: "department", departmentCode: "D2" } })
  })

  test("global_admin creating a department skill without a departmentCode is rejected (write target undefined)", async () => {
    const res = await resolve(user({ role: "global_admin", departmentCode: undefined }), { type: "department" })
    expect(res).toEqual({ ok: false, message: "Creating a department skill requires a departmentCode" })
  })

  test("creating user scope is pinned to own userID (ignores request body)", async () => {
    const res = await resolve(user({ userID: "u1" }), { type: "user", userID: "u2" })
    expect(res).toEqual({ ok: true, scope: { type: "user", userID: "u1" } })
  })

  test("creating global scope yields a clean global scope regardless of request identity fields", async () => {
    const res = await resolve(user({ role: "user" }), { type: "global" })
    expect(res).toEqual({ ok: true, scope: { type: "global" } })
  })
})
