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
      query: LocationQuery,
      success: Schema.Struct({ data: Schema.Struct({ path: Schema.String, name: Schema.String }) }),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.fs.upload",
          summary: "Upload file",
          description: "Upload one file into the uploads directory of the requested location.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("fs.uploaded", "/api/fs/uploaded", {
      query: LocationQuery,
      success: Schema.Struct({ data: Schema.Array(FileSystem.UploadEntry) }),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.fs.uploaded",
          summary: "List uploaded files",
          description: "List files in the uploads directory of the requested location.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.delete("fs.deleteUpload", "/api/fs/upload/*", {
      query: LocationQuery,
      success: Schema.Void,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.fs.deleteUpload",
          summary: "Delete uploaded file",
          description: "Delete one file from the uploads directory of the requested location.",
        }),
      ),
  )
