# release.ps1 — 统一的发布流水线（替代 _scratch 里每个版本复制一份的 rel*.ps1）
#
# 用法：
#   pwsh -File scripts\release.ps1 -Version 1.0.2
#   pwsh -File scripts\release.ps1 -Version 1.0.2 -Notes D:\path\to\notes.md -SkipTests
#   pwsh -File scripts\release.ps1 -Version 1.0.2 -DryRun          # 只打印将要做什么
#
# 参数：
#   -Version   必填。必须与 package.json 的 version 一致（不一致直接中止，防"发错版本"）。
#   -Notes     发布说明 md 路径。缺省按惯例找 _scratch\rel<1><0><1>.md（如 rel101.md）。
#   -Token     GitHub PAT。**刻意没有默认值** —— 取值顺序：-Token → $env:GITHUB_TOKEN
#              → _scratch\.gh-token（未跟踪）。绝不把密钥写进这个脚本（它是要进仓库的）。
#   -SkipTests 跳过 npm test（不建议；门禁仍会跑）
#   -NoAppStop 构建时不停止运行中的应用（仅当你确认没有文件锁时用）
#   -TagNote   标签注解（缺省 "LLM Gateway v<版本>"）。⚠ 不能含双引号。
#   -OutName   产物目录名，默认 LLM-Gateway（配合 -OnlyGate 可验别的目录，如 .verify-test）
#   -OnlyGate  只跑门禁后退出（构建完想单独复验，或发布中断后重验）
#   -DryRun    只打印步骤，不做任何改动
#
# 步骤（门禁插在**正确的位置**：构建之后、发布之前）：
#   0  前置检查：版本一致 / 说明文件存在 / token 可用
#   1  全量测试            npm test
#   2  提交（若工作区脏）—— 门禁的 B 要求工作区干净；发布必须能复现到某个 HEAD
#   3  构建                pack → build-portable（需停应用）→ dist
#   4  ★ 门禁 1            verify-artifact：产物 == 源码 == HEAD   ← 不通过就**在这里停**
#   5  推送 main
#   6  打附注标签 + 推送
#   7  创建 Release（先清同名旧附件）
#   8  上传三个产物
#   9  确认 3/3 且 created_at 是今天（防"附件其实是上一版"）
#  10  线上校验：把 zip 下载回来比对大小 + sha256
#
# 为什么门禁放在 4 而不是更早：verify-artifact 的 B 检查要求工作区干净，
# 而 A 检查要求产物与源码一致 —— 只有"先提交、再构建"之后，这两条才同时可验。
# 放在更早（构建前）只能验"源码==HEAD"，验不了"产物==源码"；
# 放在发布后则已经来不及 —— 所以插在"构建完成、尚未推送"这个位置。
[CmdletBinding()]
param(
  [string]$Version = '',
  [string]$Notes = '',
  [string]$Token = '',
  [switch]$SkipTests,
  [switch]$NoAppStop,
  [string]$OutName = 'LLM-Gateway',
  [string]$TagNote = '',
  [switch]$OnlyGate,
  [switch]$DryRun
)

$ErrorActionPreference = 'Continue'
$ROOT = Split-Path -Parent $PSScriptRoot          # 仓库根（scripts\ 的上一级）
$GIT = 'C:\Program Files\Git\cmd\git.exe'
if (-not (Test-Path $GIT)) { $GIT = 'git' }
$CURL = Join-Path $env:SystemRoot 'System32\curl.exe'
$REPO = 'xuxue04403/llm-gateway'
$OUT_NAME = $OutName

$fail = { param($m) Write-Host "`n✗ $m" -ForegroundColor Red; exit 1 }

function Step($n, $t) { Write-Host "`n==== $n) $t ====" -ForegroundColor Cyan }
function Ok($m) { Write-Host "  ✓ $m" -ForegroundColor Green }
function Info($m) { Write-Host "  $m" }
function Warn($m) { Write-Host "  ⚠ $m" -ForegroundColor Yellow }

# ─────────────────────────── 0) 前置检查 ───────────────────────────
Step 0 '前置检查'
Set-Location $ROOT
$pkg = Get-Content (Join-Path $ROOT 'package.json') -Raw | ConvertFrom-Json
# -Version 可省略：缺省就用 package.json 里的版本（仍然会做一致性校验，防"发错版本"）
if (-not $Version) { $Version = $pkg.version; Info "未指定 -Version，采用 package.json 的 $Version" }
Info "package.json version = $($pkg.version)   目标版本 = $Version"
if ($pkg.version -ne $Version) {
  & $fail "版本不一致：package.json 是 $($pkg.version)，你要求发 $Version。先改版本号（并提交）再发布。"
}

# 发布说明
if (-not $Notes) {
  $flat = ($Version -replace '\.', '')                     # 1.0.1 → 101
  foreach ($cand in @("D:\IDE\dsh\_scratch\rel$flat.md", "D:\IDE\dsh\_scratch\rel$Version.md")) {
    if (Test-Path $cand) { $Notes = $cand; break }
  }
}
if (-not $Notes -or -not (Test-Path $Notes)) {
  & $fail "找不到发布说明。用 -Notes <path> 指定（习惯路径：_scratch\rel$(($Version -replace '\.','')).md）"
}
$notesText = Get-Content $Notes -Raw
Info "发布说明 = $Notes（$([math]::Round((Get-Item $Notes).Length/1KB,1)) KB）"
if ($notesText -match '"') { Warn '发布说明里含双引号 —— JSON 转义会处理，但标签注解里不能有（本脚本标签注解是另写的）' }

# token
if (-not $Token) { $Token = $env:GITHUB_TOKEN }
if (-not $Token) {
  $tf = 'D:\IDE\dsh\_scratch\.gh-token'
  if (Test-Path $tf) { $Token = (Get-Content $tf -Raw).Trim() }
}
if (-not $Token) {
  & $fail @"
拿不到 GitHub token。三种给法（任选）：
    · pwsh -File scripts\release.ps1 -Version $Version -Token <PAT>
    · 设环境变量 GITHUB_TOKEN
    · 把 PAT 写进 D:\IDE\dsh\_scratch\.gh-token（该目录在仓库之外，不会被提交）
  ⚠ 不要把 PAT 写进 scripts\release.ps1 —— 这个文件是要进仓库的。
"@
}
$basic = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("x-access-token:$Token"))
Ok '前置检查通过'

# ── -OnlyGate：只跑门禁（构建完想单独复验、或发布中断后重跑门禁）──
if ($OnlyGate) {
  Step 'G' '只跑门禁（-OnlyGate）'
  node (Join-Path $ROOT 'scripts\verify-artifact.mjs') $OUT_NAME
  if ($LASTEXITCODE -ne 0) { & $fail '门禁未通过' }
  Ok '门禁通过'
  exit 0
}

# 产物路径
$zipPath = Join-Path $ROOT "out\$OUT_NAME-$Version.zip"
$exePortable = Join-Path $ROOT "dist\LLMGateway-Portable-$Version-x64.exe"
$exeSetup = Join-Path $ROOT "dist\LLMGateway-Setup-$Version-x64.exe"

if ($DryRun) { Write-Host "`n[DryRun] 只打印，不做任何改动`n" -ForegroundColor Magenta }

# ─────────────────────────── 1) 全量测试 ───────────────────────────
Step 1 '全量测试'
if ($SkipTests) { Warn '已按 -SkipTests 跳过（门禁仍会跑）' }
elseif ($DryRun) { Info '将执行 npm test' }
else {
  npm test 2>&1 | Select-String -Pattern '=====.*passed|^\s*FAIL' | ForEach-Object { "    " + $_.Line.Trim() }
  if ($LASTEXITCODE -ne 0) { & $fail '测试未全部通过 —— 修好再发布（门禁只保证"发的是这份代码"，不保证"代码是对的"）' }
  Ok '测试全部通过'
}

# ─────────────────────────── 2) 提交 ───────────────────────────
Step 2 '提交（门禁 B 要求工作区干净）'
$dirty = @(& $GIT -C $ROOT status --porcelain)
if ($dirty.Count -eq 0) { Ok '工作区已干净，无需提交' }
else {
  Info "待提交 $($dirty.Count) 项："
  $dirty | ForEach-Object { "      $_" }
  if ($DryRun) { Info '将执行 git add -A && git commit' }
  else {
    & $GIT -C $ROOT add -A
    & $GIT -C $ROOT commit -m "chore(release): v$Version" 2>&1 | Select-Object -First 3
    if ($LASTEXITCODE -ne 0) { & $fail 'git commit 失败' }
    Ok "已提交：$(& $GIT -C $ROOT rev-parse --short HEAD)"
  }
}

# ─────────────────────────── 3) 构建 ───────────────────────────
Step 3 '构建产物'
if ($DryRun) { Info "将执行 npm run pack → node scripts\build-portable.mjs $OUT_NAME → npm run dist" }
else {
  $appExe = Join-Path $ROOT "out\$OUT_NAME\$($pkg.productName).exe"
  $port = 3091
  try { $port = (Get-Content (Join-Path $ROOT "out\$OUT_NAME\data\gateway.config.json") -Raw | ConvertFrom-Json).port } catch { }

  # 3a) 先打 dist（应用可继续运行，只写 dist\）
  Info 'npm run pack …'
  npm run pack 2>&1 | Select-Object -Last 3
  if ($LASTEXITCODE -ne 0) { & $fail 'npm run pack 失败' }

  # 3b) build-portable 会就地重建 out\<name>，**必须先停应用**释放文件锁
  $stopped = $false
  if (-not $NoAppStop) {
    Info '停止应用以释放文件锁…'
    # ⚠ 只按 ProcessName 过滤会**漏掉网关引擎子进程**（实测踩到：残留引擎占着端口，
    #    新实例起不来，而 /health 看似正常 —— 其实是旧引擎在服务）。
    #    所以按「端口 owner + exe 路径」双路找 PID，并 taskkill /T 连进程树一起清。
    $pids = New-Object System.Collections.Generic.HashSet[int]
    foreach ($l in (cmd /c "netstat -ano | findstr :$port")) {
      $f = ($l -split '\s+') | Where-Object { $_ }
      if ($f.Count -ge 5 -and $f[3] -eq 'LISTENING') { [void]$pids.Add([int]$f[4]) }
    }
    foreach ($p in @(Get-Process -ErrorAction SilentlyContinue)) {
      try { if ($p.Path -and $appExe -and ($p.Path -eq $appExe)) { [void]$pids.Add([int]$p.Id) } } catch { }
    }
    foreach ($p in @($pids)) { & taskkill /F /T /PID $p 2>&1 | Out-Null }
    for ($i = 0; $i -lt 40; $i++) {
      Start-Sleep -Milliseconds 500
      if (@(cmd /c "netstat -ano | findstr :$port" | Where-Object { $_ -match 'LISTENING' }).Count -eq 0) { break }
    }
    $stopped = $true
    Ok "应用已停止（清掉 $($pids.Count) 个进程），端口 $port 已释放"
  }

  Info "重建 out\$OUT_NAME …"
  node (Join-Path $ROOT 'scripts\build-portable.mjs') $OUT_NAME 2>&1 | Select-Object -Last 8
  if ($LASTEXITCODE -ne 0) { & $fail 'build-portable 失败' }

  Info 'npm run dist …'
  npm run dist 2>&1 | Select-Object -Last 4

  # 3c) 无论成败都要把应用拉起来
  if ($stopped) {
    $env:ELECTRON_RUN_AS_NODE = $null
    if (Test-Path $appExe) {
      Start-Process -FilePath $appExe -WorkingDirectory (Split-Path $appExe -Parent) | Out-Null
      for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Seconds 1
        try { if ((Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -TimeoutSec 5).ok) { Ok "应用已重启（第 $($i+1) 秒 /health OK）"; break } } catch { }
      }
    } else { Warn "找不到 $appExe，未能自动重启应用" }
  }
}

# ─────────────────────────── 4) ★ 门禁 ───────────────────────────
Step 4 '★ 门禁：产物 == 源码 == HEAD'
if ($DryRun) { Info '将执行 node scripts\verify-artifact.mjs（不通过则中止发布）' }
else {
  node (Join-Path $ROOT 'scripts\verify-artifact.mjs') $OUT_NAME
  if ($LASTEXITCODE -ne 0) {
    & $fail @"
门禁未通过 —— **已中止发布**（没有推送、没有打标签、没有建 Release）。
  产物与"刚提交的源码"不一致，说明构建没跟上，或构建期间源码又被动过。
  处理：重新跑一次发布（脚本会重新构建），或先弄干净工作区再看 A/C 的具体报错。
"@
  }
  Ok '门禁通过：产物就是当前源码，且源码已提交到 HEAD'
}

# ─────────────────────────── 5) 推送 ───────────────────────────
Step 5 '推送 main'
if ($DryRun) { Info '将执行 git push origin main（带 basic auth 头，失败重试 6 次）' }
else {
  $pushed = $false
  for ($i = 1; $i -le 6; $i++) {
    & $GIT -C $ROOT -c "http.extraheader=Authorization: Basic $basic" push origin main 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) { Ok "第 $i 次成功"; $pushed = $true; break }
    Info "第 $i 次失败，重试…"; Start-Sleep 6
  }
  if (-not $pushed) { & $fail '推送 main 失败' }
  Info "local=$(& $GIT -C $ROOT rev-parse --short main)  remote=$(& $GIT -C $ROOT rev-parse --short origin/main)"
}

# ─────────────────────────── 6) 标签 ───────────────────────────
Step 6 "附注标签 v$Version"
if ($DryRun) { Info "将执行 git tag -a v$Version（⚠ 注解里不能有双引号）并推送" }
else {
  & $GIT -C $ROOT tag -d "v$Version" 2>&1 | Out-Null
  $note = if ($TagNote) { $TagNote } else { "LLM Gateway v$Version" }
  # ⚠ 注解里不能有双引号 —— PowerShell 传参时会被吃掉（实测踩到），所以这里只在传入值里做校验
  if ($note -match '"') { & $fail '标签注解里不能有双引号（PowerShell 传参会吃掉它）' }
  & $GIT -C $ROOT tag -a "v$Version" -m $note main
  $tagged = $false
  for ($i = 1; $i -le 6; $i++) {
    & $GIT -C $ROOT -c "http.extraheader=Authorization: Basic $basic" push origin "v$Version" 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) { Ok '标签已推送'; $tagged = $true; break }
    Start-Sleep 6
  }
  if (-not $tagged) { & $fail '标签推送失败' }
  Info "标签类型 = $(& $GIT -C $ROOT cat-file -t "v$Version")（应为 tag，附注标签）"
}

# ─────────────────────────── 7) 创建 Release ───────────────────────────
Step 7 '创建 Release'
$H = @('-H', "Authorization: Bearer $Token", '-H', 'User-Agent: lg-publish', '-H', 'Accept: application/vnd.github+json')
$rel = $null
if ($DryRun) { Info "将 POST /repos/$REPO/releases（tag v$Version）" }
else {
  $payload = @{ tag_name = "v$Version"; name = "LLM Gateway v$Version"; body = $notesText; draft = $false; prerelease = $false } | ConvertTo-Json -Depth 3
  $jp = Join-Path $env:TEMP "rel-$Version.json"
  [IO.File]::WriteAllText($jp, $payload, (New-Object Text.UTF8Encoding($false)))
  for ($i = 1; $i -le 6; $i++) {
    $out = & $CURL -s -X POST @H -H 'Content-Type: application/json' --data-binary "@$jp" --max-time 180 "https://api.github.com/repos/$REPO/releases" 2>&1
    try { $rel = ($out -join '') | ConvertFrom-Json } catch { $rel = $null }
    if ($rel -and $rel.id) { Ok "已创建 id=$($rel.id)"; break }
    $ex = (& $CURL -s @H --max-time 90 "https://api.github.com/repos/$REPO/releases/tags/v$Version" 2>&1) -join ''
    try { $t = $ex | ConvertFrom-Json; if ($t -and $t.id) { $rel = $t; Ok "已存在，复用 id=$($t.id)"; break } } catch { }
    Info "第 $i 次失败，重试…"; Start-Sleep 8
  }
  if (-not ($rel -and $rel.id)) { & $fail '创建 Release 失败' }

  # 先清同名旧附件 —— v0.9.0 踩过：Release 里挂着**旧附件**，新上传全部 422 already_exists，
  # 而最后"3/3 附件齐全"的确认**看起来正常**，差点把旧产物当新版本发出去。
  $existing = @($rel.assets)
  if ($existing.Count) {
    Info "清理 $($existing.Count) 个同名旧附件…"
    foreach ($a in $existing) {
      & $CURL -s -X DELETE @H --max-time 90 "https://api.github.com/repos/$REPO/releases/assets/$($a.id)" 2>&1 | Out-Null
      Start-Sleep 2
    }
    Start-Sleep 3
  }
}

# ─────────────────────────── 8) 上传 ───────────────────────────
Step 8 '上传三个产物'
$files = @($zipPath, $exePortable, $exeSetup)
foreach ($f in $files) {
  if (-not (Test-Path $f)) { & $fail "缺产物：$f" }
}
if ($DryRun) { $files | ForEach-Object { Info "将上传 $(Split-Path $_ -Leaf)（$([math]::Round((Get-Item $_).Length/1MB,1)) MB）" } }
else {
  foreach ($f in $files) {
    $nm = Split-Path $f -Leaf
    $sz = [math]::Round((Get-Item $f).Length / 1MB, 1)
    Info "… $nm ($sz MB)"
    $url = "https://uploads.github.com/repos/$REPO/releases/$($rel.id)/assets?name=$([uri]::EscapeDataString($nm))"
    $ok = $false
    for ($i = 1; $i -le 8; $i++) {
      # ⚠ --speed-limit/--speed-time：没有它大文件会在 ~400s / ~40MB 处卡死（实测）
      $r = & $CURL -s -X POST @H -H 'Content-Type: application/octet-stream' `
        --speed-limit 20480 --speed-time 25 --max-time 2400 `
        --data-binary "@$f" -w "`n__HTTP=%{http_code} __SENT=%{size_upload}" $url 2>&1
      $txt = ($r -join '')
      $http = ([regex]::Match($txt, '__HTTP=(\d+)')).Groups[1].Value
      $sent = [int64]([regex]::Match($txt, '__SENT=(\d+)')).Groups[1].Value
      if ($http -eq '201' -and $sent -ge (Get-Item $f).Length) { Ok "第 $i 次成功"; $ok = $true; break }
      Info "第 $i 次：HTTP=$http 已传 $([math]::Round($sent/1MB,1))MB → 重试"
      Start-Sleep 6
    }
    if (-not $ok) { & $fail "上传失败：$nm" }
  }
}

# ─────────────────────────── 9) 确认附件 ───────────────────────────
Step 9 '确认附件'
if ($DryRun) { Info '将确认 3/3 且 created_at 是今天' }
else {
  $j = $null
  for ($i = 1; $i -le 8; $i++) {
    Start-Sleep 5
    $raw = (& $CURL -s @H --max-time 90 "https://api.github.com/repos/$REPO/releases/tags/v$Version" 2>&1) -join ''
    try { $j = $raw | ConvertFrom-Json } catch { $j = $null }
    if ($j -and $j.assets -and @($j.assets).Count -ge 3) { break }
  }
  if (-not ($j -and $j.assets)) { & $fail '拿不到 Release 附件清单' }
  Info "状态=$(if($j.draft){'草稿'}else{'已发布'})  附件 $(@($j.assets).Count)/3"
  $today = (Get-Date).ToString('yyyy-MM-dd')
  $stale = 0
  foreach ($a in $j.assets) {
    $code = (& $CURL -s -L -o NUL -w '%{http_code}' -r 0-0 --max-time 180 $a.browser_download_url 2>&1) -join ''
    $created = ([datetime]$a.created_at).ToLocalTime().ToString('yyyy-MM-dd HH:mm')
    $isOld = -not $created.StartsWith($today)
    if ($isOld) { $stale++ }
    Info "$($a.state.PadRight(9)) $($a.name.PadRight(36)) $([math]::Round($a.size/1MB,1)) MB  创建=$created$(if($isOld){'  ⚠ 不是今天！'})  HTTP=$code"
  }
  if (@($j.assets).Count -lt 3) { & $fail "附件不足 3 个（$(@($j.assets).Count)）" }
  # ⚠ 必须打印 created_at：只报"3/3 齐全"会掩盖"附件其实是上一版"（v0.9.0 踩过）
  if ($stale) { & $fail "有 $stale 个附件不是今天创建的 —— 很可能是旧产物" }
  Ok "3/3 且全部为今天创建  $($j.html_url)"
}

# ─────────────────────────── 10) 线上校验 ───────────────────────────
Step 10 '线上校验：下载回来比对 sha256'
if ($DryRun) { Info '将下载线上 zip 并与本地逐字节比对' }
else {
  $tmp = Join-Path $env:TEMP "$OUT_NAME-$Version-online.zip"
  if (Test-Path $tmp) { Remove-Item $tmp -Force }
  $url = "https://github.com/$REPO/releases/download/v$Version/$OUT_NAME-$Version.zip"
  Info '下载中…'
  & $CURL -s -L --speed-limit 20480 --speed-time 25 --max-time 2400 -o $tmp $url
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path $tmp)) { & $fail '下载线上 zip 失败' }
  $hl = (Get-FileHash $zipPath -Algorithm SHA256).Hash
  $hd = (Get-FileHash $tmp -Algorithm SHA256).Hash
  Info "本地   $((Get-Item $zipPath).Length) 字节  $hl"
  Info "线上   $((Get-Item $tmp).Length) 字节  $hd"
  if ($hl -ne $hd) { & $fail '线上 zip 与本地不一致 —— 发布产物有问题' }
  Remove-Item $tmp -Force -ErrorAction SilentlyContinue
  Ok '线上 zip 与本地逐字节一致'
}

Write-Host "`n=========================================" -ForegroundColor Green
Write-Host " v$Version 发布完成" -ForegroundColor Green
Write-Host "=========================================" -ForegroundColor Green
Info "工作区改动 = $(@(& $GIT -C $ROOT status --porcelain).Count)"
Info "最新标签   = $(& $GIT -C $ROOT describe --tags --abbrev=0)"
