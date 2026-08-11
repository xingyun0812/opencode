export * as WorkspacePath from "./workspace-path"

import path from "path"

const workspaceDir = (root: string) => path.join(root, "workspaces")

/**
 * Derives the per-user workspace path from the configured data root.
 *
 * The userID is sanitized via encodeURIComponent with explicit `.` / `..`
 * stripping before encoding, then appended to `<dataRoot>/workspaces/`.
 *
 * @throws {TypeError} if userID is empty
 */
export function workspacePath(userID: string, dataRoot: string): string {
  if (!userID) throw new TypeError("userID must not be empty")
  // Strip dots before encoding: encodeURIComponent leaves "." and ".."
  // unencoded, and path.join would resolve ".." as parent-directory
  // traversal. Removing dots pre-encoding also prevents a hypothetical
  // downstream URL-decode from re-exposing traversal sequences.
  const safe = encodeURIComponent(userID.replaceAll("..", "").replaceAll(".", ""))
  return path.join(workspaceDir(dataRoot), safe)
}
