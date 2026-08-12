# Plan: Per-User Workspace Directories (V2)

> Source PRD: https://github.com/xingyun0812/opencode/issues/2

## 背景

### 问题

OpenCode 有两个 server 实现：

- **V1 server** (`packages/server/`) — 旧的实现，`session.create` 通过 handler 手动构造 `Location.Ref`。
- **V2 server** (`packages/opencode/`) — 当前 `bun run dev serve` 启动的版本，`session.create` 通过 `InstanceState.context.directory` 决定工作目录。

上一轮实现（`feat/per-user-workspace-directories` 分支上的代码）**把目录选择逻辑加到了 V1 handler 里**，但实际生产使用的是 V2 server。所以当前实现不生效。

### V2 与 V1 的差异

| 维度 | V1 | V2 |
|------|----|----|
| session.create 路径 | `handler -> session.create()` | `createRaw -> shareSvc.create -> Session.create` |
| 目录来源 | handler 构造 `Location.Ref` | `InstanceState.context.directory` |
| UserContext 注入 | 有（JWT → `UserContext.Service`） | **无**（仅 Basic Auth） |
| user_id 写入 | handler 传参写入 | **不写入**（表有列但代码不读写） |
| `deriveDefaultLocation` | ✅ 已实现 | ❌ 未接入 |

当前 V2 的问题：
1. V2 Instance API 的 authorization middleware **不验证 JWT**，也不注入 `UserContext.Service`
2. `Session.create` 直接从 `InstanceState.context` 拿 directory，不根据用户身份派生
3. `Session.createNext` 不读写 `user_id` 字段（表有列，但 fromRow/toRow/createNext 都不处理）

### 架构决策

- **路由**: `POST /session`（V2 API），`WorkspaceRoutingMiddleware` 已存在，负责解析 query/header 中的 directory
- **认证**: V2 Instance API 当前仅 Basic Auth。不修改已有全局 middleware，只在 `instanceRoutes` 层切换 auth layer，不影响 rootApiRoutes / eventApiRoutes / ptyConnectApiRoutes
- **目录选择**: 抽成独立函数 `resolveWorkspaceDirectory()`，handler 调用后将结果传给 `Session.create`，不将配置逻辑嵌入数据层
- **目录优先级**: 请求体 `location` 参数 > JWT 用户 → `<data_root>/workspaces/<safe_userID>/` > 无认证 → `ctx.directory`（旧行为）。零值边界：空字符串 `location` 视为未传，走 JWT 路径
- **数据库**: `SessionTable` 已有 `user_id` 和 `user_department_code` 列，但 V2 代码不读写——需要补上。扩展 schema 时保持向后兼容，客户端不感知新字段
- **userID 净化**: `encodeURIComponent()` + `..`/`.` 显式替换
- **DataRootConfig**: 已在 V2 layer 栈中注册
- **清理接口**: `WorkspaceCleanup` 接口已定义（tag + Service，无实现）

### Phase 依赖关系

Phase 1 ← Phase 0（cross-package 工具函数迁移）← 无依赖
Phase 2 ← Phase 1（需要 UserContext）+ Phase 0
Phase 3 ← Phase 2（需要 `Session.create` 已接收 userID）

---

## Phase 0: 抽取 workspacePath() 到共享包

**用户故事**: 基础设施（无直接用户故事）

### 背景

`workspacePath()` 函数当前位于 `packages/server/src/data-root.ts`，只能被 V1 server 引用。Phase 2 需要在 V2 代码中使用它。需要将其抽取到可以被所有包共享的位置。

### What to build

- 将 `workspacePath()` 和 `DataRootConfig` 从 `packages/server/src/data-root.ts` 迁移到 `packages/core/src/` 下
- `workspacePath()` 是纯函数，依赖 `encodeURIComponent` 和 `path.join`，无 Effect 依赖
- `DataRootConfig` service 保留在 `packages/server/src/data-root.ts` 作为 re-export，保持 V1 兼容
- `workspacePath()` 在 V2 中的引用路径更新为 `@opencode-ai/core/workspace-path`（或类似）

### 验收标准

- [ ] `workspacePath()` 可从 core 包 import，V1 和 V2 都能使用
- [ ] V1 的 `packages/server/src/data-root.ts` 仍然导出 `workspacePath()`（re-export 兼容）
- [ ] 原有 V1 unit test 仍然通过

---

## Phase 1: V2 Instance API JWT + UserContext 注入

**用户故事**: #1, #2, #3, #4, #6, #10（需要 UserContext 才能实现目录选择）

### 背景

V2 Instance API 当前的 authorization middleware（`packages/opencode/.../middleware/authorization.ts`）只处理 Basic Auth，不验证 JWT Bearer token，也不注入 `UserContext.Service`。V1 server 的 `packages/server/src/middleware/authorization.ts` 已有完整的 JWT 验证 + UserContext 注入逻辑。

### 改动范围

只影响 `instanceRoutes`（`server.ts:176-177`）。其他 route 组（rootApiRoutes、eventApiRoutes、ptyConnectApiRoutes）的 auth 行为不变。

**方案（选型后只走一个）**: 复用 V1 的 `serverAuthorizationLayer`。它已经被 V2 的 `server.ts` import（第 7-10 行），目前只用于 `serverRoutes`。将 `instanceRoutes` 的 auth layer 从 `httpApiAuthLayer` 切换到 `serverHttpApiAuthLayer`。

### 实现要点

- `serverAuthorizationLayer`（来自 `@opencode-ai/server/middleware/authorization`）已经同时处理 JWT + Basic Auth
- 它在 JWT 验证成功后注入 `UserContext.Service`（第 67 行），无效 JWT 返回 401 不降级
- 无 JWT 时走 Basic Auth fallback
- 只在 `instanceRoutes` 的 `Layer.provide` 中替换，不涉及全局 middleware 修改

### 验收标准

- [ ] `POST /session` 带有效 JWT → handler 能读到 `UserContext`
- [ ] `POST /session` 带无效 JWT → 返回 401
- [ ] `POST /session` 无 JWT → 走 Basic Auth fallback
- [ ] `POST /session` 无认证（无 password 配置）→ 不注入 UserContext
- [ ] 其他 V2 route（rootApiRoutes、eventApiRoutes、ptyConnectApiRoutes）认证行为不变

---

## Phase 2: resolveWorkspaceDirectory + handler 接入

**用户故事**: #1, #2, #3, #4（工作空间隔离）、#6（location 覆盖）、#10（Basic Auth 兼容）

### 背景

当前 `Session.create`（`packages/opencode/src/session/session.ts` 第 669-691 行）直接从 `InstanceState.context.directory` 拿目录，完全不走用户身份。Phase 1 之后 `UserContext` 可用，但 `Session.create` 不应该负责目录选择逻辑。

### 设计

目录选择逻辑抽取为独立函数 `resolveWorkspaceDirectory`，放在 handler 层（`handlers/session.ts`）或 middleware 层。handler 调用后把结果传给 `Session.create`。

```
createRaw
  → resolveWorkspaceDirectory(userContext, request)  // 确定目录
  → Session.create({ ..., directory })               // 纯数据操作
```

优先级：
1. 请求体 `location.directory`（非空字符串）
2. `UserContext` 存在 → `workspacePath(userID, dataRoot)`
3. 回退 → `ctx.directory`（旧行为）

### 实现要点

- `resolveWorkspaceDirectory` 是纯函数（读取 `UserContext` + `DataRootConfig`），可单独测试
- 目录不存在时自动创建（`fs.makeDirectory`），失败走 `Effect.orDie`（后续改 503）
- `Session.create` 接口签名不需要 `location` 参数——目录在 handler 层已经确定
- `workspacePath()` 来自 Phase 0

### 验收标准

- [ ] JWT 请求 + 不传 location → session 目录为 `<data_root>/workspaces/<safe_userID>/`
- [ ] JWT 请求 + 传 `location.directory`（请求体）→ 使用指定的路径
- [ ] JWT 请求 + 传空字符串 `location` → 视为未传，走 JWT 路径
- [ ] 无 JWT 请求 → session 目录为 `ctx.directory`（旧行为）
- [ ] 目录不存在时自动创建
- [ ] 目录创建失败 → 500

---

## Phase 3: V2 Session 表读写 user_id

**用户故事**: Session 归属（配合 canAccess 过滤）

### 背景

`SessionTable` 已经包含 `user_id` 和 `user_department_code` 列（`packages/core/src/session/sql.ts:32-33`），但 V2 的 `Session.createNext`、`fromRow`、`toRow` 都不读写这两个字段。

这意味着即使 Phase 2 给每个用户分配了独立目录，session 记录本身也没有标记归属——后续的 `canAccess()` 过滤无法工作。

### What to build

- 修改 `fromRow` 读取 `user_id`、`user_department_code`（仅内部映射，不暴露到 API schema）
- 修改 `toRow` 写入 `user_id`、`user_department_code`
- 修改 `Session.createNext` 接受并写入 `userID`、`userDepartmentCode`
- 修改 `Session.create` 从 `UserContext`（如果存在）提取 `userID`、`departmentCode` 并传给 `createNext`
- **不扩展 `Session.Info` schema** — userID 是服务端归属字段，不暴露给 API 客户端
- `fromRow` 已返回 `Info` 类型，userID 作为内部字段仅用于 `canAccess()` 过滤

### Acceptance criteria

- [ ] JWT 请求创建 session 后，数据库记录包含 `user_id`
- [ ] 从数据库读取 session 时能读到 `user_id`
- [ ] 无 JWT 请求创建 session 后，`user_id` 为 null
- [ ] 不影响已有 session（迁移兼容）

---

## 未纳入范围

- **WorkspaceCleanup 实现** — 接口已定义（`packages/server/src/cleanup.ts`），实现留待后续
- **目录创建失败返回 503** — 当前用 `Effect.orDie` 返回 500，需 protocol 声明 `ServiceUnavailableError` 后才能改
- **V1 server** — 不做改动，V1 的 `deriveDefaultLocation` 逻辑保留但不再维护
- **数据库 migration** — `user_id` 列已存在，无需迁移。但如果是从旧数据库升级，已有 session 的 `user_id` 为 null，这是预期的兼容行为