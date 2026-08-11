import { ServerAuth } from "@/server/auth"
import { UserContext } from "@opencode-ai/schema/user-context"
import { UnauthorizedError } from "@opencode-ai/protocol/errors"
import { ServerAuth as ServerAuthV1 } from "@opencode-ai/server/auth"
import { Effect, Encoding, Layer, Option, Redacted } from "effect"
import { HttpEffect, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiError, HttpApiMiddleware } from "effect/unstable/httpapi"
import { hasPtyConnectTicketURL } from "@/server/shared/pty-ticket"
import { isPublicUIPath } from "@/server/shared/public-ui"
export {
  Authorization as ServerAuthorization,
  authorizationLayer as serverAuthorizationLayer,
} from "@opencode-ai/server/middleware/authorization"

function extractBearerToken(request: HttpServerRequest.HttpServerRequest): string | undefined {
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.authorization ?? "")
  return match?.[1]
}

const AUTH_TOKEN_QUERY = "auth_token"
const UNAUTHORIZED = 401
const WWW_AUTHENTICATE = 'Basic realm="Secure Area"'

function base64UrlDecode(input: string): Uint8Array {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/").padEnd(input.length + ((4 - (input.length % 4)) % 4), "=")
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
}

function decodeJwtPayload(payload: string): { info: UserContext.Info; exp?: number } {
  const parsed = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload)))
  return {
    info: {
      userID: parsed.user_id ?? parsed.userId ?? parsed.sub ?? "",
      username: parsed.username ?? parsed.preferred_username ?? "",
      departmentCode: parsed.department_code ?? parsed.departmentCode ?? parsed.dept_code ?? undefined,
      role: parsed.role ?? "user",
      permissions: parsed.permissions ?? [],
    },
    exp: parsed.exp,
  }
}

function verifyJwt(token: string, secret: string): Effect.Effect<UserContext.Info, UnauthorizedError> {
  return Effect.gen(function* () {
    const parts = token.split(".")
    if (parts.length !== 3) return yield* Effect.fail(new UnauthorizedError({ message: "Invalid JWT format" }))

    const [headerB64, payloadB64, signatureB64] = parts
    const textEncoder = () => new TextEncoder()

    const key = yield* Effect.promise(() =>
      crypto.subtle.importKey("raw", textEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]),
    )

    const valid = yield* Effect.promise(() =>
      crypto.subtle.verify("HMAC", key, base64UrlDecode(signatureB64) as BufferSource, textEncoder().encode(`${headerB64}.${payloadB64}`) as BufferSource),
    )

    if (!valid) return yield* Effect.fail(new UnauthorizedError({ message: "Invalid JWT signature" }))

    const { info, exp } = decodeJwtPayload(payloadB64)
    if (exp && Date.now() / 1000 > exp) return yield* Effect.fail(new UnauthorizedError({ message: "JWT expired" }))
    if (!info.userID) return yield* Effect.fail(new UnauthorizedError({ message: "JWT missing userID" }))

    return info
  })
}

// Avoid HttpApiSecurity alternatives here: Effect security middleware wraps the
// full handler, so a downstream failure can make the next auth alternative run
// and remap an authorized NotFound into Unauthorized.
export class Authorization extends HttpApiMiddleware.Service<Authorization>()(
  "@opencode/ExperimentalHttpApiAuthorization",
  {
    error: HttpApiError.UnauthorizedNoContent,
  },
) {}

export class PtyConnectAuthorization extends HttpApiMiddleware.Service<PtyConnectAuthorization>()(
  "@opencode/ExperimentalHttpApiPtyConnectAuthorization",
  {
    error: HttpApiError.UnauthorizedNoContent,
  },
) {}

function emptyCredential() {
  return {
    username: "",
    password: Redacted.make(""),
  }
}

function validateCredential<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  credential: ServerAuth.DecodedCredentials,
  config: ServerAuth.Info,
) {
  return Effect.gen(function* () {
    if (!ServerAuth.required(config)) return yield* effect
    if (!ServerAuth.authorized(credential, config)) {
      yield* HttpEffect.appendPreResponseHandler((_request, response) =>
        Effect.succeed(HttpServerResponse.setHeader(response, "www-authenticate", WWW_AUTHENTICATE)),
      )
      return yield* new HttpApiError.Unauthorized({})
    }
    return yield* effect
  })
}

function decodeCredential(input: string) {
  return Effect.fromResult(Encoding.decodeBase64String(input)).pipe(
    Effect.match({
      onFailure: emptyCredential,
      onSuccess: (header) => {
        const separator = header.indexOf(":")
        if (separator === -1) return emptyCredential()
        return {
          username: header.slice(0, separator),
          password: Redacted.make(header.slice(separator + 1)),
        }
      },
    }),
  )
}

function credentialFromRequest(request: HttpServerRequest.HttpServerRequest) {
  return credentialFromURL(new URL(request.url, "http://localhost"), request)
}

function credentialFromURL(url: URL, request: HttpServerRequest.HttpServerRequest) {
  const token = url.searchParams.get(AUTH_TOKEN_QUERY)
  if (token) return decodeCredential(token)
  const match = /^Basic\s+(.+)$/i.exec(request.headers.authorization ?? "")
  if (match) return decodeCredential(match[1])
  return Effect.succeed(emptyCredential())
}

function validateRawCredential<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  credential: ServerAuth.DecodedCredentials,
  config: ServerAuth.Info,
) {
  if (!ServerAuth.required(config)) return effect
  if (!ServerAuth.authorized(credential, config))
    return Effect.succeed(
      HttpServerResponse.empty({
        status: UNAUTHORIZED,
        headers: { "www-authenticate": WWW_AUTHENTICATE },
      }),
    )
  return effect
}

export const authorizationRouterMiddleware = HttpRouter.middleware()(
  Effect.gen(function* () {
    const config = yield* ServerAuth.Config
    if (!ServerAuth.required(config)) return (effect) => effect

    return (effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const url = new URL(request.url, "http://localhost")
        if (isPublicUIPath(request.method, url.pathname)) return yield* effect
        return yield* credentialFromURL(url, request).pipe(
          Effect.flatMap((credential) => validateRawCredential(effect, credential, config)),
        )
      })
  }),
)

export const authorizationLayer = Layer.effect(
  Authorization,
  Effect.gen(function* () {
    const config = yield* ServerAuth.Config
    const jwtConfigOpt = yield* Effect.serviceOption(ServerAuthV1.JwtConfig)
    const jwtSecret = Option.getOrUndefined(jwtConfigOpt)

    return Authorization.of((effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        if (hasPtyConnectTicketURL(new URL(request.url, "http://localhost"))) return yield* effect

        // Attempt JWT Bearer token first
        const bearerToken = extractBearerToken(request)
        if (bearerToken) {
          if (!jwtSecret) {
            // JWT secret not configured, skip JWT validation
          } else {
            const result = yield* verifyJwt(bearerToken, jwtSecret).pipe(Effect.option)
            if (Option.isSome(result)) {
              return yield* effect.pipe(Effect.provideService(UserContext.Service, result.value))
            }
            // JWT present but invalid — do NOT fall back to Basic Auth
            yield* HttpEffect.appendPreResponseHandler((_request, response) =>
              Effect.succeed(HttpServerResponse.setHeader(response, "www-authenticate", WWW_AUTHENTICATE)),
            )
            return yield* new HttpApiError.Unauthorized({})
          }
        }

        // Fall back to Basic Auth
        return yield* credentialFromRequest(request).pipe(
          Effect.flatMap((credential) => validateCredential(effect, credential, config)),
        )
      }),
    )
  }),
)

export const ptyConnectAuthorizationLayer = Layer.effect(
  PtyConnectAuthorization,
  Effect.gen(function* () {
    const config = yield* ServerAuth.Config
    if (!ServerAuth.required(config)) return PtyConnectAuthorization.of((effect) => effect)
    return PtyConnectAuthorization.of((effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const url = new URL(request.url, "http://localhost")
        if (hasPtyConnectTicketURL(url)) return yield* effect
        return yield* credentialFromURL(url, request).pipe(
          Effect.flatMap((credential) => validateCredential(effect, credential, config)),
        )
      }),
    )
  }),
)
