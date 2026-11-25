# GraphFS

工作区的**一致性图**：节点是文件，边是"必须保持一致"的关系，边上记录两端内容指纹。
改了一个文件，沿着边算出"谁因此过期了"，把结果交给调用方（模型 / CI / 编辑器）。

当前进度：**M0–M7 全部交付**。核心判定、DSH 插件、确定性传播、审计/锁、
`README.i18n.yaml` 导入器、本地监控面板、**询问式自动初始化与变更确认**都已落地；
259 个用例全绿。

---

## 0. 前置

| 项    | 要求                                             |
| ---- | ---------------------------------------------- |
| Node | **≥ 22.6**（依赖内置 TypeScript 类型擦除；本机 v24.18.0 ✅） |
| 依赖   | **无**。没有 `npm install`，没有构建步骤，`node` 直接跑 `.ts` |
| 平台   | macOS / Linux（Windows 未测）                      |

> 不需要先 `pnpm install`。克隆下来就能跑。

---

## 1. 三十秒验证

```bash
cd "/Users/zfyang/Documents/文件/AI Agent/GraphFS"

npm test                              # 259 个用例，约 7 s（含 321 包金标准）
node src/cli/main.ts help             # 打印用法
```

---

## 2. 在一个真实工作区上跑

```bash
cd "/Users/zfyang/Documents/文件/AI Agent/GraphFS"

# ① 建图：扫描工作区 → 生成 <repo>/.graphfs/graph.yaml
#    --suggest 会顺手采纳高置信候选边（import / 链接 / @generated / 译文对）
node src/cli/main.ts init --root /path/to/your/repo --suggest

# ② 校验：干净退出 0，有漂移退出 1
node src/cli/main.ts check --root /path/to/your/repo

# ③ 规划：谁该因为谁而更新
node src/cli/main.ts plan --root /path/to/your/repo
```

`--root` 必须是绝对路径（相对路径会被转成绝对）。图默认落在 `<root>/.graphfs/graph.yaml`，
`--graph <file>` 可以把它放到仓库外（只读挂载、CI 模板、不想弄脏 git 时用）。

**改一个文件看看效果**：

```bash
echo "# touched" >> /path/to/your/repo/README.md
node src/cli/main.ts check --root /path/to/your/repo   # → DRIFT，exit 1
node src/cli/main.ts plan  --root /path/to/your/repo   # → 列出义务
```

---

## 3. 命令一览

| 命令        | 作用                   | 关键选项                                                                               |
| --------- | -------------------- | ---------------------------------------------------------------------------------- |
| `init`    | 建图 + **自动建关系**       | `--force` 覆盖；`--no-suggest` 只建骨架（默认自动采纳 import/#include/译文/同名测试）                   |
| `suggest` | 发现候选边（**只读**，没有图也能跑） | `--write` 采纳；`--min-confidence 0.7`；`--from-file <json>` 并入模型提案；`--all` 全量重扫       |
| `attach`  | 把**新文件**接进图          | `--to <node> --relation <r> [--as from\|to]`；或 `--unmanaged`                       |
| `check`   | 只读校验                 | `--json`；漂移时退出码 1                                                                  |
| `plan`    | 规划义务                 | `--json`                                                                           |
| `status`  | 图概览                  | `--json`                                                                           |
| `link`    | 手工建边                 | `--from` `--to` `--relation`，可选 `--authority/--trigger/--counterpart/--obligation` |
| `apply`   | 执行确定性边（producer）     | 默认 dry-run（真跑 + diff + 还原）；`--apply --yes` 写盘；`--edge <id>`                        |
| `ack`     | 认可漂移、重录基线并写审计        | `--reason "<为什么接受>"`（必填）                                                           |
| `journal` | 查看审计日志               | `--limit 50`；`--json`                                                              |
| `import`  | 批量导入（目前 `i18n`）      | `--dir`、`--write`；i18n 强制 `normalize=dsh-i18n-v1`                                  |
| `ui`      | 只读监控面板（本地 HTTP）      | `--port 8787`、`--host 127.0.0.1`                                                   |
| `help`    | 用法                   |                                                                                    |

关系与强度（详见 `GraphFS_Intent.md` §3.5）：

| relation     | 方向语义                  | 默认强度                     |
| ------------ | --------------------- | ------------------------ |
| `mirror`     | 两份内容必须相同              | required，`trigger: both` |
| `translates` | 逐节对应（如 en/zh）         | required                 |
| `generates`  | 产物由源生成                | required（auto）           |
| `documents`  | 代码 → 文档               | advisory                 |
| `constrains` | 框架 → 代码（改框架要改代码，反向不必） | advisory                 |
| `related`    | 只是相关                  | silent                   |

---

## 3.4 新建文件必须声明关系

工作区里出现新文件时，三选一，否则 `check` 会把它列成**孤儿**：

```bash
# ① 给出至少一条边（推荐：新建时就声明）
node src/cli/main.ts attach src/parser.ts --to src/api.ts --relation constrains --as to --root /repo

# ② 声明「不需要一致性」（图片、压缩包、生成物）
node src/cli/main.ts attach assets/logo.png --unmanaged --root /repo

# ③ 命中 ignore（依赖目录、构建产物）——在配置里排除
```

`--as to` 表示新文件是"被影响方"（默认）：`api` 变了，`parser` 可能要跟着改。
`--as from` 则相反：新文件是事实源。

插件里这条规则由 `graphfs_create` 工具强制（写文件 + 声明关系同一个调用，见 Spec §8.6）；
如果模型绕道用 `write` 建文件，回合结束时的孤儿闸门会补一条义务。

## 3.5 两种候选边：规则 + 模型

规则（import / 链接 / `@generated` / 译文对）只能看见**结构**；语义关系（"这个脚本消费那个脚本的输出"）
要靠模型。两者可以合并：

**触发时机只有两个**：`init` 时一次、或用户显式要求。不会在每次变更后自动跑——
一次建议要读若干文件（几万 token），放进回合循环等于每回合交税。

默认是**增量**的：只对「未覆盖的文件」提案（不在图里 / 在图里但没有边 / 非 unmanaged），
已经建过的边不再重复提。

```bash
# 1. 规则候选（增量）
node src/cli/main.ts suggest --root /path/to/repo

# 2. 模型提案（JSON，由 agent 读完代码后给出）
node src/cli/main.ts suggest --root /path/to/repo --from-file demo/proposals.code.json

# 3. 合并后采纳（同一对端点只留一条，来源标 both）
node src/cli/main.ts suggest --root /path/to/repo \
  --from-file demo/proposals.code.json --write --min-confidence 0.8
```

提案格式：

```json
{ "candidates": [
  { "fromPath": "main.py", "toPath": "README.md", "relation": "documents",
    "confidence": 0.8, "evidence": "README 逐条列出 main.py 的参数" } ] }
```

安全边界：`policy` 不可由提案指定、`evidence` 必填、端点必须已存在、仍走建边校验。

## 3.6 接入模型提边

**先填 key**（文件已生成，`apiKey` 留空）：

```bash
node src/cli/main.ts llm setup --local     # 写 <repo>/.graphfs/llm.json（0600，已 gitignore）
node src/cli/main.ts llm status            # 看生效配置，key 只显示掩码
```

优先级：`GRAPHFS_LLM_*` 环境变量 > `GRAPHFS_LLM_CONFIG` 指定的文件 > **目标工作区** `.graphfs/llm.json`

> **当前目录** `.graphfs/llm.json`（工具自己的配置）> 全局 `~/.config/graphfs/llm.json`。

所以 `cd GraphFS && graphfs suggest --deep --root /别的仓库` 也能用 GraphFS 目录下配好的 key。

**三种用法**：

```bash
# ① 只看提示包（不花钱）：把输出丢给任何模型
node src/cli/main.ts suggest --root /repo --pack

# ② 直接调模型（需要 key）
node src/cli/main.ts suggest --root /repo --deep

# ③ 调模型并采纳（单次最多 50 条，防图爆炸）
node src/cli/main.ts suggest --root /repo --deep --write --min-confidence 0.8
```

`--deep` 会把「文件清单 + 顶层符号 + import + 规则候选 + 方向约定 + 输出 schema」打包，
要求模型只回 JSON；回来的每条仍要走 §3.5 的校验（证据必填、端点必存在、policy 不可指定）。

## 3.7 审计与「认可」

`ack` 是唯一合法的"关闭义务"方式，因此**必须留下记录**。审计写在
`<graph>/.graphfs/audit/journal.jsonl`（与图同目录，一行一条 JSON），
记录 `at / kind / actor / edgeId|node / detail`：

```bash
node src/cli/main.ts ack <edgeId> --reason "这次只改了格式，内容没变" --root /repo
node src/cli/main.ts journal --root /repo --limit 20
```

会进审计的操作：`init / link / attach / ack / apply / import / refuse`（拒绝新建无关系文件）。
追加失败**不会**中断业务（磁盘满、只读挂载时降级为"不记"）；
日志超过 1 MiB 轮转成 `journal.jsonl.1`，只保留一代。

同一个工作区被 CLI 与 DSH 同时写时，图的读-改-写由跨进程文件锁（`.graphfs/lock`）串行化；
持锁进程死掉后锁可被抢（pid 检查 + 超时），抢不到时给出 `GF_LOCK_TIMEOUT` 而不是无限等待。

## 3.8 导入 `README.i18n.yaml`

给 DSH 这类"每个包中英文双 README + 分节哈希账本"的仓库批量建边：

```bash
node src/cli/main.ts import i18n --root /repo/packages --write
# → 每个账本记录一条 translates 边，基线 = 账本里的 en/zh 指纹
```

- 账本键与文档顺序一致，**按位置对齐**（少数标题的 slug 规则与账本实现不同，不能按字符串配对）；
- 复算不上的记录（生成区域、跨文件链接重写）**不阻断导入**，进入 `unverified` 清单并写入 issue；
  基线仍然是账本值——绝不静默换成"看起来对"的哈希；
- 中英标题数不一致的包整包跳过（`GF_UNIT_MISMATCH`）；
- 账本文件本身标为 `unmanaged`，不算孤儿。

黄金回归（本机有 DSH 安装包时自动启用）：321 个包 / 5,875 条记录导入零差异，
其中 4,363 条（74.3%）可用同一套规则复现，其余 1,512 条与账本的已知 26% 缺口一致。
详见 `M5-report.md`。

## 3.9 监控面板

```bash
node src/cli/main.ts ui --root /repo
# GraphFS 面板：http://127.0.0.1:8787/
```

只读：概览卡片（节点/边/漂移/冲突/缺失/孤儿）、漂移表、审计时间线、canvas 图视图
（悬停看路径，点击看入射关系）。服务只绑定 127.0.0.1，没有静态文件路由；
数据来自 `/api/overview`、`/api/graph`、`/api/journal`。详见 `M6-report.md`。

## 3.10 自动化：问一次，然后一直有效

| 时机                     | 行为                                                                        |
| ---------------------- | ------------------------------------------------------------------------- |
| 新工作区第一次结束回合            | 弹出「要现在建立一致性图吗？」→ 同意后建图并自动采纳高置信关系（默认 `autoInit: ask`）                      |
| 改了有关系的文件               | 回合结束弹出「这些文件可能过期，要我一并修改吗？」→ 同意则继续本回合改；拒绝则不再追问同一次漂移（默认 `askOnChange: true`） |
| 没有交互式 UI（CLI/headless） | 退回把问题交给模型：注入提示 + steer                                                    |

配置（profile 的 `cordis.patch.yml` 或插件配置里改）：

```yaml
config:
  autoInit: ask        # ask | always | never
  askOnChange: true    # false = 只 steer，不弹框
```

弹框走宿主自己的 `userQuestions` 服务，和内置 `ask_user_question` 是同一套 UI；
子 agent 不是 live root，因此不会弹框，自动退回 steer。

## 4. 端到端演示

```bash
npm run demo        # 拿一份真实 Python 工程的副本跑完整闭环
cat demo/transcript.txt
```

演示脚本会：建图 → 建三条边 → 校验 → 只 `touch`（应仍干净）→ 改框架侧（应产生义务）
→ 改代码侧（应零义务、只走 counterpart）。

---

## 5. 当库用

```ts
import { GraphFS } from './src/workspace/graphfs.ts'

const gfs = await GraphFS.open({ root: '/path/to/repo' })
const report = await gfs.check()
if (!report.ok) {
  console.log(report.drift, report.conflicts, report.dangling)
}

const plan = await gfs.plan()
for (const obligation of plan.obligations) {
  console.log(`${obligation.severity}: 更新 ${obligation.target}（因 ${obligation.cause}）`)
}
```

候选边也可以直接拿来做定制流程：

```ts
const candidates = await gfs.suggest()          // 只提议
await gfs.applySuggestions(candidates, { minConfidence: 0.8 })
```

---

## 5.5 装进 DSH

### 方式 A：图形界面（推荐）

1. 先构建一次（GUI 对本地目录不会跑 `prepare`）：
   
   ```bash
   npm run build      # 产出 lib/，共 51 个文件
   ```

2. DSH → 设置 → 插件 → 添加插件 → 安装源选「自定义地址」，填：
   
   - **本地目录**：`/Users/zfyang/Documents/文件/AI Agent/GraphFS`
   - 或 **GitHub 仓库地址**（仓库含 `scripts/build.mjs` 即可，`prepare` 会自动构建）

3. 重启 DSH。

包内声明了 `dsh.bundle.patch`，DSH 会把它登记成 profile layer 并自动应用自带的
`cordis.patch.yml`（插件行 `name: ./lib/index.js`，锚定到包目录，不依赖包名解析）。

### 方式 B：脚本兜底（离线 / 无 pnpm）

```bash
node scripts/install.mjs            # dry-run
node scripts/install.mjs --yes      # 复制到 profile 并登记 bundle
```

插件**零运行时依赖**（不需要 `@deepseek-ai/dsh-tools` / `schemastery`），
所以两种方式都不会去 registry 拉包，也不会出现两份 cordis 的身份冲突。

> 根目录**按会话解析**：插件用 `ctx.workingDirectory.ensure(agent, signal)` 拿当前工作区，
> 不是 `process.cwd()`（后者是 DSH 常驻进程的 profile 目录）。同一个 profile 服务多个项目时，
> 每个项目各自有一份 `.graphfs/graph.yaml`。

## 6. 产物与文件布局

```
<repo>/.graphfs/graph.yaml              # 图 + 两端指纹（建议入库，可 review）
<repo>/.graphfs/audit/journal.jsonl     # 审计日志（可入库，也可 gitignore）
<repo>/.graphfs/lock                    # 跨进程锁（瞬时文件，必须 gitignore）
```

图是**受限 YAML 子集**（块状映射/序列、行内标量/数组、注释）。不支持行内映射 `{a: 1}`、
锚点、多行字符串 `|`；遇到会报 `GF_GRAPH_INVALID` 并给行号，不猜。

归一化口径记录在图文件里：打开图时默认**采用记录值**（例如 i18n 图是 `dsh-i18n-v1`），
只有显式 `--normalize` 才覆盖——否则"打开就全是漂移"会非常难排查。

---

## 7. 当前边界（别期待这些）

| 还没做                      | 原因                                 |
| ------------------------ | ---------------------------------- |
| `enforce` 拒写派生物（在写路径上拦截） | v2：需要替换宿主的写工具，不是本插件能单方面做到的         |
| 分布式/多机锁                  | 单机文件锁足够；Spec §13 列为非目标             |
| 宿主内的原生 UI 面板             | 面板做成独立本地服务（M6），不依赖宿主是否打开           |
| 翻译质量判定                   | 哈希只判"动没动"                          |
| `@generated` 之外的语义边界学习   | 目前靠 `graphfs_suggest` 的模型路径，不做在线学习 |

`check` / `plan` / `journal` / `ui` 都是**只读**的；会写文件的只有 `init/attach/link/apply/ack/import`，
且都需要显式参数。

---

## 8. 排错

| 现象                         | 原因 / 处理                                                                                                                                                          |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `root must be absolute`    | 用绝对路径，或让 CLI 相对当前目录解析（`--root ./x` 会被转绝对）                                                                                                                        |
| `no graph at ...` + remedy | 还没 `init`；或 `--graph` 指错了                                                                                                                                        |
| `invalid graph file`       | YAML 用了不支持的写法（行内映射 / Tab / 重复键），按行号改                                                                                                                             |
| `path escapes workspace`   | 节点路径跑到了 root 外（`..`）                                                                                                                                             |
| 二进制/超大文件出现在 `unhashable`   | 正常：它们不参与判定，但被它们牵连的边会跳过                                                                                                                                           |
| 没看到「要建立图 / 要一并修改」的弹框       | 先调 `graphfs_status` 看 `interactive` 与 `lastAskError`：`interactive:false` = 插件拿不到 `userQuestions` 服务；有 `lastAskError` 会直接写明原因（如子 agent、回合已取消）。改完 `lib/` 后需要重启 DSH |
| 已有图的工作区不再问初始化              | 正常：只在没有 `.graphfs/graph.yaml` 时问。补关系用 `init`（增量）或 `graphfs_suggest({apply:true})`                                                                                |
| 弹框被关掉了                     | 检查配置：`autoInit: never`、`askOnChange: false`、`mode: observe` 都会关闭对应提示                                                                                             |

---

## 9. 文档地图

| 文件                              | 内容                     |
| ------------------------------- | ---------------------- |
| `GraphFS_Intent.md`             | 为什么这么设计：判定公理、强度阶梯、循环治理 |
| `GraphFS_Spec.md`               | 逐文件实现契约（开工文档）          |
| `GraphFS_实现结构.md`               | 模块划分与依赖方向              |
| `M0-report.md` … `M7-report.md` | 各里程碑交付内容、偏差与未验证项       |
| `GraphFS_v1.1_工作区独立版.md`        | 一段被部分撤销的架构尝试（留着当决策记录）  |
