import { FileSystem } from "@opencode-ai/core/filesystem"
import { RelativePath } from "@opencode-ai/core/schema"
import { Effect, Schema, Stream } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import * as Multipart from "effect/unstable/http/Multipart"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"

const MAX_UPLOAD_SIZE = 10 * 1024 * 1024

const UploadOk = Schema.Struct({ data: Schema.Struct({ path: Schema.String, name: Schema.String }) })

function toErrorResponse(e: unknown): HttpServerResponse.HttpServerResponse {
  if (e instanceof Multipart.MultipartError) {
    const status = e.reason._tag === "FileTooLarge" ? 413 : 400
    return HttpServerResponse.text("invalid multipart body", { status })
  }
  if (e instanceof FileSystem.UploadError) {
    const status = e.reason === "unsafe" ? 400 : 404
    return HttpServerResponse.text("invalid file name", { status })
  }
  return HttpServerResponse.text("upload failed", { status: 400 })
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
      .handleRaw("fs.upload", (ctx) =>
        Effect.provideService(Multipart.MaxFileSize, MAX_UPLOAD_SIZE)(
          Effect.gen(function* () {
            const parts = yield* Stream.runCollect(ctx.request.multipartStream)
            const file = parts.find(
              (part): part is Multipart.File => Multipart.isFile(part) && part.key === "file",
            )
            if (!file) return yield* Effect.fail(Multipart.MultipartError.fromReason("Parse"))
            const content = yield* file.contentEffect
            const fs = yield* FileSystem.Service
            const result = yield* fs.upload({ name: file.name, content })
            return yield* HttpServerResponse.schemaJson(UploadOk)(
              { data: { path: result.path, name: result.name } },
              { status: 201 },
            )
          }).pipe(Effect.catch((e) => Effect.succeed(toErrorResponse(e)))),
        ),
      )
      .handle("fs.uploaded", (ctx) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.Service
          return { data: yield* fs.listUploads() }
        }),
      )
      .handleRaw("fs.deleteUpload", (ctx) =>
        Effect.gen(function* () {
          const name = decodeURIComponent(
            new URL(ctx.request.url, "http://localhost").pathname.slice("/api/fs/upload/".length),
          )
          const fs = yield* FileSystem.Service
          return yield* fs.deleteUpload({ name }).pipe(
            Effect.matchEffect({
              onSuccess: () => Effect.succeed(HttpServerResponse.empty()),
              onFailure: (e) => Effect.succeed(toErrorResponse(e)),
            }),
          )
        }),
      )
  }),
)