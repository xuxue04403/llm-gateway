# 拆分审计：dsh-app 的模型网关 → llm-gateway

本文记录拆分前对 `dsh-app` 网关部分的审计结论、拆分边界，以及**刻意没有搬走**的东西。

---

## 一、dsh-app 里"模型网关"到底由哪些部分组成

审计基线：`dsh-app` v1.9.5（源码树），网关相关代码分布在 4 层：

| 层 | 文件 | 体量 | 职责 |
|---|---|---|---|
| 引擎 | `src/gateway/model-gateway.mjs` | 4,735 行 / 263 KB | 零依赖单文件 HTTP 服务：路由、熔断、账户池、三协议、WorkBuddy 凭据、`--write-dsh` |
| 示例配置 | `src/gateway/gateway.config.example.json` | 108 行 | 带 27 条 `_说明` 的配置模板 |
| 宿主 | `src/gateway-manager.js` | 811 行 / 44 KB | 进程托管、配置校验、代理解析、日志、健康探测、`writeDsh()` |
| 界面 | `renderer/settings.html` 的 `#card-gateway` | 约 190 行标记 + 约 660 行脚本 | 供应商表格、模型映射、代理、日志框 |

依赖关系是**单向且干净**的：

```
settings.html  ──IPC──▶  main.js  ──▶  gateway-manager.js  ──spawn──▶  model-gateway.mjs
                                          │
                                          └──▶  crash-report.js（仅"反复崩溃"一条路径）
```

也就是说：**引擎对 dsh 零依赖**，宿主对 dsh-app 的依赖也只剩两项（日志器、崩溃报告器）。
这是个可以整体搬走的模块，不需要"拆解"。

## 二、引擎的能力清单（搬迁时必须一项不少）

按代码里实际实现的功能逐项列出，作为验收清单：

**路由与容错**
- `priority` 升序 + 同级按数组顺序选路；配置声明的层级优先于目录兜底
- `routing: "failover" | "round-robin"` 两种策略
- 分级熔断：`401/403` 与"余额/额度"类拒绝 → 30 分钟；网络/5xx 连续 3 次 → 90 秒，指数退避到 30 分钟
- 半开探测：只放一个探测请求；供应商声明了 `timeoutMs` 时探测按它执行（否则压到 10 秒）
- 上游"确定性 4xx"终止 failover（避免 N 倍计费），"这家没有该模型"则继续下一家

**账户与凭据**
- 账户池：`apiKeys[]` / `accounts[]` 轮询；额度耗尽（账户级 30 分钟）、登录失效（账户级 60 分钟）、
  限流（**模型级** 90 秒）三档冷却，`/health` 逐条可见
- WorkBuddy：解析腾讯 CodeBuddy 桌面版凭据、OAuth 刷新（提前 5 分钟）、单飞去重、CN/国际版区域守卫
- 凭据脱敏：日志与 `/health` 的 `reason` 都过 `maskSecrets`

**协议**
- `POST /v1/chat/completions`（OpenAI）、`POST /v1/responses`（含 `{id}` 取回 / `cancel` / `DELETE` /
  `input_items` 子路由 + `previous_response_id` 亲和路由）、`POST /v1/messages`（Anthropic）
- Anthropic → OpenAI 的请求/响应/SSE 双向翻译（`protocol: "openai-chat"` 的供应商）
- `GET /v1/models`（合并去重 + 目录兜底）、`GET /health`

**上游适配**
- `quirks`：`force-stream` / `stringify-tool-choice` / `prepend-system` / `drop-thinking`（含自动学习）
- `clientProfile`：`claude` / `codex` / `cline` 三档身份头仿真，支持逐家覆盖与主机名推断
- `headers` 自定义静态头、`timeoutMs` 逐家超时
- 模型映射 `{ id, as, vision, contextWindow, maxTokens }`；带图片的请求只发给声明 vision 的家

**运维**
- 逐请求 `[route]` / `[call]` 日志、上游错误体摘要、`proxyStatus()` 自述
- self-watchdog：每 60 秒**裸 socket** 自检 `/health`（不经代理层），连续 3 次失败自杀交宿主重启
- 优雅关停（SIGTERM/SIGINT 先停收新请求）

**迁移工具**
- `--write-dsh`：把网关注册成 dsh 的 `llm-pi-ai.providers.gateway`（逐层定位 YAML + 原子写 + 首次备份 +
  YAML 转义 + 模型上限取最小值 + vision 声明）

## 三、拆分边界

**搬走**（`llm-gateway/src/`）：引擎、示例配置、`gateway-manager` 的进程托管与配置校验/代理解析/健康探测。

**重写**（不是搬）：界面。原 `settings.html` 的网关卡片与"服务/窗口/插件市场/更新诊断"睡在同一页，
剥离后按独立应用的信息架构重做（概览 / 供应商 / 模型 / 客户端接入 / 设置 / 日志）。

**新增**：一键写入 dsh 之外的客户端（Claude Code / Codex / iFlow / OpenCode / 通用脚本）、
供应商连通性探测、从上游拉取模型目录、账户池可视化、预览 diff 与一键恢复。

**留下不动**：`dsh-app` 本身。它是 dsh harness 的宿主（启动器、看门狗、插件快照、机器适配、插件市场…），
与网关无关；本次拆分**没有修改 dsh-app 的任何文件**。

## 四、兼容性：dsh 0.2.0 的 `settings.yaml` 迁移

拆分过程中核实的一件要紧事：dsh 0.1.7+ 起，`settings.yaml` 变成了**一次性导入源**。

`@deepseek-ai/dsh-settings` 的 `importLegacyDocument()`（`lib/index.js:346`）：

```js
const path = join(profile.home, "settings.yaml");
if (!existsSync(path)) return;
await rename(path, `${path}.imported`);      // 先改名，保证不会重复导入
for (const [section, values] of Object.entries(parse(...)))
  await this.update(ns, values);             // 逐段并进 profile
```

而 `update()` → `mergeLayers(current, patch)` 是**递归稀疏合并**（`lib/index.js:281`），不是整段替换。

结论（三条都已核实，写进了界面提示）：

1. **`--write-dsh` 仍然有效**——写 `settings.yaml` 后，下次 dsh 启动即导入。
2. **只覆盖 `llm-pi-ai.providers.gateway`**，用户已有的其它供应商（`kingrouter` / `opencode-go` …）不受影响。
3. **导入后 `settings.yaml` 会被改名成 `.imported`**（dsh 自己的设计）——所以"写完看不到这个文件"是正常的，
   整合结果要去 `~/.dsh/profiles/<name>/cordis.patch.yml` 看。

> 本机实测印证：该 profile 补丁里已有 `gateway` / `kingrouter` / `opencode-go` 三个 provider 条目，
> 即"写入 → 导入 → 落到 profile"这条链路一直在正常工作。

## 五、审计中发现并修掉的问题

拆分过程中（含写测试时）暴露出来的缺陷，都在 llm-gateway 里修掉了：

| # | 问题 | 后果 | 修法 |
|---|---|---|---|
| 1 | `contextBridge` 载荷里带了**函数**（`writers.list()` 返回 `baseUrl` 函数本身） | Electron 报 "An object could not be cloned"，整个状态推送失败、界面空白 | 改成可结构化克隆的字符串；加回归断言 |
| 2 | `target-dsh.apply` 没把 `--settings/--credentials` 传给引擎 | 引擎按 `os.homedir()` 自己解析路径，与界面的 `paths()` 分叉——**测试时写进了真实 `~/.dsh`** | 由同一个 `paths()` 产出并显式传参；加"绝不写真实主目录"回归 |
| 3 | `isPlaceholderConfig` 要求"每个供应商都像占位" | 示例文件里的 `workbuddy`/`cline` 示范条目让它被误判成"真实配置"，首次运行的配置导入被静默跳过 | 改为"启用的供应商里有没有一家看起来是真的" |
| 4 | `tomlUpsertTopKey` 对空文件跳过开头空行会走到数组末尾 | 写出的 TOML 以换行开头 | 空/全空白文件直接返回干净的一行 |
| 5 | 先插 TOML 表、再插顶层键 | 顶层键只能被挤到表头前并留空行 | 调整顺序：顶层键在前，表在最后 |
| 6 | 预览与写入可能使用不同来源的配置 | "预览看到的"与实际写进去的不一致 | Codex/dsh 的预览与写入共用同一个 `buildConfig`/`paths`；界面在配置有未保存改动时明确警告 |
| 7 | `redact()` 打码保留前 4 个字符 | 预览 diff 会被截图分享，等于泄露一截密钥 | 预览里整值抹掉；只有用户自己界面上显示"当前值"才保留前缀 |
| 8 | dsh 写入只看退出码 | 引擎报成功但目标文件不存在时界面仍显示"已写入" | 追加"目标文件是否存在"校验 |
| 9 | 单文件便携版用 `process.execPath` 定位数据目录 | electron-builder 的 portable target 会把程序**解包到临时目录**再运行——数据会落在临时目录里，每次运行都像被重置 | 改用它注入的 `PORTABLE_EXECUTABLE_DIR` |
| 10 | 用系统 `bsdtar` 打 zip | 它写 zip 时不设 UTF-8 文件名标志位，`使用说明.txt` 在资源管理器里变成 `ʹ��˵��.txt`（实测确认） | 改用 .NET `ZipFile.CreateFromDirectory` + 显式 UTF8 编码 |

## 六、验收结果

```
引擎一致性   [OK] 归一化后与 dsh-app 版本逐行完全一致（唯一差异：APP_DIR 默认目录名）
网关端到端   103 / 103   移植自 dsh-app 的 tests/gateway.test.js，原样运行
单元          34 / 34
写入器        22 / 22
界面冒烟      6 个视图全部渲染，/health 通、12 家供应商导入成功、24 个模型
```

"功能全部保留"因此有两重可复核的证据：**逐行比对**（静态）与**原样跑通的 103 项端到端回归**（动态）。

---

# 第二轮：全代码审计复核（"无漏洞、全部功能可用"）

对全部源码做了一轮系统性审计，分四路并行 + 主审：**Electron 安全面 / 写入器与文件操作 /
宿主与网络 / 功能完整性**。所有结论都要求**实跑证据**（真模块、真 Electron、真 cmd.exe、
伪造的恶意代理与畸形响应），不接受"理论上可能"。

下面按"发现的真实缺陷"列，每条都给机制与修法。**共 31 项**（阻断 1、高危 5、中危 10、低危 15）。

## A. 会导致用户数据损坏或不可逆破坏的（最高优先级）

| # | 缺陷 | 机制 | 修法 |
|---|---|---|---|
| A1 | **编辑供应商会静默删掉模型的 `contextWindow`/`maxTokens`** | 编辑抽屉是"读→填表→写回"的往返，而前端的 `modelEntriesOf` 没带出这两个字段 → 输入框恒为空 → 点「应用」即抹掉。连带：模型总览页两列恒为 `—`；dsh 写入因此退回默认 `contextWindow: 1024000`（向上游虚报 5 倍上下文） | 前端 `modelEntriesOf` 与 `writers/models.js` 对齐，补齐字段与别名 |
| A2 | **文件读不出来时静默整份覆盖用户配置，还报成功** | `readText` 把一切读错误吞成空串 → 合成出的"新文本"只剩本程序受管的键 → 用户原有的 `language`/`enabledPlugins`/`statusLine`/`mcp_servers` 全部消失。ACL 拒绝、被独占锁定、磁盘错误都能触发 | ① `writeAtomic` 单点闸门：目标已存在但读不回来一律**中止**（覆盖全部目标）；② 各目标改用 `readTarget()` 给出精确原因 |
| A3 | **codex：把合法的 config.toml 写成 TOML 语法错误** | ① 表头带行尾注释（`[x] # 注释`，合法 TOML）定位不到 → 文件末尾追加**第二张同名表** → `Cannot declare twice`；② 表头出现在多行字符串里被当真表头 → 删掉用户字符串与收尾 `"""` → `Unterminated string`；③ 顶层 dotted key 隐含声明过的表再被显式声明 → `Cannot overwrite a value`。三种都是 **before 合法 / after 非法**，而 Codex 会因此**整体**解析失败——用户自己的 provider / mcp_servers / projects 一起废掉 | ① 重写 TOML 扫描器：容忍行尾注释、识别 `[[数组表]]`、跟踪 `"""`/`'''` 跨行字符串；② 新增 `tomlValidate()` 自检；③ **写前自检 + 写后复核 + 不合法即用备份回滚**（兜住所有没想到的形态） |
| A4 | **空 Key 时把用户原有可用凭据写成空串** | 各写入器的 `apply` 完全不看 `preview` 给出的 `guard`，而界面卡片上的「写入」按钮直接调 `apply` → `ANTHROPIC_AUTH_TOKEN: ""`、`OPENAI_API_KEY: ""`，客户端随即 401，且**不可逆** | ① 写入器 `apply` 开头统一查 Key；② `main.js` 的 `write:apply` **强制**先跑一遍 preview 并检查 `guard` |
| A5 | **dsh 写入在界面上永远报"失败"** | dsh 的 `apply` 是 async（交给引擎子进程），其余目标的 apply 是同步的；`write:apply` 没 await → 同步读 `r.ok` 永远拿到 `undefined` | `writers.apply` 统一成 async（永不在内部抛），调用方一律 await；加契约测试钉死 |
| A6 | **测试污染过真实 `~/.dsh`** | `target-dsh.apply` 没把 `--settings`/`--credentials` 传给引擎，引擎按 `os.homedir()` 自行解析路径，与界面的 `paths()` 分叉 | 由同一个 `paths()` 产出并显式传参；加"绝不写真实主目录"回归 |

## B. 安全（注入 / 泄露）

| # | 缺陷 | 机制 | 修法 |
|---|---|---|---|
| B1 | **模型名注入生成的 `.cmd`/`.ps1` → 本机命令执行** | 生成的脚本里 `echo … ${model}` / `Write-Host "… ${model}"` 是裸拼。模型名可能来自上游 `/models` 返回值（外来字符串），含换行即可断行成命令——用真 `cmd.exe` 实测注入行**真的被执行了** | 按各 shell 规则转义：cmd 的 `set "…"`（`%`→`%%`，含 `"` 时降级为注释+警告）、cmd 展示文本剔除元字符、PowerShell 单引号串（`'`→`''`）、sh 单引号串（`'`→`'\''`） |
| B2 | **`endpoints.txt` 里的"照抄命令"同样可注入** | 该文件的用途就是复制粘贴到终端，而模型名只压了换行、没净化元字符 → `aider --model openai/x&calc` 会把 `calc` 跑起来 | 用 `safeName()` 把非 `[A-Za-z0-9._:/-]` 字符替换为 `_`，并在替换发生时加脚注 |
| B3 | **预览把其它客户端的明文密钥送进渲染层** | `before` 是原文件全文：iFlow 的 `apiKey`/`searchApiKey`、opencode 其它 provider 的 `apiKey`、Codex 的 `experimental_bearer_token` 都在里面；`sanitizePreview` 只擦网关统一 Key | `maskSecretsFull()` + `scrubDeepSecrets()` 深扫整份预览载荷 |
| B4 | **崩溃现场（要求用户外发的文件）泄漏密钥** | `logTail` **完全没走脱敏**（实测把上游回显的 `Authorization`、已登记的网关统一 Key、base64 形态的上游 Key 原样写进去）；`proxy.url` 里的 `user:password` 被 `^https?://` 豁免规则整体放行 | `logTail` 过 `maskSecrets`；新增 `maskUrlUserinfo()` 先抠掉 URL 里的凭据再决定豁免 |
| B5 | **占位统一 Key 能过写入器的检查** | 示例里的 `dsh-gateway-change-me` 恰好 22 字符，而写入器只查 `length < 16`；`validateConfigText`（保存路径）拒绝它 → "保存被拦、写入放行"，全新安装时一点「写入」就把公开占位值写进用户已有客户端的配置 | 抽出 `util.apiKeyProblem()` 作为**唯一**判定口径，校验器与 6 个写入器共用 |
| B6 | **日志可被伪造行** | `write()` 直接拼接消息，而消息可能含外部文本（渲染层 console 文本、上游错误体回显）→ 一个 `\n` 就能伪造出带时间戳与级别的完整日志行（实测） | `write()` 把 `\r\n|\r|\n` 压成 `\\n` |
| B7 | **日志脱敏有可绕过形态** | `sk-` 系列大小写敏感、`github_pat_`/`AKIA`/裸 JWT 无规则、网关自己的 `dsh-gateway-`/`lgw-` 形态不在正则里（而它不符合任何已知前缀） | 正则补齐 + 加 `i`；新增 `registerSecret()` 精确登记，启动时把统一 Key 与**全部上游 Key** 都登记进去 |
| B8 | **原子写失败残留含明文密钥的 `.tmp` 文件** | rename 失败（目标被独占锁定）时 tmp 无人清理 | rename 失败即 `unlinkSync(tmp)` |

## C. 正确性与健壮性

| # | 缺陷 | 机制 | 修法 |
|---|---|---|---|
| C1 | **HTTPS 走代理时没有任何生效的超时 → Promise 永久不 settle** | `connectViaProxy` 成功后 `sock.setTimeout(0)`，而自定义 `createConnection` 路径下 `https.request({timeout})` **不会**给 socket 挂定时器 → `req.socket.timeout === undefined` → `req.on('timeout')` 是死代码。实测 `timeoutMs:1200` 时 **60 秒仍在挂起**。后果：`gw:test-providers` 永久转圈、IPC 永不返回、每次泄漏一条 TCP+TLS 句柄 | 显式 `req.setTimeout(timeoutMs, …)`；并给 `gw:test-providers` 加 90 秒整体预算（到点返回已完成部分 + 如实说明剩余未测） |
| C2 | **自愈重启被 `_starting` 互斥吞掉** | 子进程在"就绪探测循环"期间死亡（引擎"起来就退"是最常见故障形态）时，3 秒后的自愈调 `start()` 会原样返回那次仍在飞行的旧启动 → **只尝试一次就永久放弃**，也无任何提示（实测 `heals=1, spawnAttempts=1`） | 自愈前先 `await this._starting` 落地，再判断 `!this.proc` 发起真正的重启 |
| C3 | **点「停止」时若启动正在进行，网关最终处于运行状态** | `stop()` 见到 `this.proc === null` 就返回，而正在 await 的 `_doStart` 不受影响、照常 spawn | `_doStart` 在每个 await 之后复查 `stopping`；`stop()` 也先等 `_starting` 落地 |
| C4 | **继承来的"死代理"被裸信采纳** | 代码注释自称"TCP 探测通过才用"，但只对猜测的 clash 端口（7890/7897）做了探测，环境变量与注册表两条路是裸信的 → 网关照常"运行中、/health 正常"（自检走恒直连的回环），而**每个模型请求都 ECONNREFUSED** | 三个分支统一走 TCP 探测；探测不过就回退直连并记一条 WARN |
| C5 | **注册表代理串解析会挑错条目** | `split(';')[0].split('=').pop()`：`https=…;http=…` 会拿 https 代理当 http 用、`ftp=…` 被当成 HTTP 代理、密码含 `=` 时被截断并变成用户名 | `pickProxyFromRegistry()` 按协议键取值，只认 http/https |
| C6 | **`https://` 代理被校验器放行但永远不可用** | 代理通道是明文 CONNECT，填 https 会被当普通端口 `net.connect` → 对端是 TLS 端点时收到明文 CONNECT 不答 | `validateConfigText` 明确拒绝并解释原因 |
| C7 | **baseURL 里的 userinfo 处理错误** | 走代理时凭据明文出现在请求行（`GET http://user:token@host/…`）；直连时凭据被**静默丢弃** → 用户看到 401 无从排查 | 走代理时从请求行剔除 userinfo；直连时转成 `auth` 选项（Basic） |
| C8 | **进程清理会误杀、"残缺行"变成 taskkill 目标** | ① marker 只是配置路径，任何命令行里提到该路径的无关进程都会被 `/T` 连树杀掉（实测）；② `parseInt` 接受任意数字前缀，stdout 被截断时半截数字会变成一个真实 PID（实测 `garbage\r\n45` → `/pid 45`） | 只接受**完整行**里的纯数字、加上界、排除自身；stdout 不以换行结尾时丢掉末行 |
| C9 | **启动失败静默** | 端口被占用/运行时缺失时 `_doStart` 只记日志就正常返回，而 `gw:action('start')` 无条件回 `ok:true` → 界面弹「网关已启动」而状态栏显示「已停止」 | IPC 按 `gateway.running` 如实回报；保存配置后若网关没起来也给 warning |
| C10 | **配置导入可被"投毒目录"劫持** | 导入候选沿 `process.cwd()` 向上找 12 层 → 绿色版放在下载/共享目录时，只要那里摆一份 `dsh-app/out/DSH-App/data/gateway.config.json`，首次运行就把它当"用户的真实配置"导入（实测），随后还会被一键写进各客户端 | 只从**应用自身所在目录树**向上找；导入改为 tmp+rename 原子落地 |
| C11 | **`getState().port` 与配置漂移** | `port` 用只在 `_doStart` 更新的 `this.port`，`baseUrl` 却用 `configPort()` → 停止状态下改端口后，概览显示的接入信息是旧端口（复制出去就连不上） | 统一为 `running ? this.port : configPort()`；一键写入的端口口径同步 |
| C12 | **客户端接入里残留的旧模型名被无校验写盘** | 选项只在 `undefined` 时播种，模型被改名/删除后从不失效 → 写入一个网关不认识的模型名 | 渲染层每次渲染按当前清单校正；写入器加 `chosenModelProblem()` |
| C13 | **日志轮转失败会永久静默停摆** | 空 `catch` 吞掉一切 rename 失败（被杀软/索引器/网盘锁住、磁盘满）→ `MAX_BYTES` 形同虚设，app.log 无上限增长 | 首次失败记一条 WARN（直接写文件避免递归） |
| C14 | **崩溃现场的脱敏启发式既误伤又漏网** | 按长度猜语义：`claude-3-5-sonnet-20241022`/主机名/一句普通错误都被打码；而 <16 字符、含 `/`、以 `http(s)://` 开头的真密钥反而放过 | 先抠 URL 凭据、再走精确登记与形态正则，长度启发式降为最后的兜底 |
| C15 | **`settings.load()` 的注释与实现相反** | 注释说"陌生键不注入内存"，代码却显式写入。`__proto__` 被挡住是**巧合**（`DEFAULTS['__proto__']` 取到继承来的 `Object.prototype`） | 显式列出 `UNSAFE_KEYS`；`save()` 只接受白名单键；注释与实现对齐 |
| C16 | **`Settings.save({k: null})` 会把布尔设置写成 `null`** | 类型校验里的 `v !== null` 例外放行了 null → 之后所有 `!== false` 判断全部走样 | 拒绝 null（除非默认值就是 null） |
| C17 | **envscript 的 restore 在无备份时报成功** | 恒 `ok: true` + 一句"没有需要恢复的备份" → 界面弹"已恢复：无变化" | 无备份时 `ok: false`，与其它目标一致 |
| C18 | **「＋添加供应商」点取消不回滚** | 先 push 再开抽屉，取消后留下没有 baseURL 的空条目 → 保存被校验拦下，用户得自己删 | 记录"待确认的新条目"，取消即回滚 |

## D. 功能完整性与死代码

机械比对（DOM id ↔ JS 选择器、preload ↔ ipcMain.handle ↔ 渲染层调用、视图 key 四方对照、
写入器选项矩阵）结果：**0 处引用不存在的 id、0 处重复 id、0 处 preload 通道缺实现、
0 处渲染层调用不存在的方法、视图 key 四方一致、每个 UI 选项都被写入器真实读取**。

修掉的接线缺陷与死代码：

| 项 | 问题 | 处理 |
|---|---|---|
| D1 | `gw:state` 是死通道（preload 没绑定）→ **日志页启动后永远是空的**，上一次会话的网关日志进不了界面 | 绑定 `lgw.gwState()`，`boot()` 里填入历史日志 |
| D2 | `app.js` 的"首次日志"是空实现（`if (full) { /* 注释 */ }`） | 随 D1 一并修掉 |
| D3 | 恢复备份对 dsh **永远失败** | 引擎自己的备份后缀是 `.bak-gateway`，而写入器只找 `.bak-llmgateway` → 改为候选后缀列表 |
| D4 | 写入成功弹窗从不显示备份路径 | 各目标返回形状不一（`backup` vs `backups`），主进程归一化 |
| D5 | 「重新生成统一 Key」保存前概览仍显示并可复制**旧 Key** | 概览改读工作副本，并标注"（未保存）" |
| D6 | `app.js` 启动失败分支用 `innerHTML` 拼错误栈 | 改 `textContent`（错误栈里可能有外部字符串） |
| D7 | 死代码 | 删除 `src/fs-safe.js`（全仓 0 引用）、`winutil` 的 `resolveCmdExe`/`comSpecIsStale`、`app:open-url` 通道、`lgw.openUrl`、`writeAuth` 选项、`LG.lastTestProxy`、`stateSnapshot().targets`、`renderDirtyBarCounts()`、`modelSelectHtml` 的 `allowEmpty` 参数 |
| D8 | 坏 JSON 配置启动无任何提示 | 快照加 `configOk`，启动时明确提示（并说明磁盘原文件未被覆盖） |

## E. 补上的安全加固（无对应缺陷，但值得做）

- **渲染页 CSP 全面收紧**：`default-src 'none'` + `connect-src 'none'`（页面不需要任何网络，
  所有网络都由主进程代劳）+ `base-uri 'none'` + `form-action 'none'` + 各类 `'none'`。
  实测：`innerHTML` 注入的 `onerror` 被 CSP 拦下、不执行；meta CSP 无法被页面自己放宽。
- **同窗口导航拦截**：原先只挡了新窗口（`setWindowOpenHandler`），而 preload 桥挂在
  `webContents` 上——**任何**被加载进这个窗口的页面都会拿到 `window.lgw`。补上
  `will-navigate`（只放行自带渲染页）+ `will-attach-webview` 禁止。
- **退出收尾**：托盘「退出」原先会跳过 `gateway.stop()`（Windows 上子进程不随父进程消亡），
  留下占着端口的孤儿网关；且关掉"最小化到托盘"后点 × 会变成没有窗口的幽灵进程。
  改成显式状态机（`teardownStarted` / `allowQuit`），并对 SIGINT/SIGTERM 也尽力收尾。
- **构建产物防泄漏闸门**：`build-portable.mjs` 在打包前硬断言产物目录里没有 `data/`、
  `logs/`、`*.bak*`、`*.log`、`gateway.config.json` —— 这些含全部上游密钥与网关 Key，
  而 README 恰恰在教用户"整个目录复制到别的机器"。

## F. 审计自身的教训

有三条缺陷是**审计过程中被审计出来的**，值得单独记一笔，因为它们说明了"为什么必须实跑"：

1. `small is not defined` —— 我在加 guard 时漏了解构，`preview` 直接抛异常。**机械测试当场抓到**。
2. `forEachCodeLine` 用 `=== true` 判定、而回调返回行号 —— 第 1 行命中返回 `1`，
   既不等于 `true` 也不等于 `false`，于是"找不到键"、顶层键被重复插入。**单元测试当场抓到**。
3. `writers.apply` 变 async 后，`write:apply` 没 await —— dsh 写入会永远报失败。
   **security 测试的契约断言当场抓到**。

结论：这轮审计之所以能收敛，靠的不是"看得仔细"，而是**把每条结论都跑出来** +
**为每个修好的缺陷留一条回归**。

## G. 最终验收

```
单元          38 / 38
写入器        24 / 24
边界与降级    29 / 29
安全回归      17 / 17
网关端到端   103 / 103
────────────────────────
合计         211 / 211 全绿
引擎一致性   [OK] 与 dsh-app 版本逐行完全一致（唯一差异：APP_DIR 默认目录名）
语法检查     全部文件通过
实机验证     界面 6 视图渲染正常；便携 exe 独立运行 /health 通；
             三协议真实调用成功（OpenAI 500ms / Anthropic 571ms / Responses 785ms）；
             dsh 写入用真实配置副本验证（24 模型、凭据 7 个 ref 全在）
真实用户配置  ~/.dsh 统一 Key 正确、settings.yaml 仍不存在；
             ~/.claude 仍是 agentrouter、~/.codex 仍是 anyrouter、~/.iflow 未变
dsh-app      源码零改动
```

---

# 第三轮：对抗性验证 + 客户端仿真专项

第二轮修完 31 项之后，第三轮做了两件事：**对抗性验证**（逐个尝试把第二轮修好的东西打破）
与**客户端仿真/防封禁专项**（含联网核对官方 SDK/CLI 的一手源码）。

## A. 被打破的（第二轮修得不够的地方）

| # | 问题 | 机制 | 修法 |
|---|---|---|---|
| A1 | **进程清理仍会误杀无关进程** | 第二轮只改了 PID 解析（"残缺行变成 taskkill 目标"），**匹配方式没改** —— 仍是"命令行含配置路径就杀整棵进程树"。用户在编辑器/终端里打开或引用 `gateway.config.json`，其进程树就会被 `/T /F` 强杀（真起诱饵进程复现） | 除 marker 外**必须同时命中引擎标识**（`model-gateway.mjs` 或 `--write-dsh`） |
| A2 | **Key 检查查错了源** | dsh 的写入交给引擎，引擎读的是**配置文件里**的 `apiKey`；而写入器查的是 `ctx.apiKey`。两者分叉时（实测 `ctx` 合法、磁盘上是 3 字符的 `"abc"`）→ `guard` 一条理由都不给、`apply.ok=true`，**引擎把 `"abc"` 写进用户的 credentials.yaml**，覆盖掉原本可用的凭据 | 新增 `effectiveKey(ctx)`：查引擎真正会用的那把（读 `ctx.configPath`） |
| A3 | **`tomlValidate` 误报，把合法 TOML 判非法** | 旧实现"数 `"""`/`'''` 出现次数的奇偶"，而 `a = """x'''y"""` 里的 `'''` 出现在 `"""` **内部**、只是普通字符 → 被判"未闭合"。250 轮差分模糊里被它拦下的 29 例，经 tomllib 判定 **29/29 全是误报**，codex 写入被彻底堵死 | 换成**字符级词法扫描**（正确区分基本串/字面串/多行串/注释），并保留"数行号"式的表头识别 |
| A4 | **写入前的 guard 检查有 fail-open 洞** | `if (pre && pre.ok && guard.length)` —— `preview` 抛异常时 `pre.ok === false`，整个条件**短路** → apply 照常执行。故障注入下确认 `config.toml` 真被改了 | 改 **fail-closed**：`preview` 没给出"可以写"的结论就一律不写 |
| A5 | **超大字符串会让脱敏爆栈** | `maskSecretsFull` 在单个字符串 ≥ 5.6MB 时 `RangeError: Maximum call stack size exceeded`（V8 `GetSubstitution` 栈限制；10MB × 20 次 = 20/20 全抛）→ 该目标的预览与写入整个不可用。而输入正是"别的客户端配置文件的原文" | 精确登记串走 `split/join`（不爆栈），形态正则**按行**处理 |
| A6 | **`util.redact` 的长度启发式误伤** | `claude-3-5-sonnet-20241022`、`gpt-4o-mini-2024-07-18`、`model_reasoning_effort`、ISO 时间戳全被打成 `<masked:NN>` → opencode 的 `"name"` 与 claude-code 的 `ANTHROPIC_MODEL` 在预览里没法看。同一批串交给 `logger.maskSecretsFull` 是原样放行的 —— 误伤只来自那份重复且更粗的启发式 | 删掉长度启发式，统一走 `logger`（两处口径一致） |

**一次事故（已完全处置）**：验证 A4 时，用真 Electron 加载真 `main.js`，而它的 `writeCtx()`
生产路径不含 home 覆盖 → 一次调用把网关配置**真的写进了 `~/.claude/settings.json`**。
已用程序自己生成的 `.bak-llmgateway` **逐字节还原**（SHA256 一致，`agentrouter.org` /
`opus[1m]` / 原 token 均恢复），并删除了过程产物。我随后独立复核了还原结果。
**教训**：任何加载真 `main.js` 的测试都必须先劫持 `os.homedir()`。

## B. 客户端仿真 / 防封禁

详细记录见 [`docs/ANTIBAN.md`](ANTIBAN.md)。要点：

- **根本天花板**：TLS/连接层指纹（agentrouter 前置的 Aliyun WAF 那一类）本程序**改不了** ——
  Node 没有公开 API 定制 ClientHello，而零依赖单文件是架构约束。这一条写进文档，不假装能解决。
  能做的是**识别它并立刻止损**。
- **三个 profile 原来都不完整**：`claude` 只发 2 个自建头（真实 ~15 个，且缺全套 `x-stainless-*`）；
  `codex` 的 UA 是"Codex 前缀 + Chrome 浏览器 UA"（Rust CLI 不可能带 `AppleWebKit`/`Safari`，
  最易识破的自相矛盾），且完全没有 `originator` 这个一等身份头；`cline` 版本号写死且已过期。
- **两个非头部特征**：`accept-encoding: identity`（真实客户端发 `gzip, deflate, br, zstd`）、
  `connection: close`（真实客户端复用连接与 TLS 票据）。
- **新增止损机制**：识别"客户端指纹被拒"（换 Key 无用，继续打只会加剧风控）→ 长熔断该家并说明原因。
  旧实现会把它当账户失败，**逐把冷却用户所有可用的 Key 并继续往上打**。
- **新增 `Retry-After` 遵循 + 抖动**。旧实现全文件 0 处引用它 —— 无视限流头正是把短期限流
  升级成封禁的常见路径。
- 明确**不做**的事也写进了 ANTIBAN.md（随机 UA 轮换、编造 account-id、默认注入 `metadata.user_id` 等）。

## C. 模型全量测试（新增工具 + 由此发现的两个真 bug）

新增 `scripts/test-models.mjs`：阶段一逐个逻辑模型经正常路由真跑一次；
阶段二对失败的模型**逐个供应商单独起网关**再跑，以区分"某一家挂了"与"所有家都挂了"。

**首次运行 10/24 可用**，失败里最值得注意的不是模型本身，而是一个**引擎 bug**：

| 现象 | 根因 |
|---|---|
| 一个地区受限的模型失败后，**同一家另外 13 个正常模型在 1–3ms 内全部失败**（日志清一色 `temporarily in breaker cooldown`） | `[严重]`: 通配分支 `if (401‖403‖429‖>=500) breakerRecordFail(403)` **排在**"这家不提供该模型"判定之前 → 一个**模型级**的地区限制触发了**供应商级**的 30 分钟长熔断。全文件有**三处**这样的通配分支，三处都要判 |
| `glm-5.3-flash` 在隔离测试中明明可用（nvidia，13s），正常路由却总超时 | `amd` 的 `timeoutMs=60000` 且 `priority=2`（优先尝试）→ 它一挂就吃掉整个客户端超时预算，后面能用的家根本没轮到 |

修完之后：**13/20 可用，超时归零**，两个被熔断连坐误杀的模型恢复。

剩余失败全部有**上游原文**作依据，分三类（详见下表），没有一个是网关的问题。

## D. 最终验收

```
npm test     38 + 24 + 29 + 18 + 108 = 217 项全绿（exit 0）
引擎差异     [OK] 35 处已声明改动，0 处未声明（脚本逐块比对 dsh-app 基线）
语法检查     全部文件通过
模型体检     13/20 可用；剩余 7 个的失败原因均有上游原文（见下）
```

第三轮新增的回归测试（都在 `tests/gateway.test.js`，共 5 条）：

| 测试 | 钉住什么 |
|---|---|
| codex UA + `originator` | 形态必须是 `codex_cli_rs/<ver> (<os>; <arch>)`，且**不得**含浏览器指纹字样 |
| claude SDK 指纹头成套 | 8 个 `x-stainless-*` 都在，且 `runtime-version` 等于 `process.version` |
| **gzip 压缩的 SSE** | 上游压缩时仍能正确解压转发（`accept-encoding` 改动的直接风险） |
| 地区受限 403 不连坐 | 日志判定为"不提供该模型"、**不得** `breaker OPEN`、同家其它模型仍可用 |
| 客户端指纹被拒 | 长熔断该家、说明原因、**不**标记用户账户、熔断期间不再打上游 |
| 限流遵循 `Retry-After` | 冷却按上游给的秒数（而非默认 90 秒），且 `/health` 可见 |

## H. 附：关于"查看历史会话"功能

原始需求里提到给 dsh-app 规划"查看历史会话"的新功能。由于官方已发布 dsh 桌面版、dsh-app 不再继续优化，
该功能**未在本项目中实现**，也**没有对 dsh-app 做任何改动**。

顺带记录审计时查清的一条相关事实（曾多次被误判为"历史会话丢失"）：dsh 的会话文件本身从未丢失，
问题出在**两个实例跑着不同版本的 dsh** —— 旧版缺 `dsh-session-format-v3-to-v4` 迁移包，
读不出新版写的 v4 会话文件。两处版本对齐后即恢复。

---

## I. 第四轮审计（2026-09-30）：界面与宿主层

第三轮的结论是"代码层面没有已知漏洞"，但**用户随即在真实使用中撞到一个我引入的 bug**：

```
[ERROR] [界面] Uncaught (in promise) ReferenceError: dup is not defined (providers.js:382)
```

「一键获取全部模型」点了没反应。根因是我把每行的布尔 `dup` 当成重复名数组 `dups` 用了，
而那个模板字符串在 `Modal.open` **之前**求值，异常一抛弹窗根本没打开 —— 后端其实成功了。

**它为什么没被测出来**：渲染层此前**零测试覆盖**，而我能看到的只有主进程日志（幸好第三轮加了
`console-message` 转发，否则连这行线索都没有）。

于是第四轮把火力集中到两个此前的盲区：**界面层**与**本轮新加的代码**。三路并行审计
（对抗性测试新代码 / 界面端到端 / 宿主层回归），全部要求**真跑**而非读代码。

### 结构性发现：12 个 IPC handler 没有 try/catch

21 个 `ipcMain.handle` 里有 **12 个**没有异常捕获。任何一个内部抛出，`ipcRenderer.invoke` 的
promise 就 reject，渲染层那句 `await` 直接抛 —— 表现同样是"点了没反应"。
这与 `dup` 那个 bug 是**同一种失败形态**，只是一个在渲染层、一个在主进程。

修法是**单点收口**：包一层 `handle()`，捕获 → 记日志 → 按通道形状返回
（`{ok:false,error}` 或对 `app:state`/`gw:state` 两个快照通道返回 `null`）。
另有两条测试钉住"不许再加裸的 `ipcMain.handle`"。

### 真 Electron 里逐个调用 21 个通道

用真 `main.js` + **劫持 `os.homedir()`**（第三轮曾因漏做这步把配置写进过用户真实目录），
对每个通道喂正常值与 30 余组畸形输入。结论：**全部返回结构化结果，零 IPC reject**。

顺带测出两个真实缺陷：
- `cfg:export` 在无桌面会话时抛 `Failed to get 'desktop' path` → 改成 desktop→home→documents→temp→cwd 逐级降级
- `gw:measure-models` 对 `{}` 这类条目会拼出假 ID `'[object Object]'` **真的发一次上游请求** → 改成只接受字符串 id，并加 180s 整体预算

### 本轮修复清单（按严重程度）

**界面（渲染层）**
| # | 问题 | 用户可见后果 |
|---|---|---|
| 1 | 编辑抽屉每打开一次就多挂一层监听器（挂在 index.html 的**静态**按钮上） | 点一次「应用」执行 N 次：1 条"已应用" + N-1 条红色"ID 已存在"；长会话实测累积 26 层 |
| 2 | 「一键获取全部模型」只有 `finally` 没有 `catch` | IPC 抛错时**完全静默**（与 `dup` 同形） |
| 3 | 「仅拉取 ID 列表」既无 `catch` 也无 `finally` | 抛错后按钮**永久**停在"拉取中…"且点不动 |
| 4 | `testAll` 少 `r &&` 守卫 | `r=null` → 圆点永久转圈；`{ok:false}` → **谎报**"0 家正常/0 家异常" |
| 5 | 「添加供应商→取消」不回滚 | 连点 3 次留下 3 个空供应商，之后保存被校验拦下 |
| 6 | picker 的 `contextWindow`/`maxTokens`/`_tmo` 未转义 | 畸形上游数据可在真 DOM 里生成元素（当前被上游解析层的 `Number()` 挡着，属哑弹） |
| 7 | `dataset.i` 越界直接 `m.id` | 整次「应用」静默失败（无提示、无写入） |
| 8 | 测速回填不检查弹窗是否还在世 | 换一个供应商后，上一轮的测速结果会显示在新弹窗里，而实际一个超时都没写进去 |
| 9 | 「全不选→应用」仍关弹窗 | 一次 4MB 目录拉取 + 人工勾选全部作废 |
| 10 | 双击开关滑块会弹抽屉 | 排除清单漏了 `label.switch`（用户点的正是滑块） |
| 11 | 「重新生成统一 Key」失败零反馈 / 应用偏好开关**假成功** / 「重新检测」fire-and-forget | 失败时没有任何提示，或反过来提示"已保存" |
| 12 | `renderTopbar` 读 `st.gateway.running`，而它在 `renderAll` 的 try 之外 | `state.gateway=null` 时整页白屏（我上一轮加的归一化没覆盖这个形状） |
| 13 | 日志级别着色里**所有中文关键词都是死分支** | JS 的 `\b` 对 CJK 不成立；引擎日志里"失败"118 处、"熔断"81 处全不上色 |

**模型元数据**
| # | 问题 | 后果 |
|---|---|---|
| 14 | 数值字段无上界且类型不严（`true→1`、`'0x10'→16`、`1e308` 原样放行） | `setTimeout` 上限是 2^31-1，超出被 Node 悄悄改成 **1ms** → 该模型每个请求 ~5ms 被 abort，AbortError 又不重试 → 反复失败把**整家熔断** |
| 15 | `_src` 用 `enumerable:false` | 结构化克隆过不了 IPC → 界面上「参数来源」提示**在生产里恒为空**。测试没抓到是因为原来的渲染层测试同进程直调，从不跨 IPC |
| 16 | `autoMapName` 朴素取斜杠之后 | `'a//b'→'/b'`、`'../../etc/passwd'→'../etc/passwd'` —— 这些会**真的写进客户端配置**当逻辑名 |
| 17 | 前缀命中不标注 | `gpt-5.5-turbo` 拿 `gpt-5` 的参数，用户分不清"实测"与"同族推测" |

**引擎 / 宿主**
| # | 问题 | 后果 |
|---|---|---|
| 18 | 翻译路径 + 账户池：地区受限 403 仍熔断整家 | 第三处通配收尾没有豁免判断；同一份响应在直通路径判"不提供该模型"、在翻译路径熔断 30 分钟。**根因还要更深一层**：`forward` 里 `return false` 之后，调用方 `forwardWithAccounts` 会**自己再分类一遍**，仍判成 `session` → 2 把 Key 全冷却 → 同家另一个模型被"全部冷却中"挡掉 |
| 19 | 直通路径：模型级受限把该家**全部 Key** 冷却 1 小时 | 连坐效果与熔断整家等价（账户级判定排在模型级之前） |
| 20 | 翻译路径：400/404「不提供该模型」不 failover | 判定被包在 `401‖403‖429‖≥500` 分支内；"第一家不提供、第二家提供"的正常场景必然失败 |
| 21 | TOML 等价表头（`[a . b]`、`["a"."b"]`）认不出已存在的表 | upsert 追加重复表 → **整份 config.toml 解析失败**，用户自己的 provider/mcp_servers/projects 一起失效，而程序报"写入成功"、自检也放过（349 个 tomllib 验证样本里实测 3 例） |
| 22 | `tomlUpsertTable` 的 `\n{3,}` 全局折叠 | 改写用户**多行字符串内部**的空行；文件仍合法所以任何闸门都不会察觉 |
| 23 | `rateCooldownMs` 的抖动在夹取之后施加 | 实际上限 1.2×常量（36 分钟 vs 注释里的 30 分钟）；`Infinity` 原样返回 = 永久冷却 |
| 24 | 翻译路径的账户级失败不遵循 `Retry-After` | 上游说"600 秒后再来"，只按指数退避冷却 |
| 25 | `probe.getJson` 的 `limit` 是**字符**数不是字节数 | CJK 目录实测 2.97×（limit 1024 → 3040 字节），4MB 上限实际可到 ~12MB |
| 26 | `target-dsh.apply` 不返回 backups | `.bak-gateway` 实际存在，但界面看不到备份路径 |

### 本轮确认无问题的（对抗性测试未能打破）

- **model-meta 的异常面**：60+ 种畸形输入、10k/200k 条数组、`__proto__` 载荷 —— 无原型污染、无异常
- **`probeHeaders`**：576 组合下 `authorization` 与 `x-api-key` **从不同时出现**；`api.cline.bot.evil.com` 骗不到 cline 档
- **两个 IPC handler 的敌意入参**：~25 组零 reject；10 万项被 `slice(0,60)` 恰好截到 60
- **`applyModelPicker` 的正常矩阵**：replace 两种 × 原表空/非空/占位 —— 全对
- **`modelRow` 的转义与往返**：含 `"` `<` `&` 的名字逐字往返，无元素注入
- **引擎 `modelTimeoutMs`**：`null`/畸形条目不崩；字符串条目**不**命中逐模型超时（设计使然）
- **写回**：6 个目标（当时；iFlow 已于 2026-10 移除，见 J 节）`preview→apply→restore`，用户原有键零丢失、restore 逐字节还原
- **`writeAtomic` 闸门**：目录 / 只读 / ACL 拒绝读 / 硬链接 / 陈旧 tmp —— 原文件均未损坏、无 tmp 残留
- **`killProcessesByCommandlines`**：5 个真实诱饵进程选择正确；截断的 PID 行不产生假 PID

### 未证实（如实声明）

- **符号链接目标**：本机非管理员且未开开发者模式，`fs.symlinkSync` EPERM，未能验证
- **CSP 是否真的生效**：只读了 `index.html` 的 meta，未在 Electron 里实测；关于"inline handler 被挡"的判断基于规范
- **拖拽**用的是合成 `dataTransfer`，真实可用性未验证
- **所有上游交互都用本机假上游**，未打真实供应商

---

## J. 移除 iFlow CLI（2026-10）

**这不是审计发现，是按上游产品状态做的功能下线。**

### 依据

iFlow CLI 官方公告：

- **2026-03-20 起停止维护**
- **2026-04-17 正式关闭**
- **iFlow API 服务与模型库同步关停**
- 官方建议迁移至 Qoder

来源：[iFlow 官方告别帖](https://vibex.iflow.cn/t/topic/4819)、[iFlow CLI 站点公告](https://cli.iflow.cn)。

给一个**已经停服两个月**的产品继续写配置没有意义 —— 用户点了「写入」也连不上。

### 改了什么

| 项目 | 变更 |
|---|---|
| `src/writers/target-iflow.js` | **删除** |
| `src/writers/index.js` | 从 `TARGETS` 移除；留注释说明原因与手工回退办法 |
| `renderer/js/clients.js` | 移除样式表与说明文案里的条目 |
| `src/writers/target-envscript.js` | 端点速查里的 iFlow 一行换成 Qoder CLI |
| `tests/writers.test.js` | 移除 iFlow 用例；**新增**一条回归钉：`list()` 不含 `iflow`、`get('iflow')` 返回 `null`、`preview('iflow')` 给"未知目标" |
| `README.md` / `docs/ANTIBAN.md` | 更新目标清单，并说明备份怎么手工回退 |

**刻意保留**的两处：

- `tests/security.test.js` 里那条"测试没碰真实用户文件"的检查仍包含 `.iflow/settings.json` ——
  用户机器上可能还有这个文件，检查它是**防御性**的，与功能存废无关。
- `docs/AUDIT.md` 前四轮里的 iFlow 记述**一字未改**。那是历史审计记录，
  当时的结论在当时的代码上是对的。为了"看起来一致"去改写历史记录，比留下不一致更糟。

### 对已有用户的影响

此前用它写入过的人，备份仍在 `~/.iflow/settings.json.bak-llmgateway`。
那是一份普通 JSON，手工改回 `.iflow/settings.json` 即可 —— 但 iFlow 服务已经关了，
所以真正要做的是**迁移到别的客户端**（Qoder 或其他），用「客户端接入」页的「通用脚本」即可接上。

---

## K. 第五轮审计（2026-10-07）：引擎/宿主/界面/写入层的全面复核

**方法**：两路独立审计代理（引擎+宿主+IPC / 界面+写入层），全程只读、真实执行；
所有结论都带实跑命令与输出。主代理另做了一轮**对抗性验证**与独立复核。
仓库零改动（`git status` 为空），未触碰任何真实用户目录。

### K.1 结论总览

| | |
|---|---|
| **回归** | **0 项**。最近 8 组改动（图标重写、界面品牌 SVG、iFlow 移除、IPC 兜底包装、TOML 三函数、model-meta 上界、三级超时、`modelScopeOnly`）逐项实测均未破坏原有语义。 |
| **新发现** | 16 项，其中**确认为真 9 项**（已全部修复并补测试）。 |
| **误报** | 3 项（审计代理报的，主代理复核后推翻）。 |
| **未证实** | 4 项（如实标注，见 K.5）。 |

### K.2 确认为真并已修复

| # | 位置 | 症状 | 为什么值得修 |
|---|---|---|---|
| **N1** | `src/main.js` `write:restore` | handler **不是 async**，`writers.restore()` 返回 Promise，`r.ok` 恒为 `undefined` → **日志永远写「恢复失败」** | 实测：`await` 后 `r.ok === true`、不 await 时 `undefined`。恢复明明成功了，日志却把排错方向指反。`apply` 那侧一直是 await 的，只有这里漏了。 |
| **F1** | `src/writers/target-codex.js` + `util.tomlValidate` | 用户已有 `config.toml` 本身是坏 TOML 时，**8/8 种真实坏写法全部静默写入并报「成功」**；claude-code / opencode 同类输入都会拦 | 实测：坏行在文件中部时用户原有 `mcp_servers`/`projects` **全部保留**，所以**不是"把文件废掉"**——文件本来就是坏的。真正的伤害是：用户拿不到任何提示，界面弹绿色「写入成功」，而 Codex 自己的解析器读不了这份文件，他只会以为是本程序写坏的。 |
| **F2** | `util.writeAtomic` + 4 个目标 + 界面 | 写入失败时磁盘上**备份已生成**，但失败返回里没有 `backup` → 界面看到的是 `[]` | 失败通常发生在最后的 `rename`，而备份在那之前就生成了。"写入失败"恰恰是用户最需要知道备份在哪的时刻——否则他很可能把那份**唯一**的原始备份当垃圾删掉。 |
| **F3** | `renderer/js/logs.js` | `[route] … 无候选 provider` 被标成**绿色**（与"路由成功"同色）；`failover stopped`、404/400 决策行**无色** | 「无候选」是用户最该立刻看见的路由失败（模型名拼错 / 供应商被停用），却被贴了成功色。 |
| **F4** | 同上 | `upstream p1 网络错误（ECONNRESET）→ 原地重试一次` 被标成**红色** | 这是"抖动已自动恢复"的正常自愈，整片飘红会让用户以为网关不稳，去改配置/换供应商。 |
| **F7** | `renderer/js/clients.js` ×3 | 预览/写入/恢复三处只读 `r.errors`，不读 `r.error` → 主进程 IPC 兜底的失败一律显示"**未知错误**" | `handle()` 包装在 handler 抛异常时回的是 `{ok:false, error:'内部错误（write:xxx）：<真实异常>'}`，**没有 errors 数组**。同一份 renderer 里其它 20+ 处都正确读了 `r.error`，唯独用户最关心的这三条链路漏了。 |
| **F6** | `renderer/js/app.js` + `clients.js` | 检测失败时 `clientDetect` 被置 `[]`，而渲染层把 `[]` 显示成「**正在检测…**」→ 用户永远等不到结果 | `app.js` 的注释本来写着"要保留没检测过与检测到 0 个的区别"，但渲染层把这个区别丢了。 |
| **F8** | `src/writers/target-envscript.js` | `restore` 部分失败时 `errors` 反而是**空数组** → 界面"恢复失败：未知错误"，真实原因（EPERM + 路径）被丢弃 | 违反该文件自己声明的返回契约；codex/dsh 两处都写对了，只有这里反着来。 |
| **F5** | `src/writers/index.js` `detectAll` | **catch 兜底分支**没有 `wire` 字段（正常路径有）→ dsh 卡片显示「将写入 （未知）」 | dsh 是唯一"线协议由全局 clientProfile 决定"的目标，界面专门为它显示会写成 anthropic 还是 openai——检测一失败这块恰好失效，而那正是用户最没把握的时候。 |
| **F11** | `renderer/index.html` | CSP 里的 `frame-ancestors 'none'` 在 `<meta>` 里无效，Chromium **每次启动**往 `app.log` 写一条假 `[ERROR]` | 一条永远存在的假错误会把真错误淹掉。 |
| **N3** | `util.tomlHeaderKey` | 不处理引号内的 `\` 转义 → `["a"."llm\"gateway"]` 与 `['a'.'llm"gateway']`（**同一张表**）归一化结果不同 | 同一张表被认成两张。另外它也是 `tomlValidate` 判"表被声明两次"的依据，归一化不准 = 校验器可能漏放真重复。 |
| **F9** | 文档 / 显示名 | README 写"6 个一键写入目标"（实际 5 个）；dsh 的卡片名 `dsh` 与预览名 `dsh（DSH harness / DSH 桌面版）` 不一致 | 同一张卡片点进去标题就变了。已改成单一常量 `DISPLAY_NAME` 喂两边。 |

### K.3 顺带修掉的（审计没提，对抗性验证时发现）

**`[call] … status=502` 被标成绿色。** `[call]` 是收尾行，`status=` 是**客户端最终拿到的**状态码。
整行没有任何中文错误词，旧实现按 `[call]` 前缀一律标绿 —— **一次彻底失败的请求被显示成绿色"成功"**，
比 F3 更严重。已改为：`status=` 按状态码定级（2xx → ok，其余 → err），
`HTTP 4xx/5xx`（上游返回，请求可能已 failover 成功）→ warn。

### K.4 强化 `tomlValidate` 的过程（附带说明为什么改了这么多）

F1 的修法不是"加一句 `tomlValidate(before)`"就完事 —— 旧实现**只查结构不查行语法**，
那 8 种坏写法**全都"通过"**。所以先给它补了一层**行形状检查**。

风险在于误伤：合法 TOML 里跨行数组的续行（`  "-y",`）本来就没有 `=`。
所以实现时跟踪了方括号嵌套深度（引号内与注释里的括号不计），并且**用 Python 3.13 的 `tomllib` 做金标准逐条验证**：

```
28 个确定合法的 TOML  → 误伤 0 个（含跨行数组、多行字符串里"像表头"的行、CRLF、Unicode、转义引号键）
 6 个确定非法的行形状  → 漏判 0 个（无等号 / 表头少右括号 / JSON 混入 / 表内非键值对）
 5 个值层错误          → 3 个抓到（字符串未闭合、顶层键重复）、2 个已知边界（12abc、坏转义）不抓
```

"已知边界不抓"是**有意**的取舍：值层校验需要真正的 TOML 解析器，
半吊子实现只会制造误伤 —— 而误伤会**拦住本该成功的写入**，比漏判更糟。

### K.5 审计代理报了、但复核后**推翻**的（记下来，免得下次又报）

| 报告 | 复核结果 |
|---|---|
| `writers/index.js` 的 `restore()` 在"该目标不支持恢复"分支**缺 `return`** → 会抛 TypeError | **误报**。该行原文就是 `if (typeof t.restore !== 'function') return {…};`，`return` 一直在。（5 个目标也确实都实现了 `restore`。） |
| `stripTomlComment()` 对 TOML 字面量单引号串也把 `\` 当转义 | **误报**。源码写的是 `else if (c === '\\' && quote === '"')` —— 只在双引号里处理转义。实测 `a = 'x\' # c` → `a = 'x\' `，是**正确**结果。 |
| `probe.js` 的 `truncated` 会在"一字未丢"时误报为真 | **未能复现**。实测 6 组边界（`limit` 恰等于 8/16/23/24/25/100，body 24 字节分 3 块）`truncated` 与实际是否丢数据**完全一致**。理论上的触发条件（恰好填满 `limit` 之后还有一次空 data 事件）没能构造出来，标为未证实。 |

### K.6 对抗性实验：差异声明到底保证了什么

用一份被篡改的引擎跑 `scripts/check-engine-parity.mjs`（全程在 `%TEMP%`，未碰仓库）：

| 篡改 | 结果 |
|---|---|
| 原样 | `[OK] 无未声明变化` ✓ |
| 改一个未声明的块（`accountUsable` 改名） | 拦下 ✓ |
| 顶层插入一条非声明语句 | 拦下（归入上一块）✓ |
| 模板字符串里塞 `function fakeBlock() {}` | 拦下（伪造块边界 → 噪音，但方向是"多拦"，安全） |
| **在已声明的块 `forward` 里整段删除"地区受限 403 豁免"1632 个字符** | **照样 `[OK]`** ⚠ |

**结论：保证的粒度是"块"，不是行。** 一个块一旦进了 `DECLARED`，之后对它内部的任何修改
（包括整段删功能）都不会再被发现。

这不是缺陷（设计如此），但 README 原来那句"除声明项外，网关功能一字未减"容易被读成比实际更强的承诺。
已改写为明确的两栏说明（能保证什么 / 不能保证什么），并说明**"功能没被删"这件事是靠测试守的**——
`tests/gateway.test.js` 里"地区受限 403 只算这家不提供该模型"那几条用例才是真正钉住这段逻辑的东西。

### K.7 未证实（如实标注）

1. **真 Chromium 窗口截图**：审计代理在沙箱里起不了 Chromium 窗口（`mojo::platform::PlatformChannel`
   需要命名管道，沙箱拒绝，`STATUS_BREAKPOINT`；试过 8 组开关全部死在同一处）。
   替代证据链：真 HTML 解析器 + 真 CSSOM + 真请求记账 + 真 SVG 光栅化器（resvg）四方交叉。
   覆盖不到的是"肉眼可辨 / 1px 对齐 / 亚像素发虚"这类**像素观感**问题。
2. **`probe.js` 的 `truncated` 误报**（见 K.5）——只证明了逻辑分支存在，没构造出真实触发。
3. **`System.Drawing.Icon` 请求 256 返回 128×128** —— ICO 里 256 条目存在且内嵌 PNG 逐条 CRC 校验通过，
   判断是 GDI+ 的惯常行为而非文件缺陷，但没在真实大图标场景确认。
4. **`iconDataURL(256)` 的 62ms 在低配机型上是否放大** —— 单机实测，未做低配采样。

### K.8 验收

```
259 项 → 272 项测试全绿（新增 13 项，全部对应本轮修复）
  unit      66   writers   33   edge      29
  security  18   renderer  12   gateway  114
引擎差异校验：38 处声明改动，0 处未声明
```

---

## L. 「一键写入 dsh」的写入目标跟进官方新格式（2026-10-07）

### L.1 起因

用户提出："一键写入 dsh 应该写入当前运行的官方 dsh desktop 中"。查下去发现**目标路径对、但载体已经过时**。

### L.2 现场证据

| 事实 | 证据 |
|---|---|
| 官方程序确实读 `~/.dsh` | 官方自己设的环境变量：`DSH_HOME=C:\Users\xuexu\.dsh`、`DSH_PROFILE=desktop`、`DSH_PROFILE_DIR=...\.dsh\profiles\desktop` |
| **`settings.yaml` 已不存在** | 只剩 `settings.yaml.imported`（11 KB，含 gateway + 31 个模型） |
| **官方把它标记为 removed** | 源码 `importLegacyDocument()` 注释：*"Move the sections of **the removed `settings.yaml`** into the active profile"* |
| 它是**一次性导入** | `const path = join(profile.home, "settings.yaml"); if (!existsSync(path)) return; await rename(path, \`${path}.imported\`);` |
| 导入后写进**同名 entry** | `for (const [section, values] of …) { const ns = LEGACY_SECTION_ENTRIES[section] ?? section; await this.update(ns, values); }`；`update(ns, patch)` 的文档写明 `@param ns Profile entry id` |
| **当前 profile 里 gateway 是空的** | `~/.dsh/profiles/desktop/cordis.patch.yml`：`- id: llm-pi-ai` → `config: providers: {}` |

**结论**：旧实现只写 `settings.yaml` —— 能到达，但需要**重启 dsh**，而且导入完文件就被改名；用户遇到的现象是"命令报成功、dsh 里看不到网关"，过一阵还会凭空消失。

### L.3 修法

除 `settings.yaml` 之外，**同时**写 profile patch（`<profiles>/<name>/cordis.patch.yml` 里 `- id: llm-pi-ai` 项的 `config.providers.gateway`）—— 那才是官方当前真正加载的载体，文件头自己写着 *"Your patch layer for this dsh profile, applied after every bundle layer"*。两个都写，新老版本互相兜底。

引擎新增 `reindentBlock`（settings 里 4 空格 → patch 里 6 空格）与 `upsertGatewayInPatch`（按缩进层级定位的数组项编辑器）。

### L.4 实现过程中撞到的三个坑

**① 整段替换 `providers:` 会抹掉用户已有的供应商。**
第一版实现找到 `providers:` 就把整段换掉。实测：patch 里已有 `other:` 时**它被整个删除** —— 不可逆的数据丢失。改成"只合并 `gateway` 这一个键"，并加了一条专门的回归测试。

**② 文件不存在时只写 providers 块 → 整份 patch 变成 mapping。**
patch 的顶层是 YAML **数组**。空文件时只追加 providers 块，js-yaml 解析出来不是数组，`- id:` 项全丢。改成追加**完整的数组项**。

**③ 带内容的内联映射无法安全合并 → 拒绝改写并如实报错。**
`providers: {a: 1}` 这种形态无法在文本层面安全合并。选择抛出明确错误、由上层打印警告（`settings.yaml` 仍已写入），而不是静默跳过或猜着改。

### L.5 我自己造成的事故（必须记录）

**测试往用户的真实 dsh profile 里写了夹具数据。**

- **现象**：跑完测试后，`~/.dsh/profiles/desktop/cordis.patch.yml` 从 907 B 变成 2075 B，多出 `alpha-model`/`beta-model`/`zeta-model` 与 `baseURL http://127.0.0.1:3099`，并产生了 `.bak-gateway`。
- **原因（两层）**：
  1. `target-dsh.js` 的 `resolveProfile()` 让 `DSH_PROFILE_DIR` 环境变量**优先于**调用方传入的 `ctx.home` —— 测试明明把 home 指向临时目录，却被环境变量带回了真实 profile。
  2. 引擎侧同理：`gateway.test.js` / `unit.js` 直接 spawn `--write-dsh` 时只传 `--settings`（指向临时目录）**没传 profile 参数**，引擎于是回退读 `DSH_PROFILE_DIR`。
- **第一次修得不彻底**：只修了 `target-dsh.js`，重跑测试后**真实 profile 又被写了一次**。直到把引擎侧也修了才真正封死。
- **最终修法**：
  - `resolveProfile(ctx)`：`ctx.home` 一旦给出，就是唯一真相，环境变量一律让位。
  - 引擎：`--settings` **一旦显式给出，它所在目录就是本次操作的 dsh home**，profile 从那里派生，不再回退到环境变量。
  - `target-dsh.js` 的 spawn 始终显式传 `--profiles-dir` + `--profile`，与 detect/preview 同源。
- **新增守卫**：`tests/security.test.js` 增加一条 —— 扫描真实的 `~/.dsh/profiles/**`，一旦出现测试夹具的痕迹（`alpha-model` 等）就失败。与已有的 `.iflow/settings.json` 守卫同类。
- **恢复**：用写入前自动生成的 `.bak-gateway`（907 B）逐字节还原，备份文件已清理。定点验证（环境里带着真实 `DSH_PROFILE_DIR`、`--settings` 指向临时目录）确认：写入落在临时 profile，真实 profile 哈希前后一致。

**教训**：让"环境变量"与"调用方显式参数"争夺同一个路径的所有权，是这个项目里第二次栽在同一类问题上（第一次是 `ELECTRON_RUN_AS_NODE` 污染资源管理器）。**显式参数一旦给出，就必须完全覆盖环境变量。**

### L.6 验收

```
275 项测试全绿（272 → +3：profile patch 写入、合并不抹除、真实 profile 守卫）
  unit 66 / writers 35 / edge 29 / security 19 / renderer 12 / gateway 114
引擎差异校验：42 处声明改动，0 处未声明
端到端（临时 DSH home + 真实引擎）：desktop patch 写入正确、原有项保留、
  web profile 未被误改、settings.yaml 与 credentials 同时就位、
  产物经 PyYAML 独立校验 ALL OK
真实 profile：测试全程哈希不变（32B8AF25…，907 B）
```


