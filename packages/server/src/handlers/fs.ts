import { FileSystem } from "@opencode-ai/core/filesystem"
import { RelativePath } from "@opencode-ai/core/schema"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Location } from "@opencode-ai/core/location"
import { Effect, Schema, Scope } from "effect"
import { HttpServerRequest, HttpServerResponse, Multipart } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024 // 10MB

// Multipart body: a single file field.
const FileUploadSchema = Schema.Struct({ file: Multipart.PersistedFileSchema })

/** Extract the path after /api/fs/upload/ from the raw request URL. */
function uploadedPathFromUrl(rawUrl: string): string {
  const prefix = "/api/fs/upload/"
  // Raw URL looks like "/api/fs/upload/uploads%2Freport.xlsx"
  return decodeURIComponent(new URL(rawUrl, "http://localhost").pathname.slice(prefix.length))
}

/** Sanitize a raw filename: reject path separators, traversal, and absolute paths. */
function sanitizeName(raw: string): string | undefined {
  const name = raw.trim()
  if (!name) return undefined
  // Reject empty, separators, traversal, null bytes
  if (name === "." || name === "..") return undefined
  if (/[\/\\\0]/.test(name)) return undefined
  if (name.startsWith("/") || name.startsWith("\\")) return undefined
  return name
}

/** Split "report.xlsx" -> ["report", ".xlsx"]; handles no-extension and dotfiles. */
function splitExt(name: string): [string, string] {
  const dot = name.lastIndexOf(".")
  if (dot <= 0) return [name, ""]
  return [name.slice(0, dot), name.slice(dot)]
}

/** Given an existing list of names, find the first free versioned name. */
function nextVersion(name: string, existing: ReadonlySet<string>): string {
  if (!existing.has(name)) return name
  const [base, ext] = splitExt(name)
  let i = 1
  while (true) {
    const candidate = `${base}-${i}${ext}`
    if (!existing.has(candidate)) return candidate
    i++
  }
}

export const FileSystemHandler = HttpApiBuilder.group(Api, "server.fs", (handlers) =>
  Effect.gen(function* () {
    return handlers
      .handleRaw("fs.read", (ctx) =>
        Effect.gen(function* () {
          const file = yield* (yield* FileSystem.Service).read({
            path: RelativePath.make(
              decodeURIComponent(new URL(ctx.request.url, "http://localhost").pathname.slice(13)),
            ),
          })
          return HttpServerResponse.uint8Array(file.content, { contentType: file.mime })
        }),
      )
      .handle("fs.list", (ctx) =>
        response(
          Effect.gen(function* () {
            const fs = yield* FileSystem.Service
            return yield* fs.list(ctx.query)
          }),
        ),
      )
      .handle("fs.find", (ctx) =>
        response(
          Effect.gen(function* () {
            const fs = yield* FileSystem.Service
            return yield* fs.find(ctx.query)
          }),
        ),
      )
      .handleRaw("fs.upload", (ctx) => upload(ctx.request))
      .handle(
        "fs.uploaded",
        Effect.fn(function* () {
          const fs = yield* FSUtil.Service
          const location = yield* Location.Service
          const uploadsDir = `${location.directory}/uploads`
          const entries = yield* fs
            .readDirectoryEntries(uploadsDir)
            .pipe(Effect.catch(() => Effect.succeed([] as FSUtil.DirEntry[])))
          const files = entries
            .filter((e) => e.type === "file")
            .map((e) => ({ name: e.name, path: `uploads/${e.name}` }))
            .toSorted((a, b) => a.name.localeCompare(b.name))
          return response(Effect.succeed(files))
        }),
      )
      .handleRaw("fs.uploadRemove", (ctx) => removeUpload(ctx.request.url))
  }),
)

function upload(request: HttpServerRequest.HttpServerRequest) {
  return Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const location = yield* Location.Service
    const uploadsDir = `${location.directory}/uploads`

    // Parse multipart, persisting the file to a scoped temp path. The 10MB limit
    // is enforced by the parser (MaxFileSize); a too-large file surfaces as a
    // MultipartError with reason "FileTooLarge".
    const parsed = yield* HttpServerRequest.schemaBodyMultipart(FileUploadSchema).pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, request),
      Effect.provideService(Multipart.MaxFileSize, MAX_UPLOAD_BYTES),
      Effect.provide(Scope.layer),
      Effect.either,
    )

    if (Effect.isFailure(parsed)) {
      const error = parsed.cause
      const tooLarge =
        error?._tag === "MultipartError" && error.reason?._tag === "FileTooLarge"
      return HttpServerResponse.json(
        { error: tooLarge ? "File exceeds 10MB limit" : "Failed to parse upload" },
        { status: tooLarge ? 413 : 400 },
      )
    }
    const { file } = parsed.value

    // Sanitize the original filename.
    const safeName = sanitizeName(file.name)
    if (!safeName) {
      yield* fs.remove(file.path, { force: true, recursive: true }).pipe(Effect.ignore)
      return HttpServerResponse.json({ error: "Invalid file name" }, { status: 400 })
    }

    // Ensure uploads dir and pick a versioned target name.
    yield* fs.ensureDir(uploadsDir).pipe(Effect.orDie)
    const existingNames = yield* fs
      .readDirectoryEntries(uploadsDir)
      .pipe(Effect.catch(() => Effect.succeed([] as FSUtil.DirEntry[])))
    const existing = new Set(existingNames.map((e) => e.name))
    const finalName = nextVersion(safeName, existing)

    // Copy persisted temp file into uploads.
    const bytes = yield* fs.readFile(file.path).pipe(Effect.orDie)
    const finalAbs = `${uploadsDir}/${finalName}`
    yield* fs.writeWithDirs(finalAbs, bytes).pipe(Effect.orDie)

    // Clean up the persisted temp file.
    yield* fs.remove(file.path, { force: true, recursive: true }).pipe(Effect.ignore)

    return HttpServerResponse.json({
      data: { name: finalName, path: `uploads/${finalName}` },
    })
  })
}

function removeUpload(rawUrl: string) {
  return Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const location = yield* Location.Service
    const uploadedPath = uploadedPathFromUrl(rawUrl)
    const uploadsDir = `${location.directory}/uploads`

    // Resolve and ensure the target stays inside uploads.
    const target = `${uploadsDir}/${uploadedPath}`
    if (!FSUtil.contains(uploadsDir, target)) {
      return HttpServerResponse.json({ error: "Invalid path" }, { status: 400 })
    }
    const exists = yield* fs.existsSafe(target)
    if (!exists) {
      return HttpServerResponse.json({ error: "File not found" }, { status: 404 })
    }
    yield* fs.remove(target, { force: true, recursive: true }).pipe(Effect.orDie)
    return HttpServerResponse.empty({ status: 204 })
  })
}