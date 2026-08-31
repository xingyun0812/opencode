export * as FileSystem from "./filesystem"

import { makeLocationNode } from "./effect/app-node"
import path from "path"
import { Context, Data, Effect, Layer, Schema } from "effect"
import { FSUtil } from "./fs-util"
import { Location } from "./location"
import { PositiveInt, RelativePath } from "./schema"
import { FileSystemSearch } from "./filesystem/search"
import { Entry, FileSystem, FindInput, Match, UploadEntry } from "@opencode-ai/schema/filesystem"
export { Entry, Match, Submatch } from "@opencode-ai/schema/filesystem"

export const ReadInput = Schema.Struct({
  path: RelativePath,
})
export type ReadInput = typeof ReadInput.Type

export const Content = Schema.Struct({
  uri: Schema.String,
  name: Schema.String.pipe(Schema.optional),
  content: Schema.String,
  encoding: Schema.Literals(["utf8", "base64"]),
  mime: Schema.String,
}).annotate({ identifier: "FileSystem.Content" })
export type Content = typeof Content.Type

export const ListInput = Schema.Struct({
  path: RelativePath.pipe(Schema.optional),
})
export type ListInput = typeof ListInput.Type

export { FindInput }

export class GlobInput extends Schema.Class<GlobInput>("FileSystem.GlobInput")({
  pattern: Schema.String,
  path: RelativePath.pipe(Schema.optional),
  limit: PositiveInt.pipe(Schema.optional),
}) {}

export class GrepInput extends Schema.Class<GrepInput>("FileSystem.GrepInput")({
  pattern: Schema.String,
  path: RelativePath.pipe(Schema.optional),
  include: Schema.String.pipe(Schema.optional),
  limit: PositiveInt.pipe(Schema.optional),
}) {}

export const Event = FileSystem.Event

export class UploadError extends Data.TaggedError("UploadError")<{
  readonly reason: "unsafe" | "not-found"
}> {}

function versionName(name: string, version: number) {
  const dot = name.lastIndexOf(".")
  return dot <= 0 ? `${name}-${version}` : `${name.slice(0, dot)}-${version}${name.slice(dot)}`
}

export interface Interface {
  readonly read: (input: ReadInput) => Effect.Effect<{ readonly content: Uint8Array; readonly mime: string }>
  readonly list: (input?: ListInput) => Effect.Effect<Entry[]>
  readonly find: (input: FindInput) => Effect.Effect<Entry[]>
  readonly glob: (input: GlobInput) => Effect.Effect<readonly Entry[]>
  readonly grep: (input: GrepInput) => Effect.Effect<readonly Match[]>
  readonly upload: (input: { readonly name: string; readonly content: Uint8Array }) => Effect.Effect<
    { readonly path: string; readonly name: string },
    UploadError
  >
  readonly listUploads: () => Effect.Effect<UploadEntry[]>
  readonly deleteUpload: (input: { readonly name: string }) => Effect.Effect<void, UploadError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/FileSystem") {}

const baseLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const location = yield* Location.Service
    const search = yield* FileSystemSearch.Service
    const root = yield* fs.realPath(location.directory).pipe(Effect.orDie)
    const resolve = Effect.fnUntraced(function* (input?: RelativePath) {
      const absolute = path.resolve(location.directory, input ?? ".")
      if (!FSUtil.contains(location.directory, absolute))
        return yield* Effect.die(new Error("Path escapes the location"))
      const real = yield* fs.realPath(absolute).pipe(Effect.orDie)
      if (!FSUtil.contains(root, real)) return yield* Effect.die(new Error("Path escapes the location"))
      return { absolute, real, directory: location.directory, root }
    })
    return Service.of({
      find: search.find,
      glob: search.glob,
      grep: search.grep,
      read: Effect.fn("FileSystem.read")(function* (input) {
        const target = yield* resolve(input.path)
        const info = yield* fs.stat(target.real).pipe(Effect.orDie)
        if (info.type !== "File") return yield* Effect.die(new Error("Path is not a file"))
        return {
          content: yield* fs.readFile(target.real).pipe(Effect.orDie),
          mime: FSUtil.mimeType(target.real),
        }
      }),
      list: Effect.fn("FileSystem.list")(function* (input = {}) {
        const target = yield* resolve(input.path)
        const info = yield* fs.stat(target.real).pipe(Effect.orDie)
        if (info.type !== "Directory") return yield* Effect.die(new Error("Path is not a directory"))
        return yield* fs.readDirectoryEntries(target.real).pipe(
          Effect.orDie,
          Effect.map((items) =>
            items
              .flatMap((item) => {
                if (item.type !== "file" && item.type !== "directory") return []
                const absolute = path.join(target.absolute, item.name)
                const relative = path.relative(target.directory, absolute)
                return [
                  Entry.make({
                    path: RelativePath.make(relative + (item.type === "directory" ? path.sep : "")),
                    type: item.type,
                  }),
                ]
              })
              .sort((a, b) => (a.type === b.type ? a.path.localeCompare(b.path) : a.type === "directory" ? -1 : 1)),
          ),
        )
      }),
      upload: Effect.fn("FileSystem.upload")(function* (input) {
        const uploadsDir = path.join(location.directory, "uploads")
        const absolute = path.join(uploadsDir, input.name)
        const unsafe =
          input.name.length === 0 ||
          path.isAbsolute(input.name) ||
          input.name.includes("/") ||
          input.name.includes("\\") ||
          !FSUtil.contains(uploadsDir, absolute)
        if (unsafe) return yield* Effect.fail(new UploadError({ reason: "unsafe" }))
        let version = 1
        let candidate = input.name
        while (yield* fs.existsSafe(path.join(uploadsDir, candidate))) {
          candidate = versionName(input.name, version)
          version += 1
        }
        yield* fs.ensureDir(uploadsDir).pipe(Effect.orDie)
        yield* fs.writeFile(path.join(uploadsDir, candidate), input.content).pipe(Effect.orDie)
        return { path: path.join("uploads", candidate), name: candidate }
      }),
      listUploads: Effect.fn("FileSystem.listUploads")(function* () {
        const uploadsDir = path.join(location.directory, "uploads")
        if (!(yield* fs.existsSafe(uploadsDir))) return []
        const items = yield* fs.readDirectoryEntries(uploadsDir).pipe(Effect.orDie)
        return items
          .filter((item) => item.type === "file")
          .map((item) => UploadEntry.make({ name: item.name, path: path.join("uploads", item.name) }))
          .sort((a, b) => a.name.localeCompare(b.name))
      }),
      deleteUpload: Effect.fn("FileSystem.deleteUpload")(function* (input) {
        const uploadsDir = path.join(location.directory, "uploads")
        const absolute = path.join(uploadsDir, input.name)
        const unsafe =
          input.name.length === 0 ||
          path.isAbsolute(input.name) ||
          input.name.includes("/") ||
          input.name.includes("\\") ||
          !FSUtil.contains(uploadsDir, absolute)
        if (unsafe) return yield* Effect.fail(new UploadError({ reason: "unsafe" }))
        if (!(yield* fs.existsSafe(absolute))) return yield* Effect.fail(new UploadError({ reason: "not-found" }))
        yield* fs.remove(absolute).pipe(Effect.orDie)
      }),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer: baseLayer,
  deps: [FSUtil.node, Location.node, FileSystemSearch.node],
})
