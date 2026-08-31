import path from "path"
import { Effect, Option, Schema } from "effect"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { UserContext } from "@opencode-ai/schema/user-context"
import { AuthToken } from "@opencode-ai/schema/auth-token"
import { Skill } from "../skill"
import * as Tool from "./tool"
import DESCRIPTION from "./skill.txt"

export const Parameters = Schema.Struct({
  name: Schema.String.annotate({ description: "The name of the skill from available_skills" }),
})

export const SkillTool = Tool.define(
  "skill",
  Effect.gen(function* () {
    const skill = yield* Skill.Service
    const ripgrep = yield* Ripgrep.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const info = yield* skill
            .require(params.name)
            .pipe(Effect.catchTag("Skill.NotFoundError", (error) => Effect.die(new Error(error.message))))

          // Resolve the live auth context (identity + raw Bearer credential) for
          // this request's fiber. The HTTP middleware injects both during an
          // authenticated session; fiber inheritance surfaces them here as Some.
          // Unauthenticated/Basic-Auth paths yield None. Skill content can drive
          // bash/webfetch to call business backends; those tools read AuthToken
          // themselves, but exposing it on the skill tool too lets skill logic
          // that needs the credential reach it directly. Never printed to output.
          const userContext = Option.getOrUndefined(yield* Effect.serviceOption(UserContext.Service))
          const authToken = Option.getOrUndefined(yield* Effect.serviceOption(AuthToken.Service))
          void authToken // surfaced for skill-driven logic; not emitted below

          yield* ctx.ask({
            permission: "skill",
            patterns: [params.name],
            always: [params.name],
            metadata: {},
          })

          const dir = path.dirname(info.location)
          const base = dir
          const files = yield* ripgrep.find({
            cwd: dir,
            pattern: "!**/SKILL.md",
            hidden: true,
            follow: false,
            signal: ctx.abort,
            limit: 10,
          })

          return {
            title: `Loaded skill: ${info.name}`,
            output: [
              `<skill_content name="${info.name}">`,
              `# Skill: ${info.name}`,
              "",
              info.content.trim(),
              "",
              `Base directory for this skill: ${base}`,
              "Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.",
              "Note: file list is sampled.",
              "",
              "<skill_files>",
              files.map((file) => `<file>${path.resolve(dir, file.path)}</file>`).join("\n"),
              "</skill_files>",
              "</skill_content>",
            ].join("\n"),
            metadata: {
              name: info.name,
              dir,
              authenticated: !!userContext,
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
