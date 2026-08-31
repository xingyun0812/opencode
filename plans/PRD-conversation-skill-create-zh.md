# PRD: 对话中创建多租户 Skill（对话/Agent 侧 Skill 创建入口）

## 问题陈述

多租户 opencode serve 场景下，Skill 的**读写都只在 HTTP API 层**打通：
`POST /api/skill`（写入，含 scope/权限校验）、`GET /api/skill`（按当前用户过滤列出）。但用户在**对话中**（Agent 运行时）创建 Skill 时，只有一个**只读**的 `skill` 工具——它的入参只有 `name`，只能 load 已有 Skill，**不能 create**。

因此对话里创建 Skill 只有两条残缺路径，且都不遵守多租户隔离：

1. **模型裸写文件**：Agent 直接用文件写入工具把 `SKILL.md` 写到某目录——不 scope-aware、绕过 `checkScopeAccess` 权限校验、可能写到错误的共享目录，或写到多个用户互相可见/覆盖的位置。
2. **外部调 API**：绕开对话，由外层调 `POST /api/skill`；对话本身对 Skill 创建没有能力。

此外存在两个**现存的不一致/缺口**：

- **扫描源缺口**：`POST /api/skill` 把 Skill 写到 **`Location.directory`**（HTTP 请求的 cwd/workspace 根）下的 scope 子目录，而 `GET /api/skill` / Agent 的 `skill` 工具扫描的是 **config 注册的技能源**（config 目录下的 `skill`/`skills` 子目录、config 显式声明的额外路径/URL，以及内置 embedded 源），**默认不包含 `Location.directory` 本身**。结果是：通过 API 创建的 Skill，往往**不能被列表/load 立即看到**——"创建即可见"的闭环不完整，对 `POST /api/skill` 本身即是如此。
- **读取侧隔离缺口**：对话 `skill` 工具 load 时调用 `SkillV2.list()` **不带 `UserContext`**（见 `packages/core/src/tool/skill.ts` execute 内 `skills.list()` 无参调用），即 load 侧未按当前身份过滤。这意味着任一用户只要知道他人 Skill 的 `name`，理论上即可 load 到其他用户 `user_<id>` 作用域下的个人 Skill——读取隔离未闭合。

## 解决方案

让 Agent 在**对话中**也能创建多租户 Skill，并复用与 `POST /api/skill` **完全一致**的核心逻辑与权限模型：

1. **扩展 `skill` 工具，增加 `create` 动作**：默认行为仍是 `load`（向后兼容）；传入 `action: "create"` 时创建 Skill。创建时以**当前会话的 `Location.directory`** 作为 skillsRoot（与 `POST /api/skill` 一致），按 scope（`user` / `department` / `global`）写入对应子目录，并复用 `canManageScope` 做与 API 相同的角色权限校验。
2. **修复 Skill 扫描源，让 `Location.directory` 下的 Skill 对当前用户可见**：把 **`Location.directory` 本身**纳入 `SkillV2` 的扫描源（`create` 的 skillsRoot 就是它，scope 目录直接挂在它下面），使**无论通过 `POST /api/skill` 还是对话工具创建的 Skill，创建后当前用户都能在列表/load 中立即看到**。这一改动同时补齐现存的「写 location 却扫不到」的坑。
3. **闭合读取侧隔离**：`skill` 工具的 load 动作改为按当前身份调用 `list(userContext)`，使 load 同样受多租户过滤约束——用户即便知道他人 Skill 名称也无法 load 到不属于自己的个人 Skill。
4. **提供对话引导**：一个 `skills-creator` 引导 Skill，指示模型在用户要求创建/管理 Skill 时，用 `skill` 工具的 `create` 动作，并根据用户的归属（本人/部门/全局）选择正确 scope。（载体形态待定，见 M3。）

三条合起来使「对话中创建/读取 Skill」都走「与 HTTP API 同一套 `SkillV2` 服务 + scope 校验 + 身份过滤」的路径，多租户隔离在代码层强制，而不是靠模型裸写文件约定。

## 用户故事

### 对话中创建 Skill

1. 作为普通用户，我希望在对话中直接说「把这个工作流存成一个个人 Skill」，Agent 就把它写成我的个人 Skill，这样我不需要离开对话去调 API。
2. 作为普通用户，我创建的 Skill 默认落到我能管理的 `user` 作用域，这样我不需要手动指定归属。
3. 作为普通用户，我希望**新 `skill.create` 工具**里个人 Skill 的归属一直绑定我当前的身份（**该工具入参不提供 `userID`/`departmentCode` 字段**，identity 一律从 `UserContext` 取），这样从工具接口层面就不可能误把 Skill 建到别人名下。
4. 作为部门成员，我希望在对话中创建属于本部门的 Skill，这样我的团队能受益于共享指导。（部门 Skill 的创建门槛是「本部门成员」，不要求 `dept_admin` 角色；跨部门仍被拒。）
5. 作为部门成员，我希望对话中创建部门 Skill 时校验我确属本部门（`departmentCode` 匹配），跨部门创建被拒绝，这样多租户隔离不被绕过。
6. 作为全局管理员，我希望在对话中创建全局（global）Skill，这样我能维护组织级最佳实践。
7. 作为普通用户，我希望尝试创建 `global` / 本部门之外的 Skill 时得到明确拒绝理由，这样我知道自己被什么权限约束。

### 创建后可见性与读取隔离

8. 作为用户，我希望在对话中创建 Skill 后，立即可在 `GET /api/skill`、`SkillV2.list(userContext)` 中看到它，这样「创建即可见」的闭环完整。
9. 作为用户，我希望只看到/ load 到自己创建的个人 Skill、本部门 Skill 和全局 Skill，看不到也 load 不到其他用户的个人 Skill，这样多租户隔离在对话读取侧同样成立。
10. 作为用户，我希望我创建的个人 Skill 对其他用户不可见也不可 load，这样我的私有指导保持私密。
11. 作为用户，我希望即便我精确知道其他用户某个人 Skill 的名称，也无法通过对话 `skill` 工具 load 到它，这样读取隔离不依赖"别人不知道名字"的假设。

### 与现有机制一致

12. 作为开发者，我希望对话工具（写入侧）与 `POST /api/skill` 共用同一套创建逻辑和权限校验，这样不存在两套不一致的 Skill 写入口。
13. 作为开发者，我希望 `skill` 工具默认行为不变（仍是 load），已有依赖 `name` 入参的调用不破坏，这样向后兼容。
14. 作为开发者，我希望本次改动能顺手修复 `POST /api/skill` 写 `Location.directory` 却扫不到的现存不一致，这样新入口和旧 API 都达到「创建即可见」。

## 实现决策

### 模块划分

#### M1: `skill` 工具增加 `create` 动作（深模块）
- 现有只读 `skill` 工具（默认 `load`）扩展为支持 `action: "load" | "create"`，`action` 缺省为 `load`（向后兼容）。
- `create` 入参：`name`、`description?`、`content`、`scope?`（**仅接受 `type: "user"|"department"|"global"`**）。
  - **`content` 为必填**（与 `SkillV2.create` 入参类型 `content: string` 及 `POST /api/skill` 的 `SkillCreateBody.content` 必填一致）。此前写 `content?` 与底层不一致，订正为必填。
  - **identity 一律从 `UserContext` 取，新工具入参不提供 `userID`/`departmentCode` 字段**：`canManageScope` 的规则本就是「user 的 userID 必须等于当前用户、dept 的 code 必须等于本部门」，允许调用方传 identity 只会制造「可越权再拒绝」的多余接口面。工具内部从 `UserContext` 取当前 `userID`/`departmentCode` 补齐完整 scope，再 `canManageScope` 校验。
  - **此约束仅作用于新的 `skill.create` 工具入参**。现有 `POST /api/skill` 协议（`SkillCreateBody.scope`）仍接受 `userID`/`departmentCode` 字段，本 PRD **不改动 HTTP API**——HTTP 侧的 scope identity 来源若需收紧，属兼容性变更，另立 PRD（见"不在范围内"）。
  - **`scope.type` 缺省为 `user`**。
  - **无 `departmentCode` 时的错误行为**：当 `scope.type="department"` 但当前用户的 `UserContext.departmentCode` 缺失（用户未归属任何部门）→ create 拒绝并返回清晰错误（不能派生有效 scope 目标）。`scope.type="user"` 但 `UserContext.userID` 缺失 → 同样拒绝（见下条无身份闸门）。
- **create 前置要求 `UserContext` 必须存在（调用方闸门，不进 `canManageScope` 函数）**：`UserContext` 缺失（如非 JWT/Basic-auth 的本地 CLI 会话）时，create 动作在调用 `canManageScope` 之前**直接拒绝所有 scope**。`canManageScope` 函数本身**保留**既有「无 userContext 放行」(`if (!user) return true`) 语义不动——这保证只读 `list`/`load` 路径行为不破坏。"无身份 → 拒绝创建"是 create 调用方的契约，不是权限函数的契约。
- 命名约束：`name` 非法（大写、空格、路径分隔符等）→ 拒绝。
- **同名策略（同 scope 拒绝）**：`create` 写盘前检查目标 `<skillsRoot>/<scopeDir>/<name>/` 是否已存在；若存在 → 拒绝并返回 `SkillNameConflictError`（409，协议已定义、当前 handler 未使用，本次启用）。**跨 scope / 跨 source 同名允许并存**（如 `user_A/foo` 与 `user_B/foo` 互不冲突），`list(userContext)` 按当前身份过滤后各自隔离可见。load 命中规则见 M2。
- 执行流程：解析（并断言存在）`UserContext` → 从用户身份补齐完整 scope（type 取调用方或缺省 `user`，identity 取当前用户；`department`/`user` 字段缺失则拒绝）→ 同名冲突检查 → `canManageScope` 权限校验 → 调 `SkillV2.create` 写入 `<skillsRoot>/<scopeDir>/<name>/SKILL.md` → 缓存失效。
- `skillsRoot` 取**当前会话的 `Location.directory`**（与 `POST /api/skill` 一致）；create 时注入 `Location` 服务读取当前会话目录。
- 复用对象：`SkillV2` 服务、`canManageScope`（`checkScopeAccess` 从 `packages/server` 抽到 `packages/core` 时改名为 `canManageScope`，供 HTTP 与工具两处共用）、`SkillNameConflictError`（协议层已有）。

#### M2: 闭合读取侧隔离 + 让 `Location.directory` 下的 Skill 对当前用户可见（浅模块，修复）
- **读取侧隔离**：`skill` 工具的 load 动作改为 `skills.list(userContext)`（当前取自 `UserContext`）后再按 `name` 查找；当前用户身份过滤后不可见的 Skill，即便传入其 `name` 也 load 不到（返回 unableToLoad，不泄露存在性）。这与 `GET /api/skill` 的过滤口径一致。
- **扫描源修复**：将 **`Location.directory` 本身**注册为 `SkillV2` 扫描源（而非其 `skill`/`skills` 子目录），使该目录下按 scope 子目录（`user_`/`dept_`/`global`）组织的 Skill 对当前用户过滤可见。
- **为什么是 location 本身**：`SkillV2.create(skillsRoot)` 的写盘路径是 `<skillsRoot>/<scopeDir>/<name>/SKILL.md`（scope 目录直接挂在 skillsRoot 下），而 `SkillV2.load` 把 source 目录的**直接子项**当 scope 目录解析。因此要让「写」与「读」对齐，`create` 的 `skillsRoot` 必须等于被注册的 source。反例：若只注册 `location.directory/skills`，则 create 写 `location.directory/<scope>/…` 与 source 对不上、仍扫不到。故 source = `Location.directory`（与「skillsRoot = Location.directory」完全一致，改动最小）。
- **load 命中规则**：`SkillV2.list()` 按 `name` 聚合（同 name 后扫到的覆盖先扫到的，按 source 注册顺序）。经 `list(userContext)` 过滤后，当前用户可见的同名 Skill 若仍有多个，load 命中第一个。跨 scope 同名因身份过滤通常不会对同一用户同时可见；若可见（如同名 user + global 同时对本人可见），命中顺序由 source 顺序决定，属可接受边界。
- 复用 `SkillV2` 现有 scope 扫描 + `list(userContext)` 过滤机制，不重写隔离逻辑。
- 效果：无论 `POST /api/skill` 还是对话 `create` 创建的 Skill，创建后当前用户都能在列表/load 看到；且 load 侧同样受身份过滤约束。

#### M3: `skills-creator` 引导（载体形态待定，本 PRD 不验收）
- 一个引导性产物，指示模型在用户要求创建/管理 Skill 时使用 `skill` 工具的 `create` 动作，并根据用户归属选择正确 `scope`。
- **载体形态（embedded 内置 Skill vs 纯文档）待定**：两种形态的加载/触发方式不同——embedded Skill 经 `SkillPlugin` 注入、由系统上下文按描述触发；纯文档则不自动加载。本 PRD 不在此二者间定稿，M3 暂不纳入验收。待形态在后续 PRD 确定后再补测试口径。
- 不承担实际写盘，仅引导；实际能力由 M1 提供。

### 复用对象
- `SkillV2.create` / `SkillV2.list(userContext)` / scope 目录派生（`user_<id>` / `dept_<code>` / `global`）：核心写盘与读取、过滤逻辑，`POST /api/skill` 已用，直接复用。
- `canManageScope`（原名 `checkScopeAccess`）：从 `packages/server`（V1 HTTP handler）抽到 `packages/core`，供 HTTP 层与对话工具共用（避免跨包依赖与两套逻辑漂移）。**函数语义不变**（含「无 userContext 放行」），「无身份拒绝」由 create 调用方前置闸门实现。
- `SkillNameConflictError`（409）：协议层已定义、当前 handler 未启用，本次在 create 同名冲突时启用。
- `UserContext.Service`：V2 会话/请求运行时已注入，用于取得当前用户身份以补齐 `scope` 并供 load 侧过滤。

### 关键决策说明
- **skillsRoot 取 `Location.directory`**：与 `POST /api/skill` 完全一致。用户明确要求「与 `/api/skill` 的 skillsRoot 行为一致」。
- **隔离模型采用现有「共享根 + scope 子目录」**：复用现有 `SkillV2` 多租户机制（`user_`/`dept_`/`global` 子目录 + `list(userContext)` 过滤 + `canManageScope`），不做侵入式的「真 per-user workspace 物理目录」重构。
- **读取与写入两侧都按身份过滤**：`list(userContext)` 既用于 create 后的可见性、也用于 load 的可加载集合，确保读写隔离口径一致。
- **顺带修复现存坑**：`Location.directory` 纳入扫描源 + load 侧带身份过滤，补齐「写 location 却扫不到」与「load 不带身份过滤」两个缺口，使新旧入口行为一致。
- **`canManageScope` 无身份语义**：函数保留放行、由 create 前置闸门拒绝（见 M1 / 补充说明 5）。不把「无身份拒绝」并入函数，以免改变只读 `list`/`load` 路径行为。
- **部门 Skill 权限模型已放宽（已落地于 HTTP 侧 `checkScopeAccess`）**：`department` scope 的管理门槛（create/update/remove 三处共用同一函数）从「本部门 `dept_admin`」放宽为「本部门成员（`departmentCode` 匹配即可，任意角色）」，`global_admin` 短路保留、`global`/`user` 规则不变。**权衡**：三处共放宽意味着部门任意成员可改/删本部门他人创建的 Skill——这是有意选择（见问答记录），非缺陷。对话侧 `skill.create` 工具届时沿用同一函数，自动受益。本次未抽包改名，函数仍为 `packages/server/src/handlers/skill.ts` 私有导出（`checkScopeAccess`），供单测直接覆盖；跨包抽 `canManageScope` 仍待后续。
- **create 侧 identity 强制取自 `UserContext`（已落地）**：HTTP `create` handler 调 `checkScopeAccess` 前，用当前用户身份覆盖请求体 `scope`（`department`→取 `userContext.departmentCode`、`user`→取 `userContext.userID`、`global`→无 identity），堵住「请求体不传 `departmentCode` → 旧第 27 行短路 → 绕过归属校验」的洞；写盘也用此 enforcedScope，保证落盘归属=真实身份。无 `UserContext`（非 JWT/Basic-auth）→ create 前置闸门直接拒所有 scope（函数本身仍 `if (!user) return true` 放行，以保只读路径）。与 M1「identity 一律从 `UserContext` 取」一致。

## 测试决策

### 测试理念
测试验证外部行为而非实现细节。好的测试断言「给定某种身份与意图，Skill 落盘到正确作用域、列表/load 可见性正确、越权/越身份被拒」；不断言内部函数以何种参数被调用。

### 模块与测试

**M1 `create` 动作：**
- 普通用户创建 `user` 作用域（缺省/显式）→ 写到 `<location>/user_<userId>/<name>/SKILL.md`，frontmatter 含 `name`/`description`。identity 取自 `UserContext`，入参不携带 userID。
- **会话无 `UserContext`（非 JWT / Basic-auth）→ create 直接拒绝所有 scope**（`user`、`department`、`global` 均拒绝），不走 `canManageScope`（函数保留放行，拒绝发生在调用方前置闸门）。
- 普通用户显式创建 `global` → 被拒；显式创建 `department` 但身份/部门非本部门 → 被拒（身份取自 `UserContext`，工具入参无法指定他人代码）。
- **`department` 但用户 `UserContext.departmentCode` 缺失 → 拒绝**（不能派生有效 scope 目标，清晰错误）。
- `dept_admin` 创建本部门 `department` → 成功；`dept_admin` 身份切换为他部门后创建 → 被拒（模拟身份切换，因入参不能指定他部门）。
- `global_admin` 创建 `global` → 成功。
- **同名冲突**：同 `<scopeDir>/<name>` 已存在 → 返回 `SkillNameConflictError`（409），不覆盖。跨 scope（如 `user_A/foo` vs `user_B/foo`）各自创建成功、互不冲突。
- `action` 缺省时仍走 `load`，行为与改动前一致（向后兼容，但 load 现带身份过滤，见 M2）。
- 命名校验：非法 name（大写、空格、路径分隔符）被拒。

**M2 读取隔离 + 可见性（集成测试）：**
- **create → list 往返**：以某用户身份在 `Location.directory` 下创建 `user` Skill → 随后同一个 `SkillV2` service（同一会话/进程）`list(userContext)` 立即可见该 Skill，`skill` 工具 load 可读到 → **核心验收**，验证 skillsRoot 与扫描源对齐后「创建即可见」。
- **读取隔离越权**：用户 B 即便知道用户 A 个人 Skill 的 `name`，调 `skill` 工具 load 该 name → load 不到（身份过滤后不可见，返回 unableToLoad，不泄露存在性）。
- 通过 `POST /api/skill`（或对话 `create`）在 `Location.directory` 下创建 Skill → 之后 `GET /api/skill` / `SkillV2.list(userContext)` 能立即看到该项目录下、当前用户可见的 Skill。
- 不同用户在同一 `Location.directory` 创建各自的 `user` Skill → 经 `list(userContext)` 互不可见、互不可 load。
- 普通用户在该目录看不到也 load 不到其他用户的个人 Skill（隔离）。

**M3 `skills-creator`：**
- **本 PRD 不对 M3 验收**（载体形态待定）。待形态在后续 PRD 确定后再补「引导内容与所用工具动作/scope 规则一致」的测试口径。

### 参考案例
- 现有 `packages/core/test/tool-skill.test.ts`：用模拟 `SkillV2.Service` 测试 `skill` 工具的 load 行为——M1 的 `create` 测试与 M2 的读取隔离测试应复用此模式（同一层、模拟服务、断言入参落到 `SkillV2.create`/`list(userContext)` 与权限/过滤分支）。
- `canManageScope` 抽到 `packages/core` 后**需新增单测**（覆盖：`user` 的 userID 必须等于当前用户、`department` 的 code 必须等于本部门、`global` 仅全局管理员可管理）；**不含「无 UserContext 拒绝」分支**——那是 create 调用方的前置闸门契约（见 M1 测试），函数内部仍维持 `if (!user) return true` 放行语义以免破坏只读路径。现无该纯函数的独立测试，不沿用 `permission.test.ts`（它测的是另一层权限求值，与本权限分支无关）。
  > **现状更新（本次落地）**：暂未抽包到 `packages/core`，函数仍为 `packages/server/src/handlers/skill.ts` 的 `checkScopeAccess`（私有导出）。「department 的 code 必须等于本部门」规则**已放宽**——不再要求 `dept_admin` 角色，任意本部门成员（`departmentCode` 匹配）即可管理；该函数的单测已在 `packages/server/test/skill-scope-access.test.ts` 直接覆盖（department 放宽/跨部门拒/无部门拒/global/user 规则/无身份放行）。抽包后该测试随函数迁移。

## 不在范围内

- 「真 per-user workspace 物理目录」重构（本次复用现有「共享根 + scope 子目录」隔离模型）。
- Skill 更新/删除的对话侧入口（`SkillV2.update`/`remove` 已有，本 PRD 仅覆盖 `create` 与 load 读取隔离；如需对话侧更新/删除，另立 PRD）。
- **改动 `POST /api/skill` 协议**（如收紧 scope identity 来源、拒绝入参 `userID`/`departmentCode`）：属 HTTP API 兼容性变更，本 PRD 仅作用于新对话工具侧，HTTP 侧不改动；如需收紧另立 PRD。
- **M3 `skills-creator` 的载体形态定稿与验收**（embedded Skill vs 纯文档）：本 PRD 暂不验收，待后续 PRD 定形态。
- 对话中浏览 Skill 的 UI 改造（列表已由 `GET /api/skill` 提供）。
- 跨多 opencode serve 实例的 Skill 缓存一致性问题（现有架构范畴）。
- 用户管理端点（用户数据存在于 Java 后端）。
- **HTTP 侧 `checkScopeAccess` 跨包抽到 `packages/core` 改名 `canManageScope`**：本次只放宽 department 规则 + 加 create identity 闸门，函数仍留 `packages/server/src/handlers/skill.ts`（私有导出供单测）。抽包共用待后续 PRD。
- **`global`/`user` scope 规则收紧**：本次不动这两个分支（`global` 仍仅 `global_admin`、`user` 仍匹配 `userID`）。`user` 分支顺带补了一条「`userID` 缺失拒绝」以堵无身份建个人 Skill，但 `global`/`user` 主体规则不变。

## 补充说明

1. **向后兼容**：`skill` 工具默认 `action=load`，不传 `action` 即维持原只读行为；已有调用不受影响。**注意**：load 路径本次新增按身份过滤（M2），这是对既有 load 行为的收紧——此前 load 不带身份过滤属安全隐患，该收紧是本 PRD 的意图项，非破坏性回归。
2. **`checkScopeAccess` 抽包改名 `canManageScope`**：抽到 `packages/core` 后，HTTP 层（`POST /api/skill`）与对话工具共用同一实现，避免两套权限逻辑漂移。**函数语义不变**（含「无 userContext 放行」）；「无身份 → 拒绝创建」不并入函数，而是由 create 调用方前置闸门实现，以免改变只读 `list`/`load` 路径行为（见补充说明 5）。
3. **`Location.directory` 与 `UserContext` 的可得性**：对话工具在 V2 会话 runner 内执行，两者均为运行时注入。若 `UserContext` 缺失（如非 JWT/Basic-auth 的本地 CLI 会话无用户身份），create **直接拒绝所有 scope**（调用方前置闸门），给出清晰错误而非静默失败——不产生「无身份却落盘成功」的可疑结果。`Location.directory` 缺失的情况本就极罕见（`create` 的 skillsRoot 需要它），同样给出清晰错误。load 在无 `UserContext` 时如何过滤属只读路径范畴，不在本 PRD 收紧范围（见补充说明 1）。
4. **「创建即可见」的验收口径**：在 `Location.directory` 下创建的 Skill，应在**同一会话/进程**中对当前用户立即可见，无需重启或刷新缓存（`SkillV2.create` 已 `invalidateCache()`）。
5. **无身份权限语义（定稿）**：`canManageScope` 保留 `if (!user) return true` 放行语义；「无 `UserContext` → 拒绝」由 create 调用方前置闸门实现。**不**把拒绝并入函数——这保证既有只读 `list`/`load` 路径（含 `GET /api/skill`）行为不被本 PRD 改变。HTTP 侧 `POST /api/skill` 的同款隐患（无认证可 create 任意 scope）属 HTTP 范畴，本 PRD 不改动 HTTP；如需 HTTP 侧也加前置闸门，另立 PRD。
6. **identity 约束范围**：「入参不提供 `userID`/`departmentCode`」仅约束新的 `skill.create` 工具；`POST /api/skill` 协议仍接受这两个字段，不在本 PRD 改动（见"不在范围内"）。
7. **content 必填**：新工具 `create` 的 `content` 为必填，与 `SkillV2.create` 及 `SkillCreateBody` 一致。
8. **同名策略**：同 scope 同名 → `SkillNameConflictError`（409）；跨 scope/跨 source 同名允许并存，由 `list(userContext)` 身份过滤隔离。
