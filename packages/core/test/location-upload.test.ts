import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { it } from "./lib/effect"

const provide = (directory: string) =>
  Effect.provide(
    LayerNode.compile(FileSystem.node, [
      [
        Location.node,
        Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }))),
      ],
    ]),
  )

const withTmp = <A, E, R>(f: (directory: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(Effect.flatMap((tmp) => f(tmp.path)))

const bytes = (input: string) => new TextEncoder().encode(input)

const read = (directory: string, relative: string) =>
  Effect.promise(async () => new Uint8Array(await fs.readFile(path.join(directory, relative))))

const outcome = <M, E>(effect: Effect.Effect<M, E, never>) =>
  effect.pipe(
    Effect.match({
      onSuccess: () => ({ tag: "ok" as const }),
      onFailure: (error) => ({ tag: "error" as const, error }),
    }),
  )

describe("FileSystem upload", () => {
  it.live("uploads a new file into uploads/", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const service = yield* FileSystem.Service
        const result = yield* service.upload({ name: "report.xlsx", content: bytes("hello") })
        expect(result).toEqual({ path: "uploads/report.xlsx", name: "report.xlsx" })
        const written = yield* read(directory, "uploads/report.xlsx")
        expect(new TextDecoder().decode(written)).toBe("hello")
      }).pipe(provide(directory)),
    ),
  )

  it.live("versions a duplicate name before the extension", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const service = yield* FileSystem.Service
        yield* service.upload({ name: "report.xlsx", content: bytes("v1") })
        const second = yield* service.upload({ name: "report.xlsx", content: bytes("v2") })
        expect(second).toEqual({ path: "uploads/report-1.xlsx", name: "report-1.xlsx" })
        const original = yield* read(directory, "uploads/report.xlsx")
        const versioned = yield* read(directory, "uploads/report-1.xlsx")
        expect(new TextDecoder().decode(original)).toBe("v1")
        expect(new TextDecoder().decode(versioned)).toBe("v2")
      }).pipe(provide(directory)),
    ),
  )

  it.live("versions a duplicate name without an extension by appending -1", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const service = yield* FileSystem.Service
        yield* service.upload({ name: "notes", content: bytes("a") })
        const second = yield* service.upload({ name: "notes", content: bytes("b") })
        expect(second).toEqual({ path: "uploads/notes-1", name: "notes-1" })
      }).pipe(provide(directory)),
    ),
  )

  it.live("preserves binary content exactly", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const binary = new Uint8Array([0, 255, 1, 2, 3])
        const service = yield* FileSystem.Service
        yield* service.upload({ name: "data.bin", content: binary })
        const written = yield* read(directory, "uploads/data.bin")
        expect(written).toEqual(binary)
      }).pipe(provide(directory)),
    ),
  )

  it.live("rejects path traversal in the file name", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const service = yield* FileSystem.Service
        for (const name of ["../evil.txt", "/etc/passwd", "a/b.txt", "a\\b.txt", ""]) {
          const result = yield* outcome(service.upload({ name, content: bytes("x") }))
          expect(result.tag).toBe("error")
          if (result.tag === "error") expect(result.error.reason).toBe("unsafe")
        }
      }).pipe(provide(directory)),
    ),
  )

  it.live("lists uploaded versions sorted by name", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const service = yield* FileSystem.Service
        yield* service.upload({ name: "b.txt", content: bytes("1") })
        yield* service.upload({ name: "a.txt", content: bytes("2") })
        yield* service.upload({ name: "b.txt", content: bytes("3") })
        const uploaded = yield* service.listUploads()
        expect(uploaded.map((entry) => ({ name: entry.name, path: entry.path }))).toEqual([
          { name: "a.txt", path: "uploads/a.txt" },
          { name: "b-1.txt", path: "uploads/b-1.txt" },
          { name: "b.txt", path: "uploads/b.txt" },
        ])
      }).pipe(provide(directory)),
    ),
  )

  it.live("returns an empty list when nothing has been uploaded", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const uploaded = yield* (yield* FileSystem.Service).listUploads()
        expect(uploaded).toEqual([])
      }).pipe(provide(directory)),
    ),
  )

  it.live("deletes an existing uploaded file", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const service = yield* FileSystem.Service
        yield* service.upload({ name: "report.xlsx", content: bytes("x") })
        yield* service.deleteUpload({ name: "report.xlsx" })
        const uploaded = yield* service.listUploads()
        expect(uploaded).toEqual([])
      }).pipe(provide(directory)),
    ),
  )

  it.live("fails with not-found when deleting a missing file", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const result = yield* outcome((yield* FileSystem.Service).deleteUpload({ name: "missing.txt" }))
        expect(result.tag).toBe("error")
        if (result.tag === "error") expect(result.error.reason).toBe("not-found")
      }).pipe(provide(directory)),
    ),
  )

  it.live("rejects path traversal when deleting", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        for (const name of ["../evil.txt", "/etc/passwd", "a/b.txt", ""]) {
          const result = yield* outcome((yield* FileSystem.Service).deleteUpload({ name }))
          expect(result.tag).toBe("error")
          if (result.tag === "error") expect(result.error.reason).toBe("unsafe")
        }
      }).pipe(provide(directory)),
    ),
  )
})