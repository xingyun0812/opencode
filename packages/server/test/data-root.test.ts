import { describe, expect, test } from "bun:test"
import path from "path"
import os from "os"

// Test the REAL workspacePath shipped in @opencode-ai/core (re-exported by
// @opencode-ai/server/data-root) and the real DataRootConfig module, not a
// local replica, so the tests stay in sync with the shipped implementation.
const { workspacePath: actualWorkspacePath } = await import("@opencode-ai/server/data-root")

import { DataRoot } from "@opencode-ai/server/data-root"
import { deriveDefaultLocation } from "@opencode-ai/server/handlers/session"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { UserContext } from "@opencode-ai/schema/user-context"
import { Effect } from "effect"

// encodeURIComponent leaves ".", "@", "-", "_", "!", "~", "*", "(", ")"
// unencoded. The sanitizer additionally neutralizes literal dots to "%2E"
// and every separator ("/", "\\") to its percent-encoding, so no traversal
// sequence survives to path.join and distinct userIDs map to distinct dirs.
const sanitizePart = (userID: string) => encodeURIComponent(userID).replaceAll(".", "%2E")

describe("userID sanitization", () => {
  test("normal userID unchanged", () => {
    const result = actualWorkspacePath("user-abc-123", "/data")
    expect(result).toBe("/data/workspaces/user-abc-123")
  })

  test("path traversal with ../ is encoded", () => {
    const result = actualWorkspacePath("../etc/passwd", "/data")
    expect(result).toBe("/data/workspaces/%2E%2E%2Fetc%2Fpasswd")
    expect(result).not.toContain("/etc/passwd")
    // No literal path separator from the userID survives to path.join.
    expect(result).not.toMatch(/\/\.\.(\/|$)/)
  })

  test("double-dot encoded and contained", () => {
    const result = actualWorkspacePath("..", "/data")
    expect(result).toBe("/data/workspaces/%2E%2E")
    expect(result).not.toContain("/../")
  })

  test("single dot cannot collapse to bare workspaces root", () => {
    const result = actualWorkspacePath(".", "/data")
    expect(result).toBe("/data/workspaces/%2E")
  })

  test("pure-dots cannot reduce to a shared bare workspaces root", () => {
    const result = actualWorkspacePath("...", "/data")
    expect(result).toBe("/data/workspaces/%2E%2E%2E")
    expect(result).not.toBe("/data/workspaces")
  })

  test("backslash separators are encoded", () => {
    const result = actualWorkspacePath("..\\..\\etc", "/data")
    // encodeURIComponent encodes "\\" as %5C; dots become %2E.
    expect(result).toBe(`/data/workspaces/${sanitizePart("..\\..\\etc")}`)
    expect(result).not.toContain("\\")
    expect(result).not.toMatch(/\.\.(\/|\\|$)/)
  })

  test("distinct userIDs never collide (dot handling preserves uniqueness)", () => {
    // Previously dot-stripping collapsed these; now each is distinct.
    expect(actualWorkspacePath("user.name", "/data")).not.toBe(actualWorkspacePath("username", "/data"))
    expect(actualWorkspacePath("a..b", "/data")).not.toBe(actualWorkspacePath("ab", "/data"))
    // Sanitizer is deterministic: the same userID always maps to the same dir.
    expect(actualWorkspacePath("user.name", "/data")).toBe(actualWorkspacePath("user.name", "/data"))
  })

  test("derived path always stays rooted under workspaces", () => {
    const root = "/data/workspaces"
    for (const id of ["user.name", "..", "...", "a..b", "../etc/passwd", "user name@company"]) {
      const p = actualWorkspacePath(id, "/data")
      expect(p.startsWith(root + path.sep)).toBe(true)
    }
  })

  test("URL unsafe characters are encoded", () => {
    const result = actualWorkspacePath("user name@company", "/data")
    expect(result).toBe("/data/workspaces/user%20name%40company")
  })

  test("null byte encoded", () => {
    const result = actualWorkspacePath("user\0malicious", "/data")
    expect(result).toBe("/data/workspaces/user%00malicious")
  })

  test("unicode characters encoded", () => {
    const result = actualWorkspacePath("用户123", "/data")
    expect(result).toContain("workspaces/")
    expect(result).not.toContain("用户123")
  })
})

describe("workspace directory structure", () => {
  test("appends workspaces subdirectory", () => {
    const result = actualWorkspacePath("user1", "/data")
    expect(result).toBe("/data/workspaces/user1")
  })

  test("works with XDG-style path", () => {
    const result = actualWorkspacePath("user1", path.join(os.homedir(), ".local", "share", "opencode"))
    expect(result).toContain("/workspaces/user1")
  })

  test("empty userID throws", () => {
    expect(() => actualWorkspacePath("", "/data")).toThrow("userID must not be empty")
  })
})

describe("DataRootConfig", () => {
  async function readConfig(envValue: string | undefined): Promise<string> {
    const prev = process.env.OPENCODE_DATA_ROOT
    process.env.OPENCODE_DATA_ROOT = envValue
    try {
      // Dynamic import inside a fresh module scope to avoid cached env snapshots
      const { DataRoot } = await import("@opencode-ai/server/data-root")
      const { Effect } = await import("effect")

      return await Effect.provide(
        Effect.flatMap(DataRoot.DataRootConfig, (root) => Effect.succeed(root)),
        DataRoot.DataRootConfig.layer,
      ).pipe(Effect.runPromise)
    } finally {
      if (prev === undefined) delete process.env.OPENCODE_DATA_ROOT
      else process.env.OPENCODE_DATA_ROOT = prev
    }
  }

  test("OPENCODE_DATA_ROOT set uses configured path", async () => {
    const result = await readConfig("/custom/data")
    expect(result).toBe("/custom/data")
  })

  test("OPENCODE_DATA_ROOT unset uses Global.Path.data", async () => {
    const { Global } = await import("@opencode-ai/core/global")
    const result = await readConfig(undefined)
    expect(result).toBe(Global.Path.data)
  })
})

// ─── deriveDefaultLocation / mkdir failure → 503 ──────────────────
//
// session.create derives the default directory on the server. A failure to
// create the per-user workspace is a transient infrastructure condition the
// PRD maps to HTTP 503 (ServiceUnavailableError), NOT a defect (500).

import { ServiceUnavailableError } from "@opencode-ai/protocol/errors"

/** A full UserContext.Info shaped for a plain user in tests. */
const userCtx = (userID: string): UserContext.Info => ({
  userID,
  username: userID,
  role: "user",
  permissions: [],
})

/** An FSUtil.Service stub exposing a controllable ensureDir (matches the interface's (path) => Effect<void, Error>). */
const fakeFSUtil = (ensureDir: (path: string) => Effect.Effect<void, Error>) =>
  ({ ensureDir }) as unknown as FSUtil.Interface

/** Run an effect after providing the DataRootConfig + FSUtil services required by deriveDefaultLocation. */
const runWithServices = <A, E>(program: Effect.Effect<A, E, DataRoot.DataRootConfig | FSUtil.Service>) =>
  Effect.provideService(
    Effect.provideService(program, DataRoot.DataRootConfig, "/data"),
    FSUtil.Service,
    fakeFSUtil(() => Effect.void),
  ).pipe(Effect.runPromise) as Promise<A>

describe("deriveDefaultLocation mkdir failure", () => {
  test("mkdir failure maps to ServiceUnavailableError (503), not a defect", async () => {
    const program = Effect.provideService(
      Effect.provideService(
        deriveDefaultLocation(userCtx("user-1")).pipe(Effect.flip),
        DataRoot.DataRootConfig,
        "/data",
      ),
      FSUtil.Service,
      fakeFSUtil(() => Effect.fail(new Error("EACCES: permission denied"))),
    )
    const error = await program.pipe(Effect.runPromise)

    expect(error).toBeInstanceOf(ServiceUnavailableError)
  })

  test("no UserContext keeps process.cwd() default and skips mkdir", async () => {
    const dir = await runWithServices(deriveDefaultLocation(undefined))
    expect(dir.directory).toBe(process.cwd())
  })

  test("UserContext defaults to <data_root>/workspaces/<safe_userID>", async () => {
    const dir = await runWithServices(deriveDefaultLocation(userCtx("user-1")))
    expect(dir.directory).toBe("/data/workspaces/user-1")
  })

  test("UserContext with weird userID still yields a rooted, distinct dir", async () => {
    const dir = await runWithServices(deriveDefaultLocation(userCtx("user.name")))
    expect(dir.directory).toBe("/data/workspaces/user%2Ename")
    expect(dir.directory.startsWith("/data/workspaces/")).toBe(true)
  })
})
