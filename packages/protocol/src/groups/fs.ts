import { FileSystem } from "@opencode-ai/schema/filesystem"
import { Location } from "@opencode-ai/schema/location"
import { PositiveInt, RelativePath } from "@opencode-ai/schema/schema"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { LocationQuery, locationQueryOpenApi } from "./location"

const ListQuery = Schema.Struct({
  ...LocationQuery.fields,
  path: RelativePath.pipe(Schema.optional),
})

const FindQuery = Schema.Struct({
  ...LocationQuery.fields,
  query: FileSystem.FindInput.fields.query,
  type: FileSystem.FindInput.fields.type,
  limit: Schema.NumberFromString.pipe(Schema.decodeTo(PositiveInt), Schema.optional),
})

export interface UploadedFile extends Schema.Schema.Type<typeof UploadedFile> {}
export const UploadedFile = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
}).annotate({ identifier: "UploadedFile" })

export const FileSystemGroup = HttpApiGroup.make("server.fs")
  .add(
    HttpApiEndpoint.get("fs.read", "/api/fs/read/*", {
      query: LocationQuery,
      success: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.fs.read",
          summary: "Read file",
          description: "Serve one file relative to the requested location.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("fs.list", "/api/fs/list", {
      query: ListQuery,
      success: Location.response(Schema.Array(FileSystem.Entry)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.fs.list",
          summary: "List directory",
          description: "List direct children of one directory relative to the requested location.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("fs.find", "/api/fs/find", {
      query: FindQuery,
      success: Location.response(Schema.Array(FileSystem.Entry)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.fs.find",
          summary: "Find files",
          description: "Find recursively ranked filesystem entries relative to the requested location.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("fs.upload", "/api/fs/upload", {
      success: Schema.Struct({ data: UploadedFile }),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.fs.upload",
        summary: "Upload file",
        description:
          "Upload a file via multipart/form-data to the authenticated user's uploads directory. Returns the relative path of the stored file.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("fs.uploaded", "/api/fs/uploaded", {
      query: LocationQuery,
      success: Location.response(Schema.Array(UploadedFile)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.fs.uploaded",
          summary: "List uploaded files",
          description: "List the authenticated user's uploaded files (including versioned names).",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.delete("fs.uploadRemove", "/api/fs/upload/*", {
      success: HttpApiSchema.NoContent,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.fs.uploadRemove",
        summary: "Delete uploaded file",
        description: "Delete one of the authenticated user's uploaded files.",
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "filesystem",
      description: "Location-scoped filesystem routes including upload.",
    }),
  )
