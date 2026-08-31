export * as AuthToken from "./auth-token"

import { Context, Schema } from "effect"

/**
 * The current user's raw Bearer credential, as resolved by the auth middleware
 * from the inbound `Authorization: Bearer <jwt>` header. Distinct from
 * {@link UserContext} (which is the decoded identity claim): this carries the
 * raw token so outbound tools can re-attach it when calling business backends
 * on the user's behalf.
 *
 * Wrapped in `Redacted` so the secret never leaks through logs, model output,
 * or schema serialization. Tools read it via `Effect.serviceOption(AuthToken.Service)`
 * — it is `Some` only during an authenticated (JWT Bearer) session, and `None`
 * for unauthenticated or Basic-Auth requests.
 */
export const Value = Schema.Struct({
  token: Schema.Redacted(Schema.String),
}).annotate({ identifier: "AuthToken.Value" })

export interface Value extends Schema.Schema.Type<typeof Value> {}

export class Service extends Context.Service<Service, Value>()("@opencode/AuthToken") {}
