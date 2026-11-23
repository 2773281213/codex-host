# 委派的独立 Git worktree

`delegate start --worktree <branch>` 为该次委派创建分支和独立 Git worktree，并将新路径作为子 Thread 的 `cwd`。创建位置按是否受治理分流：

- **普通 `--worktree`**（未传入任何治理参数，无论是否传 `--include-uncommitted`）：CLI 在本地创建分支和 worktree，只向 Runtime 发送有效 `cwd`；HTTP `POST /v1/delegate/start` 与 MCP `delegate_start` 在接收请求的 Host 上创建。普通 `--worktree` **不受治理**：不写治理记录，没有执行者角色，不占写范围锁，不支持 `verify` / `apply` / `discard`。
- **受治理 `--worktree`**（显式传入 `tier`、`profile`、非空 `scope`/`checks`、非空白 `acceptance`，或 `allowNestedDelegation: false`）：**所有入口（CLI、HTTP、MCP、外部客户端）一律由 Host 创建**。CLI 只转发 `worktree`、`base`、`includeUncommitted` 与解析后的源 `cwd`，不先在本地建目录；Host 丢弃请求体里客户端自带的 `worktreeMetadata` 和 `sourceRepoRoot`。

CLI 和 Host 共用 `delegation-worktree.ts` 的创建与失败处理逻辑。这不是 Harness 原生隔离选项，也不改变未指定 worktree 的委派行为。

```sh
codexhost delegate start --harness pi --task "检查协议边界" \
  --cwd /projects/app --worktree review/protocol --base HEAD
```

## 路径与基线

- CLI 源 checkout 使用 `--cwd`；相对路径按 CLI 进程当前目录解析。省略时使用 CLI 当前目录，不读取父 Thread 或 Runtime 的 cwd。CLI 在创建本地 worktree 或向 Host 转发前解析为绝对路径。
- HTTP / MCP 使用请求中的 `cwd` 作为源 checkout；使用 `worktree` 时必须显式传绝对路径，即使有父 Thread 也不继承目录。Host 拒绝相对路径或缺失 cwd，不按自身当前目录推断。
- `--base <ref>` 仅与 `--worktree` 一起使用，默认是源 checkout 的当前 `HEAD`，包括 detached HEAD。先解析为完整提交 SHA，再从该提交创建分支；不会复制源目录的未提交修改，也不会推断远端默认分支或 fetch。若需要把源工作区已跟踪的未提交改动纳入基线，可传 `--include-uncommitted true`（与 `--base` 互斥），通过 `git stash create` 生成快照提交并报告未跟踪文件（最多列 20 条）。
- 位置固定为主仓库所在目录同级的 `<主仓名>.worktrees/<清洗后的分支名>`。分支名中的非 ASCII 字母、数字、`.`、`_`、`-` 字符替换成 `-`，Git 分支名本身保持原样；分支名为空、`.` 或 `..`（含清洗后结果）一律拒绝，且拒绝符号链接。例如 `/projects/app.worktrees/review-protocol`，分支为 `review/protocol`。
- 从已有 linked worktree 或仓库子目录调用时，目录位置仍以主仓库为准，基线则取源 checkout。
- CLI JSON / compact、HTTP 和 MCP 返回相同的 `worktree: {path, branch, base}`（开启 `--include-uncommitted` 时另含白名单字段 `includesUncommitted`、`untrackedCount`、`untracked`）；`base` 为实际使用的完整提交号，且在受治理校验中要求是该分支的祖先。普通 `--worktree` 经 CLI 本地创建后只向 Runtime 发送有效 `cwd`，不重复创建；受治理 `--worktree` 与 HTTP/MCP 请求均由 Host 控制路由创建后再将有效 `cwd` 交给委派接口。

## 校验与失败

CLI 和 Host 不判断任务是否应该使用 worktree，不在正常响应中输出工作流建议。指定 worktree 时，以下情况在创建目录与启动委派前报错：

- 调用方为受治理执行者（`CODEXHOST_DELEGATION_ROLE=executor` 或已登记执行者 Thread），在建目录前即以 `EXECUTOR_ROLE_FORBIDDEN` 拒绝；受治理请求在建目录前还会先跑 `preflightStart`（路由、tier 规则、范围冲突、父会话归属），不通过就不建目录；worktree 占用检查在真正启动时执行，因为 preflight 时 worktree 还未创建。
- 源 cwd 不是 Git working tree；源 checkout 正在 merge、rebase，或索引仍有冲突。
- 分支名非法（含空、`.`、`..`）、同名本地分支存在，或安全化后的目标目录存在（包括空目录、文件及符号链接）。不覆盖现有对象。
- `--base` 无法解析为提交（默认 HEAD 也必须可解析）。

目标目录通过排他创建预留。创建 Git 分支或 checkout 失败时，错误会报告可能遗留的 `details.worktree` 和 `worktreeRetained: true`；分支创建前失败会尝试移除本次预留的空目录，不删除已有目录或分支。

委派启动失败时的处理分两种情况：

- **普通 `--worktree`**：Runtime 请求或 Host 委派失败时保留已创建的 worktree 和分支，并在错误中明确返回 `details.worktree` 与 `worktreeRetained: true`，保留原错误代码及其他 details（请求失败或响应丢失不能证明子 Thread 未启动，因此不删除可能正被使用的工作目录）。
- **受治理 `--worktree`**：若在子 Thread 启动之前失败（例如锁内复检发现范围冲突，错误带 `notStarted: true`），Host 会自动回收刚建好的受管 worktree 和分支并返回原错误；仅当回收失败或子 Thread 可能已启动时才保留并报告 `worktreeRetained: true`。

watch 注册失败仍返回成功委派及 worktree，`watch` 中报告 `notRegistered`。

成功创建的 worktree 不自动合并或清理，不安装依赖。普通 `--worktree` 的清理由调用方在确认没有活动会话后显式进行，对其调用 `thread verify` / `apply` / `discard` 会报 `THREAD_NOT_FOUND` 并提示使用 `--tier`、`--scope` 或 `--check` 发起。受治理的 worktree 委派可通过 `thread verify`、`thread apply` 和 `thread discard` 完成检查、补丁落盘与受管目录/分支的安全清理（无 `rm -rf` 兜底，见 [委派治理](delegation-governance.md)）。对已存在分支或目录的重试仍报重名错误；`--request-id` 不使 worktree 创建变成可复用操作。
