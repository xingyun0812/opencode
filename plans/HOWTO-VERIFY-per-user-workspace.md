# Per-User Workspace Directories — 如何验证

> 验证 Issue #2 的实现：多用户环境下每个用户拥有独立的工作目录。

## 验证环境准备

```bash
# 启动 server
OPENCODE_DATA_ROOT="/tmp/opencode-test" \
  OPENCODE_JWT_SECRET="test-secret" \
  bun run dev serve --port 3080
# Server 应输出: opencode server listening on http://127.0.0.1:3080
```

---

## Phase 1 — DataRootConfig

### 1.1 OPENCODE_DATA_ROOT 设置后生效

```bash
# 启动 server 时设置了 OPENCODE_DATA_ROOT=/tmp/opencode-test
# 通过日志或 API 确认 paths 正确

# 查看 session 创建后目录是否正确（见 Phase 2）
```

### 1.2 OPENCODE_DATA_ROOT 未设置时使用 XDG 默认路径

```bash
# 不设置 OPENCODE_DATA_ROOT 启动 server
# 默认值应为 ~/.local/share/opencode/（或 $XDG_DATA_HOME/opencode/）
unset OPENCODE_DATA_ROOT
bun run dev serve --port 3081
```

### 1.3 unit test 覆盖

```bash
cd packages/server && bun test
# 期望: 12 pass, 0 fail
# 包含 DataRootConfig 的 env 读取测试
```

---

## Phase 2 — Session 创建默认目录

### 2.1 JWT 用户 → workspace 目录

> **注意**: 实现使用 Web Crypto API (`crypto.subtle.verify`) 验证 JWT 签名，和 `openssl dgst -hmac` 生成的签名不兼容。请使用 `gen-token.mjs` 脚本生成测试 token。

```bash
# 使用 Bun 生成 JWT Token（与 server 的 Web Crypto API 一致）
cat > /tmp/gen-token.mjs << 'SCRIPT'
const JWT_SECRET = "test-secret"
const payload = { user_id: "user-abc-123", username: "testuser", department_code: "eng", role: "user", permissions: [] }
const b64url = (s) => Buffer.from(s).toString("base64").replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_")
const enc = new TextEncoder()
const key = await crypto.subtle.importKey("raw", enc.encode(JWT_SECRET), {name:"HMAC",hash:"SHA-256"}, false, ["sign"])
const h = b64url(JSON.stringify({alg:"HS256",typ:"JWT"}))
const p = b64url(JSON.stringify(payload))
const s = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(h+"."+p)))
console.log(h+"."+p+"."+Buffer.from(s).toString("base64").replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_"))
SCRIPT
TOKEN=$(bun run /tmp/gen-token.mjs 2>/dev/null)
echo "Token: $TOKEN"

# 创建 session（V2 API endpoint: /session）
curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title":"test-session"}' \
  http://localhost:3080/session | jq '.directory'

# 期望: 目录为 <OPENCODE_DATA_ROOT>/workspaces/user-abc-123/
```

### 2.2 显式传递 location 时使用指定路径

```bash
curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "explicit-session",
    "location": {"directory": "/tmp/my-project"}
  }' \
  http://localhost:3080/session | jq '.directory'

# 期望: /tmp/my-project（忽略 workspace 默认）
```

### 2.3 无认证 → process.cwd()

```bash
curl -s -X POST \
  -H "Content-Type: application/json" \
  -d '{"name":"legacy-session"}' \
  http://localhost:3080/session | jq '.directory'

# 期望: server 的 process.cwd()（即项目根目录）
```

### 2.4 目录自动创建

```bash
# 删除 workspace 目录后创建 session，目录应自动重建
rm -rf /tmp/opencode-test/workspaces/user-abc-123

curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"session-after-delete"}' \
  http://localhost:3080/session | jq '.directory'

ls -la /tmp/opencode-test/workspaces/user-abc-123/
# 期望: 目录已存在
```

### 2.5 userID 路径穿越防护

> 生成 JWT 需要与 server 的 Web Crypto API 兼容。使用 `gen-token.mjs` 生成恶意 userID 的 token：

```bash
cat > /tmp/gen-evil-token.mjs << 'SCRIPT'
const JWT_SECRET = "test-secret"
const payload = { user_id: "../etc/passwd", username: "evil", role: "user", permissions: [] }
const b64url = (s) => Buffer.from(s).toString("base64").replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_")
const enc = new TextEncoder()
const key = await crypto.subtle.importKey("raw", enc.encode(JWT_SECRET), {name:"HMAC",hash:"SHA-256"}, false, ["sign"])
const h = b64url(JSON.stringify({alg:"HS256",typ:"JWT"}))
const p = b64url(JSON.stringify(payload))
const s = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(h+"."+p)))
console.log(h+"."+p+"."+Buffer.from(s).toString("base64").replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_"))
SCRIPT
EVIL_TOKEN=$(bun run /tmp/gen-evil-token.mjs 2>/dev/null)
echo "Token: $EVIL_TOKEN"

# 创建 session
curl -s -X POST \
  -H "Authorization: Bearer $EVIL_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"evil-session"}' \
  http://localhost:3080/session | jq '.directory'

# 期望: 目录应为 encodeURIComponent 后的安全路径（%2E%2E%2Fetc%2Fpasswd 被剥离），不是 /etc/passwd
```

### 2.6 目录创建失败 → 500

```bash
# 将 workspace 目录设为只读后创建 session
chmod 444 /tmp/opencode-test/workspaces

curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"readonly-session"}' \
  http://localhost:3080/session

# 期望: 500（当前实现使用 Effect.orDie）
chmod 755 /tmp/opencode-test/workspaces
```

### 2.7 session 之间的隔离

> V2 API 返回的 session ID 字段为 `id` 而非 `sessionID`。

```bash
USER_A_TOKEN=...  # user-a 的 JWT，参考 2.1 生成
USER_B_TOKEN=...  # user-b 的 JWT

# user-a 创建 session
SESS_A=$(curl -s -X POST -H "Authorization: Bearer $USER_A_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"session-a"}' \
  http://localhost:3080/session | jq -r '.id')

# user-b 试图访问 user-a 的 session
curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer $USER_B_TOKEN" \
  http://localhost:3080/session/$SESS_A

# 期望: 404（看不到别人的 session）
```

---

## Phase 3 — 单元测试

```bash
cd packages/server && bun test

# 覆盖以下场景：
# - 正常 userID 不变
# - path traversal (../) 被编码
# - double-dot (..) 被编码
# - URL 不安全字符被编码
# - null byte 被编码
# - 空 userID 抛出异常
# - 目录结构正确
# - OPENCODE_DATA_ROOT 设置/未设置
```

---

## 快速验证脚本

保存为 `verify-workspace-directories.mjs`（需要 Bun 运行，因为实现使用 Web Crypto API 签名 JWT）：

```bash
#!/usr/bin/env bun
import { execSync, spawn } from "child_process"
import { existsSync, mkdirSync, rmSync } from "fs"

const JWT_SECRET = "test-secret"
const DATA_ROOT = "/tmp/opencode-test-verify"
const SERVER = "http://localhost:3080"

function b64url(str: string): string {
  return Buffer.from(str).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_")
}

async function genToken(payload: object): Promise<string> {
  const headerB64 = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))
  const payloadB64 = b64url(JSON.stringify(payload))
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(JWT_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  )
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`${headerB64}.${payloadB64}`)))
  const sigB64 = Buffer.from(sig).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_")
  return `${headerB64}.${payloadB64}.${sigB64}`
}

async function post(path: string, token?: string, body?: object) {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (token) headers["Authorization"] = `Bearer ${token}`
  const resp = await fetch(`${SERVER}${path}`, {
    method: "POST", headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = resp.headers.get("content-type")?.includes("json") ? await resp.json() : null
  return { status: resp.status, data }
}

const check = (name: string, ok: boolean) => console.log(ok ? `  PASS: ${name}` : `  FAIL: ${name}`)

async function main() {
  const USER_TOKEN = await genToken({ user_id: "user1", username: "u1", role: "user", permissions: [] })
  const EVIL_TOKEN = await genToken({ user_id: "../etc", username: "evil", role: "user", permissions: [] })

  // Test 1: JWT → workspace 目录
  console.log("=== Test 1: JWT session uses workspace dir ===")
  let r = await post("/session", USER_TOKEN, { title: "t1" })
  check("status 200", r.status === 200)
  check(`dir is ${DATA_ROOT}/workspaces/user1`, r.data?.directory === `${DATA_ROOT}/workspaces/user1`)
  const DIR = r.data?.directory

  // Test 2: 目录自动创建
  console.log("=== Test 2: Directory auto-created ===")
  check("directory exists", DIR && existsSync(DIR))

  // Test 3: 显式 location 覆盖
  console.log("=== Test 3: Explicit location ===")
  r = await post("/session", USER_TOKEN, { title: "t2", location: { directory: "/tmp/custom" } })
  check("dir is /tmp/custom", r.data?.directory === "/tmp/custom")

  // Test 4: 无认证 → cwd
  console.log("=== Test 4: No auth uses cwd ===")
  r = await post("/session", undefined, { title: "t3" })
  check("status 200", r.status === 200)
  check('dir contains "opencode"', r.data?.directory?.includes("opencode"))

  // Test 5: 路径穿越防护
  console.log("=== Test 5: Path traversal sanitization ===")
  r = await post("/session", EVIL_TOKEN, { title: "t4" })
  check("status 200", r.status === 200)
  check("dir not in /etc", r.data?.directory && !r.data.directory.includes("/etc"))

  console.log("\n=== ALL DONE ===")
}

await main().catch((e) => { console.error(e); process.exit(1) })
```

运行方式：

```bash
# 1. 启动 server
OPENCODE_DATA_ROOT=/tmp/opencode-test-verify OPENCODE_JWT_SECRET=test-secret bun run dev serve --port 3080 &
sleep 3

# 2. 运行验证脚本
bun run /path/to/verify-workspace-directories.mjs

# 3. 清理
kill %1 2>/dev/null; rm -rf /tmp/opencode-test-verify

---

## 已知限制

1. **目录创建失败返回 500 而非 503** — 因为 protocol endpoint 未声明 ServiceUnavailableError，当前用 `Effect.orDie` 转为 defect。注释已说明，后续可改。
2. **WorkspaceCleanup 接口定义但无实现** — 只有 Effect type + Service tag，清理逻辑需后续实现。