import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260818092236_green_titania",
  up(tx) {
    return Effect.gen(function* () {
      const columns = yield* tx.all<{ name: string }>(`PRAGMA table_info(\`session\`)`)
      if (!columns.some((column) => column.name === "user_id")) {
        yield* tx.run(`ALTER TABLE \`session\` ADD \`user_id\` text;`)
      }
      if (!columns.some((column) => column.name === "user_department_code")) {
        yield* tx.run(`ALTER TABLE \`session\` ADD \`user_department_code\` text;`)
      }
    })
  },
} satisfies DatabaseMigration.Migration
