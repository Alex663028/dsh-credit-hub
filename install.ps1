<#
.SYNOPSIS
  dsh-credit-hub（积分汇通）一键安装脚本。

.DESCRIPTION
  把插件以 link: 方式接入本机 DSH profile：
    1. 定位 DSH_HOME / profile 目录
    2. 备份 profile/package.json
    3. 写入 dependencies["dsh-credit-hub"] = "link:<本仓库路径>"
    4. 把 "dsh-credit-hub" 加进 dsh.profile.bundles
    5. 执行 pnpm install
  只改这一个 package.json，且在改动前备份；其它字段一律原样保留。

.PARAMETER ProfileDir
  显式指定 profile 目录（默认自动探测 desktop profile）。

.PARAMETER DshHome
  显式指定 DSH_HOME（默认 %USERPROFILE%\.dsh）。

.PARAMETER DryRun
  只打印将要做的改动，不写文件、不跑 pnpm。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install.ps1 -DryRun
#>
[CmdletBinding()]
param(
  [string]$ProfileDir,
  [string]$DshHome,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$pluginRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$pluginName = 'dsh-credit-hub'

function Write-Step($text) { Write-Host "`n==> $text" -ForegroundColor Cyan }
function Write-Ok($text)   { Write-Host "    $text" -ForegroundColor Green }
function Write-Warn2($text){ Write-Host "    $text" -ForegroundColor Yellow }

# ── 1. 定位 DSH_HOME ─────────────────────────────────────────────────────────
Write-Step '定位 DSH'
if (-not $DshHome) {
  if ($env:DSH_HOME) { $DshHome = $env:DSH_HOME }
  else { $DshHome = Join-Path $env:USERPROFILE '.dsh' }
}
if (-not (Test-Path $DshHome)) {
  throw "找不到 DSH_HOME：$DshHome。请确认已安装 DeepSeek Harness，或用 -DshHome 指定。"
}
Write-Ok "DSH_HOME = $DshHome"

# ── 2. 定位 profile 目录 ─────────────────────────────────────────────────────
if (-not $ProfileDir) {
  $envProfile = $env:DSH_PROFILE_DIR
  if ($envProfile -and (Test-Path $envProfile)) {
    $ProfileDir = $envProfile
  } else {
    $candidates = @()
    $profilesRoot = Join-Path $DshHome 'profiles'
    if (Test-Path $profilesRoot) {
      $candidates = Get-ChildItem $profilesRoot -Directory |
        Where-Object { Test-Path (Join-Path $_.FullName 'package.json') }
    }
    if ($candidates.Count -eq 1) {
      $ProfileDir = $candidates[0].FullName
    } elseif ($candidates.Count -gt 1) {
      Write-Warn2 "检测到多个 profile，默认用 desktop："
      $candidates | ForEach-Object { Write-Warn2 "  - $($_.Name)" }
      $desktop = $candidates | Where-Object { $_.Name -eq 'desktop' } | Select-Object -First 1
      $ProfileDir = if ($desktop) { $desktop.FullName } else { $candidates[0].FullName }
    }
  }
}
if (-not $ProfileDir -or -not (Test-Path $ProfileDir)) {
  throw "定位不到 DSH profile 目录。请用 -ProfileDir 指定（例如 $DshHome\profiles\desktop）。"
}
$profileJson = Join-Path $ProfileDir 'package.json'
if (-not (Test-Path $profileJson)) { throw "profile 下没有 package.json：$profileJson" }
Write-Ok "profile = $ProfileDir"

# ── 3. 读现有 package.json ──────────────────────────────────────────────────
Write-Step '读取并校验 package.json'
$raw = Get-Content $profileJson -Raw -Encoding UTF8
$doc = $null
try { $doc = $raw | ConvertFrom-Json } catch { throw "package.json 不是合法 JSON，已中止（未做任何修改）：$($_.Exception.Message)" }
if ($null -eq $doc) { throw 'package.json 解析为空，已中止（未做任何修改）。' }
Write-Ok "JSON 合法"

# ── 4. 计算目标改动（先算后写） ─────────────────────────────────────────────
Write-Step '计算改动'
$linkTarget = "link:$($pluginRoot -replace '\\','/')"
$depExists = $doc.dependencies -and $doc.dependencies.PSObject.Properties.Name -contains $pluginName
$currentDep = if ($depExists) { $doc.dependencies.$pluginName } else { $null }

# bundles 可能是数组，也可能不存在
$bundlesBefore = @()
if ($doc.dsh -and $doc.dsh.profile -and $doc.dsh.profile.bundles) { $bundlesBefore = @($doc.dsh.profile.bundles) }
$bundleExists = $bundlesBefore -contains $pluginName

Write-Ok "dependencies['$pluginName'] : $(if ($depExists) { $currentDep } else { '（不存在）' }) -> $linkTarget"
Write-Ok "dsh.profile.bundles          : $(if ($bundleExists) { '已包含' } else { '将追加' })"

if ($DryRun) {
  Write-Host "`n[DryRun] 未写入任何文件。" -ForegroundColor Yellow
  exit 0
}

# ── 5. 备份 ─────────────────────────────────────────────────────────────────
Write-Step '备份 profile/package.json'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = "$profileJson.bak-$stamp"
Copy-Item $profileJson $backup -Force
Write-Ok "备份 -> $backup"

# ── 6. 写入（先写临时文件再替换，失败可回滚） ───────────────────────────────
Write-Step '写入配置'
if (-not $doc.dependencies) { $doc | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{}) -Force }
$doc.dependencies | Add-Member -NotePropertyName $pluginName -NotePropertyValue $linkTarget -Force

if (-not $doc.dsh) { $doc | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{}) -Force }
if (-not $doc.dsh.profile) { $doc.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{}) -Force }
$newBundles = @($bundlesBefore)
if (-not $bundleExists) { $newBundles += $pluginName }
$doc.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue $newBundles -Force

$jsonOut = $doc | ConvertTo-Json -Depth 32
$tmp = "$profileJson.tmp-$stamp"
try {
  [System.IO.File]::WriteAllText($tmp, $jsonOut, (New-Object System.Text.UTF8Encoding($false)))
  # 回读校验，确认是合法 JSON 再替换
  $verify = Get-Content $tmp -Raw -Encoding UTF8 | ConvertFrom-Json
  if (-not ($verify.dsh.profile.bundles -contains $pluginName)) { throw '回读校验失败：bundles 未包含插件' }
  Move-Item $tmp $profileJson -Force
  Write-Ok '已写入并校验通过'
} catch {
  if (Test-Path $tmp) { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
  throw "写入失败，已回滚（原文件未动）：$($_.Exception.Message)"
}

# ── 7. pnpm install ─────────────────────────────────────────────────────────
Write-Step '安装依赖（pnpm install）'
if (Get-Command pnpm -ErrorAction SilentlyContinue) {
  Push-Location $ProfileDir
  try {
    pnpm install
    if ($LASTEXITCODE -ne 0) {
      Write-Warn2 "pnpm install 退出码 $LASTEXITCODE（依赖未能全部装好）"
      Write-Warn2 "请手动进入 $ProfileDir 执行 pnpm install 排查"
    } else {
      Write-Ok 'pnpm install 完成'
    }
  } catch {
    Write-Warn2 "pnpm install 失败：$($_.Exception.Message)"
    Write-Warn2 "可手动进入 $ProfileDir 执行 pnpm install"
  } finally { Pop-Location }
} else {
  Write-Warn2 '未找到 pnpm，请手动执行：'
  Write-Warn2 "  cd `"$ProfileDir`"; pnpm install"
}

# ── 8. 完成 ─────────────────────────────────────────────────────────────────
Write-Host "`n安装完成 ✓" -ForegroundColor Green
Write-Host "下一步：完全退出 DSH 后重新启动（托盘退出，确认无 DeepSeek Harness 进程），" -ForegroundColor White
Write-Host "       然后 设置 → 积分汇通。" -ForegroundColor White
Write-Host "如需回滚：Copy-Item `"$backup`" `"$profileJson`" -Force" -ForegroundColor DarkGray
