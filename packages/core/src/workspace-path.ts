export * as WorkspacePath from "./workspace-path"

import path from "path"

const workspaceDir = (root: string) => path.join(root, "workspaces")

/**
 * Derives the per-user workspace path from the configured data root.
 *
 * The userID is sanitized by encodeURIComponent followed by neutralizing
 * remaining literal dots to their percent-encoding. encodeURIComponent leaves
 * the characters "." and ".." unencoded, which path.join would otherwise
 * resolve as parent-directory traversal — and stripping dots outright (the
 * old approach) collapsed distinct userIDs (user.name vs username, a..b vs
 * ab) into shared directories. Encoding every path separator ("/" -> "%2F",
 * "\" -> "%5C") first means no separator survives to path.join, so no
 * traversal sequence can re-ascend; replacing the remaining dots ("." ->
 * "%2E") preserves per-user distinctness while keeping the workspace rooted
 * under `<dataRoot>/workspaces/`.
 *
 * @throws {TypeError} if userID is empty
 */
export function workspacePath(userID: string, dataRoot: string): string {
  if (!userID) throw new TypeError("userID must not be empty")
  // Encode first so no literal path separator survives, then neutralize the
  // dots encodeURIComponent left behind so they cannot resolve as "..".
  const safe = encodeURIComponent(userID).replaceAll(".", "%2E")
  return path.join(workspaceDir(dataRoot), safe)
}
