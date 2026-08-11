export * as WorkspacePath from "./workspace-path"

import path from "path"

const workspaceDir = (root: string) => path.join(root, "workspaces")

/**
 * Derives the per-user workspace path from the configured data root.
 *
 * The userID is sanitized via encodeURIComponent plus explicit `.` / `..`
 * stripping, then appended to `<dataRoot>/workspaces/`.
 *
 * @throws {TypeError} if userID is empty
 */
export function workspacePath(userID: string, dataRoot: string): string {
  if (!userID) throw new TypeError("userID must not be empty")
  // encodeURIComponent does NOT encode "." or "..", so path-traversal
  // sequences like "../etc" would survive encoding. Strip them explicitly.
  const safe = encodeURIComponent(userID).replace(/\.\.?/g, (m) =>
    m === ".." ? "%2E%2E" : "%2E",
  )
  return path.join(workspaceDir(dataRoot), safe)
}
