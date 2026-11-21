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

- CLI：`codexhost delegate routing show|set <key> <value>|unset <key> [--cwd <path>] [--user true|false]`
- HTTP：`POST /v1/delegate/routing/show|set|unset`
- MCP：`delegate_routing`
- Desktop / Web 设置页：通过 `codexhost/delegation/routing/get` 与 `codexhost/delegation/routing/set` RPC 直接查看和保存用户级 profile 及 `deep`/`light`/`review` 映射。

可写键名：`profile`、`plannerProfiles.<harnessId>`、`profiles.<name>.<deep|light|review>`（格式 `harnessId[:model][@thinking]`）、`checks.timeoutMinutes`、`checks.shell`、`light.maxScopeEntries`、`light.maxChangedFiles`。所有写入先校验完整合并配置，再以原子替换落盘。

## 2. 写范围冲突锁与防递归护栏

- **路径归一化**：`--scope` 仅接受项目相对路径（禁止 `..`、`.git`、前导 `/`、反斜杠与控制字符），按目录前缀判定覆盖关系。
- **并发写范围冲突锁**：治理记录持久化在 `<数据目录>/delegation-jobs/`。写任务在运行期间以及完成后尚未 `apply` / `discard` 期间继续持有其范围；同仓库新写任务与之重叠时在派发前以 `SCOPE_CONFLICT` 拒绝。只读 `review` 任务不占用写范围。
- **防递归执行者护栏**：受治理子任务默认以 `allowNestedDelegation: false` 启动，Host 注入 `CODEXHOST_DELEGATION_ROLE=executor` 并在治理存储登记其身份；执行者尝试再次派发子任务时以 `EXECUTOR_ROLE_FORBIDDEN` 拒绝。确需嵌套时显式传 `--allow-nested-delegation true`。

## 3. Worktree 基线快照、检查验证与补丁集成

1. **基线快照**：`delegate start --worktree <branch> --include-uncommitted true`（与 `--base` 互斥）通过 `git stash create` 把源工作区已跟踪的未提交修改纳入新 worktree 基线，并在响应与治理记录中提示未跟踪文件清单。省略 `--include-uncommitted` 时沿用原有 `HEAD` 语义。
2. **验证与越界审计**（`codexhost thread verify <thread>` / `POST /v1/thread/verify` / MCP `thread_verify`，或在 `delegate start`/`thread send`/`thread watch` 传 `--auto-verify true` 于完成时自动触发并写入通知摘要）：
   - 仅允许对终态 Thread 执行；在对应 worktree 中顺序运行全部 `--check` 命令（超时或取消时按 Windows `taskkill /T /F` 或 POSIX 进程组终止整棵进程树）。
   - 检查遵循 Birdview 语义：`passed`（退出码 `0`）、`failed`（非 `0`，超时记为 `124`）、`not-run`（退出码 `null`）；未声明检查则记为 `unverified`。
   - 收集二进制安全补丁（`git diff --cached --binary --no-renames <base>`）、改动清单与 diffstat，计算越界文件列表 `outOfScope`。
3. **补丁应用**（`codexhost thread apply <thread> [--allow-out-of-scope true] [--force true]` / `POST /v1/thread/apply` / MCP `thread_apply`）：
   - 若尚未验证则自动执行一次验证。
   - 存在越界改动时默认以 `OUT_OF_SCOPE` 拒绝（审查后可传 `--allow-out-of-scope true`）；检查失败或非正常结束默认以 `CHECKS_FAILED` 拒绝（可传 `--force true`）。
   - 先执行 `git apply --check` 干跑校验（冲突返回 `APPLY_CONFLICT`），通过后以 unstaged 形式落盘到源工作区，先记录 `integration: "applied"` 再清理 worktree 与分支并释放写范围锁。
4. **丢弃清理**（`codexhost thread discard <thread>` / `POST /v1/thread/discard` / MCP `thread_discard`）：
   - 拒绝仍在运行的 Thread（需先 `thread cancel`）；清理 worktree 与分支，记录 `integration: "discarded"` 并释放写范围锁。
