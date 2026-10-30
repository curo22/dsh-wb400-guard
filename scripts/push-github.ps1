# 把本仓库推到 GitHub。
#
#   .\scripts\push-github.ps1
#   .\scripts\push-github.ps1 -Repo 'other-user/other-repo' -Branch main
#
# 会先验证 SSH 通不通、远端仓库存不存在，再推。失败时说清是哪一步的问题。

param(
  [string]$Repo = 'curo22/dsh-wb400-guard',
  [string]$Branch = 'main'
)

$ErrorActionPreference = 'Continue'
$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot

try {
  Write-Host '=== 1. 检查本地状态 ===' -ForegroundColor Cyan
  $dirty = git status --porcelain
  if ($dirty) {
    Write-Host '工作区有未提交的改动：' -ForegroundColor Yellow
    $dirty | ForEach-Object { Write-Host "  $_" }
    Write-Host '先提交或 stash，再跑这个脚本。' -ForegroundColor Yellow
    exit 1
  }
  $tip = git log -1 --pretty='%h %s'
  Write-Host "  本地 HEAD: $tip" -ForegroundColor Gray

  Write-Host ''
  Write-Host '=== 2. 检查 SSH 认证 ===' -ForegroundColor Cyan
  $auth = ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -T git@github.com 2>&1 | Out-String
  # 成功的标志是 "successfully authenticated"（GitHub 用 stderr 输出这句话）
  if ($auth -notmatch 'successfully authenticated') {
    Write-Host '  SSH 认证不通过。原始输出：' -ForegroundColor Red
    Write-Host "  $($auth.Trim())" -ForegroundColor Red
    Write-Host ''
    Write-Host '  通常是公钥还没加到 GitHub 账号：' -ForegroundColor Yellow
    Write-Host '    https://github.com/settings/ssh/new' -ForegroundColor Yellow
    Write-Host '  当前机器的公钥：' -ForegroundColor Yellow
    Get-Content "$env:USERPROFILE\.ssh\id_ed25519_github.pub" | ForEach-Object { Write-Host "    $_" -ForegroundColor Yellow }
    exit 1
  }
  Write-Host '  认证通过' -ForegroundColor Green

  Write-Host ''
  Write-Host '=== 3. 检查远端仓库 ===' -ForegroundColor Cyan
  $remote = "git@github.com:$Repo.git"
  git remote remove origin 2>$null | Out-Null
  git remote add origin $remote
  $ls = git ls-remote --heads origin 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) {
    Write-Host "  访问不了 $remote" -ForegroundColor Red
    Write-Host "  $($ls.Trim())" -ForegroundColor Red
    Write-Host ''
    Write-Host '  两种情况：' -ForegroundColor Yellow
    Write-Host "    a) 仓库还没建 —— https://github.com/new 建一个空的 $Repo" -ForegroundColor Yellow
    Write-Host '    b) 仓库名不对 —— 用 -Repo 参数指定正确的 owner/name' -ForegroundColor Yellow
    exit 1
  }
  Write-Host "  远端可访问: $remote" -ForegroundColor Green

  Write-Host ''
  Write-Host "=== 4. 推送 $Branch ===" -ForegroundColor Cyan
  git push -u origin $Branch 2>&1 | ForEach-Object { Write-Host "  $_" }
  if ($LASTEXITCODE -ne 0) {
    Write-Host ''
    Write-Host '  推送失败。如果提示 non-fast-forward，说明远端已有内容：' -ForegroundColor Yellow
    Write-Host '    git pull --rebase origin main' -ForegroundColor Yellow
    Write-Host '  如果提示 protected branch，去仓库 Settings 里看分支保护规则。' -ForegroundColor Yellow
    exit 1
  }

  Write-Host ''
  Write-Host "完成：https://github.com/$Repo" -ForegroundColor Green
} finally {
  Pop-Location
}
