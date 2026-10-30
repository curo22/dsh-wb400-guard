# 把本仓库作为本地插件挂到当前 profile，用于开发调试。
#
#   .\scripts\link-local.ps1           建 junction 指向本仓库（改代码即时生效）
#   .\scripts\link-local.ps1 -Remove   拆掉
#
# 与 install.mjs 的区别：
#   install.mjs  把文件**拷贝**进 profile\vendor，适合分发/公开发布
#   link-local   把 profile\node_modules 直接**指向本仓库**，适合改代码

param([switch]$Remove)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$prof = if ($env:DSH_PROFILE_DIR) { $env:DSH_PROFILE_DIR } else { "$env:USERPROFILE\.dsh\profiles\desktop" }
$link = Join-Path $prof 'node_modules\dsh-wb400-guard'

if ($Remove) {
  if (Test-Path $link) {
    cmd /c rmdir "`"$link`""
    Write-Host "已拆除 $link" -ForegroundColor Green
  } else {
    Write-Host "$link 本来就不存在" -ForegroundColor Yellow
  }
  Write-Host '记得从 profile 的 package.json 里移除 dependencies 与 bundles 条目。' -ForegroundColor Yellow
  exit 0
}

if (Test-Path $link) { cmd /c rmdir "`"$link`"" }
New-Item -ItemType Junction -Path $link -Target $repo | Out-Null
Write-Host "已链接 $link -> $repo" -ForegroundColor Green
Write-Host ''
Write-Host '接下来在 profile 的 package.json 里加：' -ForegroundColor Cyan
Write-Host '  "dependencies": { "dsh-wb400-guard": "link:./node_modules/dsh-wb400-guard" }'
Write-Host '  "dsh": { "profile": { "bundles": [ ..., "dsh-wb400-guard" ] } }'
Write-Host ''
Write-Host '然后重启 DSH Desktop。' -ForegroundColor Cyan
