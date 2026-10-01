# LLM Gateway

通用桌面版 LLM 网关。把十几种上游模型服务（OpenAI / Anthropic / 各家中转）聚合成**一个本地端点 + 一把 Key**，
并支持**一键写入** dsh / Claude Code / Codex / iFlow / OpenCode 等客户端的配置。

从 `dsh-app` 的模型网关部分拆分而来，网关引擎**逐行未改**（可用脚本验证，见下文「引擎零差异」）。

---

## 快速开始

```powershell
# 开发运行（源码树）
npm install
npm start

# 打安装包 + 单文件便携 exe（electron-builder）
npm run dist
#   dist\LLMGateway-Setup-<版本>-x64.exe      安装版（NSIS，可选安装目录）
#   dist\LLMGateway-Portable-<版本>-x64.exe   单文件绿色版：双击即用，无需安装
#   dist\win-unpacked\                        未打包的解包目录

# 打绿色免安装目录（解压即用，数据随目录走）+ zip
npm run portable
#   out\LLM-Gateway\LLM Gateway.exe           绿色目录
#   out\LLM-Gateway-<版本>.zip                分发用 zip

npm run icon     # 仅生成图标（程序化绘制，零外部素材）
```

两种绿色形态都满足"免安装"，按需选：

| 形态 | 适合 | 数据位置 |
|---|---|---|
| **单文件便携 exe** | 丢进 U 盘/任意目录双击就跑 | exe 同级的 `data\`（靠 electron-builder 注入的 `PORTABLE_EXECUTABLE_DIR` 定位——它会把程序自解压到临时目录，直接用 `process.execPath` 会把数据丢在临时目录里，这点已专门处理） |
| **绿色目录 / zip** | 团队分发、想看清里面有什么 | 目录内的 `data\` |

两者都不需要目标机器预装 Node.js，也不需要安装 .NET/运行库。

首次启动会**自动尝试导入** dsh-app / DSH 桌面助手已有的 `gateway.config.json`（那里面是你的真实供应商与密钥），
免得重填一遍。绿目录被复制到别处后自动探测找不到，可在「设置 → 配置文件 → 从文件导入…」手动指路。

---

## 它能做什么

### 一个端点，一把 Key

| 项 | 值 |
|---|---|
| OpenAI 兼容 | `http://127.0.0.1:<端口>/v1` |
| Anthropic 兼容 | `http://127.0.0.1:<端口>` ← **不带 /v1** |
| 统一 Key | 界面「概览」页一键复制 |

支持的协议：`POST /v1/chat/completions`、`POST /v1/responses`（含取回 / 取消 / 删除 / input_items 子路由）、
`POST /v1/messages`、`GET /v1/models`、`GET /health`。

### 网关引擎能力（全部保留自 dsh-app）

- **多供应商路由**：按 `priority` 升序，同级内按列表顺序；支持「主备」与「负载均衡（轮询）」两种策略
- **自动故障切换 + 分级熔断**：401/403 与「余额/额度」类拒绝断 30 分钟；网络/5xx 连续 3 次断 90 秒，指数退避
- **半开探测**：冷却后放**一个**探测请求试上游；供应商显式声明 `timeoutMs` 时探测也按它执行
- **账户池**：同一供应商多把 Key 轮换；额度耗尽（账户级）/ 登录失效（账户级）/ 限流（**模型级**）分别冷却
- **WorkBuddy 接入**：直接读腾讯 CodeBuddy 桌面版的登录凭据并自动刷新，多账号池
- **客户端仿真**：`claude` / `codex` / `cline` 三档，按主机名自动推断，也可逐家覆盖
- **SSE 透传**、**密钥打码**、**thinking 能力自动学习**、**图片（vision）路由**、**模型映射（上游 ID ↔ 逻辑名）**

### 界面（相对原设置页重做）

- **概览**：运行状态、接入信息（点一下即复制）、**账户池与冷却可视化**（原界面从未展示过 `/health` 的这些数据）
- **供应商**：**拖拽排序**、内联启用开关、**逐家连通性测试**、**从上游拉取模型目录**、抽屉式编辑器（含协议/quirks/请求头/超时/账户池等全部高级字段）
- **模型**：汇总所有客户端可选的逻辑模型，标出「只有一家提供」的单点风险
- **客户端接入**：每个目标都有 **检测状态 → 预览 diff → 写入 → 一键恢复备份**
- **设置**：端口、路由策略、客户端仿真、代理（含直连清单）、应用偏好、配置导入导出、原始 JSON 编辑
- **日志**：关键字过滤、级别着色、自动滚动

---

## 一键写入：端点约定（最容易填错的地方）

各个客户端对 `baseURL` 的要求**恰好相反**，这是实测与官方文档共同确认的：

| 客户端 | 配置文件 | baseURL | 说明 |
|---|---|---|---|
| **dsh** | `~/.dsh/settings.yaml` + `.credentials.yaml` | 由「客户端仿真」决定 | `claude` → `http://127.0.0.1:PORT`（不带 /v1）；其余 → 带 /v1 |
| **Claude Code** | `~/.claude/settings.json` 的 `env` 段 | `http://127.0.0.1:PORT`（**不带 /v1**） | 客户端自己拼 `/v1/messages`；写成带 /v1 会变 `/v1/v1/messages` → 404 |
| **Codex** | `~/.codex/config.toml`（+ `auth.json`） | `http://127.0.0.1:PORT/v1`（**要带**） | Codex 把 `/responses` 拼在其后 |
| **iFlow CLI** | `~/.iflow/settings.json` | `http://127.0.0.1:PORT/v1` | 会把 OAuth 登录切成 API Key 模式 |
| **OpenCode** | `~/.config/opencode/opencode.json` | `http://127.0.0.1:PORT/v1` | 新增一个 `@ai-sdk/openai-compatible` provider |
| **通用** | `<数据目录>\clients\` | 两种都生成 | 环境变量脚本 + 端点速查，覆盖 Aider / Continue / Cline / Roo / Chatbox 等 |

### 三条硬保障

1. **写前必备份**：原文件复制为 `.bak-llmgateway`（已存在则不覆盖，保留最原始那份）；备份失败**中止写入**。
2. **只动自己那一块**：JSON 用「读-改-写」、TOML 用定点表替换。你 `settings.json` 里的几十个插件、
   `config.toml` 里的 `[mcp_servers.*]` / `[projects.*]`、`opencode.json` 里其它 provider 全部原样保留。
3. **可一键恢复**：界面上每个目标都有「恢复备份」，恢复后与原始内容**逐字节一致**（有测试锁死）。

### 哪些不做

- **Cline / Roo Code**：它们的 API Key 存在 VS Code 凭据库（DPAPI `v10` 密文）里，且 3.78 起改用 protobuf
  状态层——外部写入既不可靠也不安全。这类客户端只在「通用」目标里给出字段值，请手工填。
- **Gemini CLI**：走 Gemini 原生 API（`/v1beta`），本网关不提供该协议；官方也没给在 `settings.json` 里写
  baseURL 的键。接不进来。

---

## 数据与配置

| 项 | 位置 |
|---|---|
| 数据目录 | 优先 `<exe 所在目录>\data\`（绿目录，复制即迁移）；源码直跑用 `<项目根>\data\`；回退 `%APPDATA%\llm-gateway\` |
| 网关配置 | `<数据目录>\gateway.config.json` |
| 应用设置 | `<数据目录>\settings.json` |
| 网关日志 | `<数据目录>\logs\gateway.log`（引擎写） |
| 应用日志 | `<数据目录>\logs\app.log`（界面报错也会进这里） |
| 崩溃现场 | `<数据目录>\crash\`（网关反复异常退出时固化，含脱敏后的配置摘要） |

环境变量覆盖：`LLM_GATEWAY_DATA_DIR`（数据目录）、`LLM_GATEWAY_IMPORT_CONFIG`（指定导入来源）、
`DSH_GATEWAY_*`（引擎的端口/超时/熔断等旋钮）。

---

## 测试与校验

```powershell
npm test                    # 253 项，全绿
npm run parity              # 引擎相对 dsh-app 版本的差异是否与"声明清单"一致
npm run check               # 语法检查
npm run test:models         # 模型全量体检：逐个模型真跑一次（见下）
```

| 套件 | 项数 | 覆盖 |
|---|---|---|
| `tests/unit.js` | 54 | 纯函数与文件读写：原子写/备份/恢复、TOML 词法、脱敏、模型清单推导、**模型元数据与自动映射**、配置校验、代理解析、Settings |
| `tests/writers.test.js` | 26 | 6 个一键写入目标的 preview → apply → restore 全流程；"只动自己那一块"；baseURL 形态 |
| `tests/edge.test.js` | 29 | 边界与降级：无供应商/全停用/无模型/空 Key/坏 JSON/目标是目录/引擎缺失；dsh 预览与引擎落盘逐字一致 |
| `tests/renderer.test.js` | 12 | 界面（渲染层）：用最小 DOM 桩**真实执行** `core.js`/`providers.js`；一键获取模型的选择器、编辑抽屉的监听器生命周期、数字列转义、双击行为 |
| `tests/security.test.js` | 18 | **每条都对应一次实跑确认过的真实缺陷**：TOML 写坏形态、读不到就中止、占位 Key、空 Key 不覆盖凭据、脚本注入、密钥脱敏 |
| `tests/gateway.test.js` | 114 | 网关引擎端到端：鉴权、SSE、三协议翻译、熔断、账户池、客户端仿真、**逐模型超时**、**仿真头镜像防漂移**、gzip 压缩 SSE、地区受限 403 不连坐、客户端指纹被拒、Retry-After 遵循 |

### 超时怎么定（三级，就近优先）

```
模型条目上的 timeoutMs   →   供应商的 timeoutMs   →   全局默认 60s
```

**为什么需要逐模型这一级**：同一家供应商里不同模型的速度能差一个数量级 ——
实测 amd 的 `DeepSeek-V4.1-Flash` 首字节 13.7–15.5s，而同家 `DeepSeek-V4-Flash` 只要 0.7–1.1s。
只配供应商级时只能按最慢的那个定（否则慢模型永远选不上），于是一个**挂住**的慢模型
就能吃掉整个客户端预算，把该家快的模型一起拖累。

在「供应商 → 模型映射」表里，每行都有一个"超时(ms)"列，留空即用供应商级。

### 一键获取全部模型

「供应商」页 → 编辑某家 → **⚡ 一键获取全部模型**：

1. 拉上游 `/models` 目录（**带与网关转发时相同的客户端仿真头** —— 少了这个，cline 这类
   按客户端白名单放行的上游会一律 403，一个模型都拉不到）；
2. 为每个模型尽量补齐参数：上下文长度、最大输出、是否支持图片；
3. 自动映射短名：`deepseek-ai/deepseek-v4.1-flash` → `deepseek-v4.1-flash`
   （去掉厂商前缀，但**保留** `:free` 这类有语义的后缀）；
4. 摆出来让你**勾选删减**（默认全选），可选"顺便实测超时"；
5. 应用到模型表，再点「应用」保存。

**参数补不齐就留空，不编数字。** 上游 `/models` 只回 `{id, object, created, owned_by}` 时
（new-api/one-api 中转的常见形态），我们并不知道上下文长度 —— 填一个看起来合理的值会让客户端
真的按那个数字发包（有前车之鉴：dsh 写入曾因拿不到值而退回默认 1024000，等于向上游虚报 5 倍）。
所以界面上会把这些模型单独列出来，由你决定。

### 引擎差异校验（不是"零差异"，是"差异全部有据"）

引擎最初是 dsh-app 版本的**原样副本**，靠"逐行完全一致"证明"现有网关功能全部保留"。
后来为了提升客户端仿真/防封禁能力确实改了若干处，于是那句话不再成立 —— 与其让它继续挂着，
不如换成**可机器复核的声明式差异**：

`scripts/check-engine-parity.mjs` 逐块（顶层 function/const/class）比对两个文件，要求：
- 所有变化过的块**必须**在脚本内的 `DECLARED` 清单里，且每条写明"改了什么、为什么"；
- 清单里挂着但实际没变的条目也会报错（防止清单腐烂成历史遗留）。

当前 38 处声明改动，0 处未声明。`--verbose` 可打印每一条的理由。
找不到 dsh-app 基线时会明确说明并跳过（不算失败）。

### 模型全量体检

`scripts/test-models.mjs` 把"网关到底能不能用某个模型"从"用户遇到再说"变成可以主动跑一遍的事：

- **阶段一**：逐个逻辑模型经**正常路由**发一次最小请求 —— 回答"这个模型能用吗"。
- **阶段二**：对失败的模型，**逐个供应商单独起一个只启用该家的网关**再试 ——
  回答"到底是谁的问题"。正常路由只会说"全部失败"，分不出是某一家挂了还是所有家都挂了。

分类做得细，因为不同失败对应的处置完全不同：超时 / 凭据被拒 / 额度 / 限流 /
该家没有此模型 / 上游故障 / 空响应 / 非 JSON 响应。失败时会把**网关日志的关键行**一并打出来。

```powershell
node scripts/test-models.mjs                  # 两阶段全跑
node scripts/test-models.mjs --phase1         # 只跑阶段一（快）
node scripts/test-models.mjs --model glm-5.2  # 只测指定模型（可多次）
node scripts/test-models.mjs --json out.json  # 落一份机器可读结果
```

### 审计记录

`docs/AUDIT.md` 记录了两轮审计：第一轮是拆分审计（能力清单、拆分边界、
dsh 0.2.0 的 `settings.yaml` 迁移行为），第二轮是**全代码审计复核**——
31 项真实缺陷的机制与修法（其中 6 项会导致用户数据损坏或不可逆破坏）。
第三轮（对抗性验证 + 客户端仿真专项）的结论见 `docs/ANTIBAN.md`。

### 界面无头冒烟（开发用）

```powershell
$env:LLM_GATEWAY_DATA_DIR = "$PWD\out\_smoke-data"
$env:LLM_GATEWAY_SMOKE = "$PWD\out\smoke.png"
node_modules\electron\dist\electron.exe .
```

会逐个视图截屏到 `out\smoke-<视图>.png`，并落一份 `smoke.png.json`（含网关状态、`/health` 原始数据、
模型清单），用于核验"网关真的起来了、配置真的导入了"。仅 `!app.isPackaged` 时生效。

---

## 架构

```
src/
  main.js              Electron 主进程：窗口 / 托盘 / IPC / 生命周期
  preload.js           contextIsolation 安全桥（只暴露具名动作）
  gateway-manager.js   网关进程托管、配置读写与校验、代理解析、健康快照
  gateway/
    model-gateway.mjs  网关引擎（dsh-app 版本的逐行副本，零依赖单文件）
    gateway.config.example.json
  writers/             一键写入
    index.js           目标注册表与统一入口
    util.js            原子写 / 备份 / 恢复 / 脱敏 / 最小 TOML 定点编辑
    models.js          从网关配置推导"客户端能选到的模型清单"
    target-dsh.js      交给引擎的 --write-dsh 执行
    target-claude-code.js / target-codex.js / target-iflow.js / target-opencode.js / target-envscript.js
  probe.js             供应商连通性探测（直连 / HTTP 代理隧道，零依赖）
  datadir.js           数据目录解析 + 从既有安装导入配置
  settings.js / logger.js / crash-report.js / icon.js / paths.js / winutil.js / fs-safe.js
renderer/              界面（原生 HTML/CSS/JS，无框架、无构建步骤）
tests/                 单元 / 写入器 / 网关端到端
scripts/               引擎一致性校验 / 绿色目录打包
```

几条刻意的设计选择：

- **网关跑在子进程里**。引擎带 self-watchdog（连续 3 次 `/health` 自检失败即 `process.exit(1)` 自愈）；
  在主进程内跑，这个 exit 会把整个桌面程序带走。
- **用本程序自己的 exe 当 Node 运行时**（`ELECTRON_RUN_AS_NODE=1`）。Electron 二进制本身就是纯 Node，
  于是目标机器**不需要预装 Node**，也不会踩到"用户装的是 Node 16 而引擎要求 ≥18"这类地雷。
- **引擎不引入任何新依赖、不改一行逻辑**。界面侧的便利功能（模型清单推导、预览）在 `writers/models.js`
  里重写了几十行纯函数，并用测试钉死"与引擎 `--write-dsh` 的实际输出一致"——代价远小于破坏"零差异"这个可验证性。
- **配置编辑用内存工作副本**，点「保存并生效」才落盘并重启网关。有未保存改动时，写入客户端会明确警告
  （写入读的是磁盘上的配置）。

---

## 排错

| 现象 | 先看什么 |
|---|---|
| 客户端报 401 | 「概览」里的统一 Key 是否与客户端里填的一致；改过 Key 就要重跑一次「客户端接入」 |
| 请求 404 / 模型不存在 | 「模型」页里有没有这个逻辑名——网关**只认**配置里声明过的名字 |
| 某家一直不被使用 | 「供应商」页点「测试」，看连通性；再看「日志」页的 `[route]` 行（每次请求都会记选路判定） |
| 为什么走了那家 | 「日志」页搜 `[route]`；熔断/冷却会让候选被跳过，日志里有 `skip <id> (breaker open)` |
| Claude Code 报模型不存在 | 它默认要 `opus`/`sonnet`/`haiku` 这些别名；勾选「同时改写模型别名」重写一次 |
| Codex 连不上 | 网关支持 `/v1/responses`，但**上游**也要支持；至少保留一家支持的供应商 |
| 界面白屏 | 看 `<数据目录>\logs\app.log`——渲染层的报错会写进去 |
