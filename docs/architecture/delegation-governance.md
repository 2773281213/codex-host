# 委派治理：分档路由、范围锁、Worktree 闭环与提示词缓存保活

本文记录 CodexHost 引入的规划者中立分档调度与治理能力（CLI、HTTP 与 MCP 共用同一控制面），包括分档路由、并发写范围冲突锁、防递归执行者角色、基于 Git Worktree 的检查与补丁闭环，以及等待子任务期间的原生 55 分钟提示词缓存保活。

## 1. 规划者中立的分档路由

`delegate start` 支持省略 `--harness` 而改传 `--tier deep|light|review`（也可传 `--harness` 覆盖档位默认执行者，或用 `--profile <name>` 指定 profile）：

| 档位 | 用途 | 写权限 | 默认映射（`thread16`，Claude Code 规划） | 默认映射（`codex-planner`，Codex 规划） | 护栏 |
| --- | --- | --- | --- | --- | --- |
| `deep` | 复杂、多文件、需要深度推理的实现或排错 | 可写 | `codex` | `claude-code` | 必须声明 `--scope`（全仓用 `.`） |
| `light` | 简单且边界明确的机械性改动 | 可写 | `deepseek-harness` | `deepseek-harness` | 必须声明 1–10 条非 `.` `--scope` 与至少 1 条 `--check` |
| `review` | 只读代码审查、调研或第二意见 | 只读 | `claude-code` | `codex` | 任何改动均记为越界，禁止 `apply` |

路由配置按“内置默认 → 用户级 `~/.codexhost/delegation-routing.json` → 项目级 `<repo>/.codexhost/delegation-routing.json`”逐层合并；profile 选择优先级为：`--profile` → `CODEXHOST_DELEGATION_PROFILE` → 配置文件 `plannerProfiles.<planner>` → 配置文件 `profile` → 内置规划者默认 → `thread16`。

管理命令与接口：

- CLI：`codexhost delegate routing show [--cwd <path>] [--planner <harness>] [--profile <name>]` 与 `codexhost delegate routing set <key> <value>|unset <key> [--cwd <path>] [--user true|false]`
- HTTP：`POST /v1/delegate/routing/show|set|unset`
- MCP：`delegate_routing`
- Desktop / Web 设置页：通过 `codexhost/delegation/routing/get` 与 `codexhost/delegation/routing/set` RPC 分别管理“默认配置档”（支持 `自动（按规划者）`，即清除顶层 `profile` 恢复按规划者自动选档）与“当前编辑配置档”的 `deep`/`light`/`review` 映射，保存时仅写入改动过的字段到用户级配置文件。

可写键名：`profile`、`plannerProfiles.<harnessId>`、`profiles.<name>.<deep|light|review>`（格式 `harnessId[:model][@thinking]`）、`checks.timeoutMinutes`、`checks.shell`（**仅允许用户级配置**，项目级禁止写入与加载该键，但允许 `unset checks.shell` 清理存量项目文件）、`light.maxScopeEntries`、`light.maxChangedFiles`。所有写入先校验完整合并配置，再以原子替换落盘。

## 2. 写范围冲突锁与防递归护栏

- **治理触发边界**：CLI、控制服务（`routeDelegationRequest`）与 `DelegationControlRegistry` 共用同一判定 `requestsGovernance()`：仅当显式传入 `tier`、`profile`、非空 `scope` / `checks`、非空白 `acceptance`，或 `allowNestedDelegation: false`（含这些字段的非法值，以便进入校验并拒绝而非静默走无治理路径）时才进入治理。
  - 普通 `--worktree` 委派（无论是否传 `--include-uncommitted`）**不受治理**：不写治理记录、不注入执行者角色、不占范围锁，不支持 `verify` / `apply` / `discard`（对其执行 `verify`、`apply` 或 `discard` 均报 `THREAD_NOT_FOUND`，并提示使用 `--tier`、`--scope` 或 `--check` 发起），保持上游原有行为。
  - 参数约束：`delegate start` 中 `--auto-verify true` 仅允许用于受治理委派；`--profile` 必须配合 `--tier`；`allowNestedDelegation` 必须是布尔值。
- **路径归一化**：`--scope` 仅接受项目相对路径（禁止 `..`、`.git`、前导 `/`、反斜杠、冒号与控制字符），按目录前缀判定覆盖关系（Windows 上不区分大小写）。
- **并发写范围冲突锁**：治理记录持久化在 `<数据目录>/delegation-jobs/`。
  - 所有受治理写任务均与现有持锁记录做冲突检查；未声明 `scope` 时默认按整仓（`.`）处理并认领整仓。只读 `review` 任务不占用写范围。
  - 带 worktree 的写任务在 `apply` 或 `discard` 之前一直持锁（无论处于 `completed`/`failed`/`interrupted` 哪个终态）；不带 worktree、直接改共享工作区的写任务仅在运行期间持锁，到达终态后自动释放（若后续再经 `thread send` 续跑，会在启动前重新校验并占锁）。
  - 判断冲突前会刷新同仓运行中记录的真实状态；若对应 Thread 已不存在则标为 `interrupted`。同一 `requestId` 加同一父 Thread 的重试不与自身冲突。
  - 子会话启动在全局存储锁之外进行，期间由内存中的预留记录（`#pendingClaims`）占住范围与 worktree 路径，不会阻塞无重叠范围的并行派发。
- **防递归执行者护栏**：受治理子任务默认以 `allowNestedDelegation: false` 启动，Host 注入 `CODEXHOST_DELEGATION_ROLE=executor` 并在治理存储登记其身份；执行者尝试再次派发子任务（含普通 `--worktree`）时在建目录前即以 `EXECUTOR_ROLE_FORBIDDEN` 拒绝。确需嵌套时显式传 `--allow-nested-delegation true`。

## 3. Worktree 基线快照、检查验证与补丁集成

1. **受管 Worktree、创建前 preflight 与基线快照**：
   - 受治理的 `--worktree` 一律由 Host 创建：CLI 仅转发 `worktree`、`base`、`includeUncommitted` 与源 `cwd`。Host 在所有入口（CLI、HTTP、MCP、外部客户端）都会丢弃请求体里客户端带来的 `worktreeMetadata` 和 `sourceRepoRoot`。
   - 建 worktree 之前先做 `preflightStart`（参数类型与引用校验、执行者防递归、路由解析、档位规则、范围冲突、父会话归属），不通过就不建目录。worktree 占用检查只在真正启动时做，因为此时 worktree 还未创建。若建好 worktree 后在子 Thread 启动之前失败（例如锁内复检发现范围冲突，错误带 `notStarted: true`），Host 会自动回收刚建好的 worktree 和分支。
   - 受管路径固定为 `<主仓所在目录>/<主仓名>.worktrees/<清洗后的分支名>`；分支名为空、`.` 或 `..`（含清洗后结果）一律拒绝，且拒绝符号链接。`base` 必须是完整提交号（SHA-1 / SHA-256）且是该分支的祖先；worktree 元数据仅保留白名单字段（`path`、`branch`、`base`、`includesUncommitted`、`untrackedCount`、`untracked`）。
   - `--include-uncommitted true`（与 `--base` 互斥）通过 `git stash create` 把源工作区已跟踪的未提交修改纳入新 worktree 基线，并在响应与治理记录中提示未跟踪文件清单（最多列 20 条）。
2. **验证与越界审计**（`codexhost thread verify <thread>` / `POST /v1/thread/verify` / MCP `thread_verify`；`delegate start` / `thread send` 可配合 `--watch true` 传 `--auto-verify true`，`thread watch` 直接支持 `--auto-verify true`，于完成时在后台异步执行并写入通知摘要，不阻塞其他 watch 的轮询与通知；目标必须有治理记录且尚未集成，否则注册时即报 `INVALID_ARGUMENT`，后台 verify 的 “Auto-verify could not run” 仅作兜底）：
   - 仅允许对终态受治理 Thread 执行；同一 Thread 的 `verify`、`apply`、`discard` 与 `send` 按线程级锁（`withThreadLock`）串行化；瞬态 `verifying` 状态不落盘。
   - **先收补丁再跑检查**：先通过临时 Git 索引收集二进制安全补丁（`git diff --cached --binary --no-renames <base> --`）、改动清单与 diffstat，计算越界文件列表 `outOfScope`，再在 worktree 中顺序运行全部 `--check` 命令（结束后清理由检查新产生的未跟踪文件），确保检查产生的文件不会混入补丁或二次验证。
   - 检查进程环境剥离 Host 凭据与端点变量（`CODEXHOST_RUNTIME_ENDPOINT`、`CODEXHOST_RUNTIME_TOKEN`、`CODEXHOST_CLIENT_TOKEN`、`CODEXHOST_CLIENT_TOKEN_FILE`），并在日志中将这些值及匹配敏感键名（`TOKEN`、`SECRET`、`PASSWORD`、`API_KEY` 等，长度 ≥ 6）的环境变量值流式替换为 `[redacted]`；每次 `verify` 以覆盖模式（`w`）重写上次日志。超时或取消时按 Windows `taskkill /T /F` 或 POSIX 进程组终止整棵进程树。
   - 检查遵循 Birdview 语义：`passed`（退出码 `0`）、`failed`（非 `0`，超时记为 `124`）、`not-run`（退出码 `null`）；未声明检查则记为 `unverified`。
3. **打回续跑与补丁应用**（`codexhost thread apply <thread> [--allow-out-of-scope true] [--force true]` / `POST /v1/thread/apply` / MCP `thread_apply`）：
   - 对未集成的受治理 Thread 执行 `thread send` 会清掉上次验证结果（`verifiedAt`/`verifiedTurnId`/`verification` 等）与旧补丁并把状态置为 `running`（同时暂缓该 Thread 的 watch 通知投递，防止在途 `autoVerify` 误发旧轮通知），之后 `apply` 一定会重新验证。对已 `applied` 或 `discarded` 的受治理 Thread（无论是否带 worktree）执行 `thread send` 会报 `ALREADY_INTEGRATED`。
   - `apply` 前先查 Thread 的真实状态，仍在运行报 `THREAD_BUSY`；若 `verifiedAt` 被清掉、补丁文件缺失，或最新 `turnId` 与 `verifiedTurnId` 不一致，则自动重新 `verify`。
   - 存在越界改动时默认以 `OUT_OF_SCOPE` 拒绝（审查后可传 `--allow-out-of-scope true`）；检查失败或非正常结束默认以 `CHECKS_FAILED` 拒绝（可传 `--force true`）。
   - 全局存储锁（`withLock`）只包很短的临界区：派发时的冲突检查加预留、治理记录落盘/清验证，以及把补丁写进源检出（`git apply --check`、`git apply` 以 unstaged 形式落盘并记录 `integration: "applied"`）；随后在锁外清理 worktree 与分支并释放写范围锁。
4. **安全清理与丢弃**（`codexhost thread discard <thread>` / `POST /v1/thread/discard` / MCP `thread_discard`）：
   - 拒绝仍在运行的 Thread（需先 `thread cancel`）。
   - 删除 worktree 时，仅移除“已在 Git 登记、未被 `locked`、分支与记录一致、路径严格等于受管路径且非符号链接”的检出，没有 `rm -rf` 兜底。仅当 worktree 确实被删除，或目录已不存在且 Git 仍登记有对应的未锁定 `prunable` 同分支条目时，才 `prune` 并删除分支。若有目录或分支残留在磁盘上，`discard` 与 `apply` 的结果里都会通过 `note` 字段提示人工核查清理。

## 4. 等待期原生提示词缓存保活（默认关闭，55 分钟）

- **能力契约**：`@codexhost/harness-adapter` 的 `HarnessSession.refreshPromptCache?()` 定义无污染缓存刷新能力；`@codexhost/adapter-claude-code` 通过 Claude Agent SDK 的 `resume + forkSession: true + persistSession: false + maxTurns: 1` 实现单次刷新，不修改工具定义（不设 `tools` / `disallowedTools`）以保持提示词缓存前缀一致，同时通过 SDK `PreToolUse` hook（配合 `canUseTool` 兜底）统一拒绝所有工具调用，即使主会话处于 `bypassPermissions` / `acceptEdits` / allow 规则下也不会执行工具。刷新消耗通过标准 `usage.request` 事件计入当前会话的 Host 内存用量统计（由于 `persistSession: false` 不写入原生 transcript，会话重开或 Host 重启后不会保留之前的刷新用量），并在成功后单调更新最后回复时间与 Composer 的 1 小时 `Prompt cache` 倒计时。
- **Host 调度器**（`PromptCacheKeepAliveService`）：**默认关闭（`enabled: false`）**，需在设置页显式开启。仅在开启且存在活跃 `thread watch` 时按分钟惰性启动定时器；空闲计时以适配器记录的**回复完成时刻**（`turn.completed` / `lastAssistantResponseAtUnix`，含重启后 resume 恢复的历史回复时间）为基准，在距上次回复或刷新达到 `intervalMinutes`（默认 55 分钟）且小于 60 分钟 TTL、距最后真实回复未超 `ceilingHours`（默认 8 小时）时触发刷新；若 Host 重启或会话重载后仅从 transcript 补种到历史时间且已超过 60 分钟但仍在 `ceilingHours` 内，且本进程尚未刷新过该线程，则允许先探测刷新一次（若缓存已冷则立即自动暂停）。线程删除或释放时自动清理状态。
- **TTL 门控与冷缓存自检**：门控按会话实际生效的环境变量检查 `FORCE_PROMPT_CACHING_5M`、`DISABLE_PROMPT_CACHING`（识别 `1/true/yes/on`）、`CLAUDE_CODE_PROMPT_CACHE_TTL=5m`（区分大小写），并在可识别当前会话模型族（`opus`/`sonnet`/`haiku`/`fable`）时按模型族匹配 `DISABLE_PROMPT_CACHING_{OPUS,SONNET,HAIKU,FABLE}`；命中时在拉起子进程前直接返回 `unsupported` 并暂停该会话保活。模型未知或其他禁用缓存配置则由刷新用量兜底拦截：若 `cacheReadInputTokens === 0 && cacheCreationInputTokens === 0 && inputTokens > 0`，判定缓存已禁用并暂停（`cache-disabled`）；若 `cacheCreationInputTokens > cacheReadInputTokens`，判定为冷缓存并暂停（`cold-cache`）。暂时性状态错误（如 `invalidState`、`sessionBusy`）走 5 分钟退避重试，不永久暂停；`off`/`cold-cache`/`cache-disabled` 在真实回合后继续保持，仅在显式执行 `on`（全局或按线程）后解除。
- **空闲释放保护**：`ExternalThreadIdleRelease` 避让所有仍有活跃 watch 的规划者 Thread（包括 Remote Control 与远程会话连接上的二级 Host 实例），防止等待期间被卸载；二级 Host 接入时自动继承当前聚合的全局或按线程暂停状态。
- **已知限制**：
  - 刷新产生的用量仅保存在当前会话内存中，会话重开或 Host 重启后会丢失，不会持久化到 transcript。
  - 空闲计时基准为回复完成时刻而非请求开始时刻，因此耗时较长的单次回复会吃掉 55 分钟刷新间隔与 60 分钟缓存 TTL 之间的余量。
  - 为保持与主会话一致的系统提示和缓存前缀，fork 刷新未传入 `settingSources: []` 或 `disableAllHooks`，因此用户本地配置的 `SessionStart`、`UserPromptSubmit`、`Stop` 等外部 hook 在每次刷新时仍可能触发；此外，新进程系统提示中的动态快照（如 `git status`）对真实命中率的影响仍需在真机订阅会话中核验。
- **查看与开关**：`codexhost thread keepalive [status|on|off] [--thread <id>]`、`POST /v1/thread/keepalive`、MCP `thread_keepalive`；保活默认关闭，需在 Desktop 外观/资源设置页或 Web 资源设置页开启，`on`/`off` 只是解除或施加暂停，不会在默认关闭时启动保活。偏好配置持久化在 `harness-preferences-v1.json` 的 `promptCacheKeepAlive` 字段，并在设置页提供刷新间隔与最长窗口配置。

## 5. 托管技能

`codexhost-delegation` 托管技能（`packages/host-runtime/src/delegation-skill.ts`）已升级至 **v17**，纳入分档路由、范围/检查与受治理 worktree 闭环指引，并明确提示词缓存保活需先开启才会生效。
