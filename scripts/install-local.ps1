# 给本机 DSH Desktop 装上这个插件（从本仓库直接装）。
#
#   .\scripts\install-local.ps1
#   .\scripts\install-local.ps1 -ProfileDir 'D:\other\profile'
#   .\scripts\install-local.ps1 -Uninstall
#
# 只是 node install.mjs 的薄包装：找 Node、透传参数、把退出码带回来。

param(
  [string]$ProfileDir = '',
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host '找不到 node。先装 Node.js 22 或 24：https://nodejs.org/' -ForegroundColor Red
  exit 1
}

$installer = Join-Path $repo 'install.mjs'
if (-not (Test-Path $installer)) {
  Write-Host "找不到 $installer，请在仓库根目录下运行。" -ForegroundColor Red
  exit 1
}

$args = @($installer)
if ($ProfileDir) { $args += $ProfileDir }
if ($Uninstall) { $args += '--uninstall' }

& node @args
exit $LASTEXITCODE
