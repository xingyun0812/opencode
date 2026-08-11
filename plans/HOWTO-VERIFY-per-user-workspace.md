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

```bash
# 生成 JWT Token
JWT_SECRET="test-secret"
JWT_HEADER=$(echo -n '{"alg":"HS256","typ":"JWT"}' | base64 | tr -d '=' | tr '/+' '_-')
JWT_PAYLOAD=$(echo -n '{"user_id":"user-abc-123","username":"testuser","department_code":"eng","role":"user","permissions":[]}' | base64 | tr -d '=' | tr '/+' '_-')
JWT_SIG=$(echo -n "$JWT_HEADER.$JWT_PAYLOAD" | openssl dgst -sha256 -hmac "$JWT_SECRET" -binary | base64 | tr -d '=' | tr '/+' '_-')
TOKEN="$JWT_HEADER.$JWT_PAYLOAD.$JWT_SIG"

# 创建 session（不传 location）
curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"test-session"}' \
  http://localhost:3080/api/sessions | jq '.directory'

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
  http://localhost:3080/api/sessions | jq '.directory'

# 期望: /tmp/my-project（忽略 workspace 默认）
```

### 2.3 无 JWT（Basic Auth）→ process.cwd()

```bash
curl -s -X POST \
  -H "Content-Type: application/json" \
  -d '{"name":"legacy-session"}' \
  http://localhost:3080/api/sessions | jq '.directory'

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
  http://localhost:3080/api/sessions | jq '.directory'

ls -la /tmp/opencode-test/workspaces/user-abc-123/
# 期望: 目录已存在
```

### 2.5 userID 路径穿越防护

```bash
# 生成带有恶意 userID 的 JWT
JWT_PAYLOAD_EVIL=$(echo -n '{"user_id":"../etc/passwd","username":"evil","role":"user","permissions":[]}' | base64 | tr -d '=' | tr '/+' '_-')
JWT_SIG_EVIL=$(echo -n "$JWT_HEADER.$JWT_PAYLOAD_EVIL" | openssl dgst -sha256 -hmac "$JWT_SECRET" -binary | base64 | tr -d '=' | tr '/+' '_-')
TOKEN_EVIL="$JWT_HEADER.$JWT_PAYLOAD_EVIL.$JWT_SIG_EVIL"

# 创建 session
curl -s -X POST \
  -H "Authorization: Bearer $TOKEN_EVIL" \
  -H "Content-Type: application/json" \
  -d '{"name":"evil-session"}' \
  http://localhost:3080/api/sessions | jq '.directory'

# 期望: 目录应为 encodeURIComponent 后的安全路径，不是 /etc/passwd
# encodeURIComponent("../etc/passwd") = "%2E%2E%2Fetc%2Fpasswd"
```

### 2.6 目录创建失败 → 500（注释标明了后续应改 503）

```bash
# 将 workspace 目录设为只读后创建 session
chmod 444 /tmp/opencode-test/workspaces

curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"readonly-session"}' \
  http://localhost:3080/api/sessions

# 期望: 500（当前实现使用 Effect.orDie）
chmod 755 /tmp/opencode-test/workspaces
```

### 2.7 session 之间的隔离

```bash
USER_A_TOKEN=...  # user-a 的 JWT
USER_B_TOKEN=...  # user-b 的 JWT

# user-a 创建 session
SESS_A=$(curl -s -X POST -H "Authorization: Bearer $USER_A_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"session-a"}' \
  http://localhost:3080/api/sessions | jq -r '.sessionID')

# user-b 试图访问 user-a 的 session
curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer $USER_B_TOKEN" \
  http://localhost:3080/api/sessions/$SESS_A

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

保存为 `verify-workspace-directories.sh`：

```bash
#!/bin/bash
set -euo pipefail

SERVER="http://localhost:3080"
JWT_SECRET="test-secret"
DATA_ROOT="/tmp/opencode-test-verify"

b64url() { echo -n "$1" | base64 | tr -d '=' | tr '/+' '_-' | tr -d '\n'; }

gen_token() {
  local header=$(b64url '{"alg":"HS256","typ":"JWT"}')
  local payload=$(b64url "$1")
  local sig=$(echo -n "$header.$payload" | openssl dgst -sha256 -hmac "$JWT_SECRET" -binary | base64 | tr -d '=' | tr '/+' '_-')
  echo "$header.$payload.$sig"
}

USER_TOKEN=$(gen_token '{"user_id":"user1","username":"u1","role":"user","permissions":[]}')

cleanup() { rm -rf "$DATA_ROOT"; kill %1 2>/dev/null; }

# 启动 server
OPENCODE_DATA_ROOT="$DATA_ROOT" \
  OPENCODE_JWT_SECRET="$JWT_SECRET" \
  OPENCODE_SERVER_PASSWORD="test" \
  bun run dev serve --port 3080 &
sleep 3

# Test 1: JWT → workspace 目录
echo "=== Test 1: JWT session uses workspace dir ==="
DIR=$(curl -s -X POST -H "Authorization: Bearer $USER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"t1"}' "$SERVER/api/sessions" | jq -r '.directory')
[[ "$DIR" == "$DATA_ROOT/workspaces/user1" ]] && echo "PASS: $DIR" || echo "FAIL: $DIR"

# Test 2: 目录自动创建
echo "=== Test 2: Directory auto-created ==="
ls -d "$DIR" >/dev/null 2>&1 && echo "PASS: directory exists" || echo "FAIL"

# Test 3: 显式 location 覆盖
echo "=== Test 3: Explicit location ==="
DIR2=$(curl -s -X POST -H "Authorization: Bearer $USER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"t2","location":{"directory":"/tmp/custom"}}' \
  "$SERVER/api/sessions" | jq -r '.directory')
[[ "$DIR2" == "/tmp/custom" ]] && echo "PASS: $DIR2" || echo "FAIL: $DIR2"

# Test 4: Basic Auth → cwd
echo "=== Test 4: Basic Auth uses cwd ==="
DIR3=$(curl -s -X POST -H "Authorization: Basic $(echo -n 'opencode:test' | base64)" \
  -H "Content-Type: application/json" \
  -d '{"name":"t3"}' "$SERVER/api/sessions" | jq -r '.directory')
[[ "$DIR3" == *"opencode"* ]] && echo "PASS: $DIR3" || echo "FAIL: $DIR3"

# Test 5: 路径穿越防护
echo "=== Test 5: Path traversal sanitization ==="
EVIL_TOKEN=$(gen_token '{"user_id":"../etc","username":"evil","role":"user","permissions":[]}')
DIR4=$(curl -s -X POST -H "Authorization: Bearer $EVIL_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"t4"}' "$SERVER/api/sessions" | jq -r '.directory')
[[ "$DIR4" != *"/etc"* ]] && echo "PASS: sanitized" || echo "FAIL: $DIR4"

echo "=== DONE ==="
cleanup
```

---

## 已知限制

1. **目录创建失败返回 500 而非 503** — 因为 protocol endpoint 未声明 ServiceUnavailableError，当前用 `Effect.orDie` 转为 defect。注释已说明，后续可改。
2. **仅覆盖 V1 routes** — `deriveDefaultLocation` 只在 `packages/server` 的 V1 handler 中实现。V2 route (`@opencode-ai/opencode`) 的 session create 不经过这个逻辑。
3. **WorkspaceCleanup 接口定义但无实现** — 只有 Effect type + Service tag，清理逻辑需后续实现。