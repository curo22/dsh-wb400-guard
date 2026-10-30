# dsh-wb400-guard 一键诊断
Write-Host "=== 1. 插件是否安装 ===" -ForegroundColor Cyan
$prof = "$env:USERPROFILE\.dsh\profiles\desktop"
if (Test-Path "$prof\vendor\dsh-wb400-guard\lib\index.js") { Write-Host "  vendor 存在 OK" -ForegroundColor Green } else { Write-Host "  vendor 缺失！" -ForegroundColor Red }
$pkg = Get-Content "$prof\package.json" -Raw | ConvertFrom-Json
if ($pkg.dependencies.'dsh-wb400-guard') { Write-Host "  dependency = $($pkg.dependencies.'dsh-wb400-guard')" -ForegroundColor Green } else { Write-Host "  package.json 无 dsh-wb400-guard 依赖！" -ForegroundColor Red }
if ($pkg.'dsh.profile.bundles' -contains 'dsh-wb400-guard') { Write-Host "  bundles 已挂载 OK" -ForegroundColor Green } else { Write-Host "  bundles 未挂载！" -ForegroundColor Red }

Write-Host "`n=== 2. guard 日志（最近 8 条）===" -ForegroundColor Cyan
$log = "$env:USERPROFILE\.dsh\logs\dsh-wb400-guard.jsonl"
if (Test-Path $log) { Get-Content $log -Tail 8 } else { Write-Host "  日志不存在 → guard 从未运行（没重启 DSH 或没加载）" -ForegroundColor Red }

Write-Host "`n=== 3. dsh-workbuddy-connect 版本 ===" -ForegroundColor Cyan
$conn = Get-Content "$prof\node_modules\dsh-workbuddy-connect\package.json" -Raw | ConvertFrom-Json
Write-Host "  dsh-workbuddy-connect = $($conn.version)"
Write-Host "  （guard 针对 0.7.6 定位；若 >=0.7.7 官方可能已改结构，需反馈）"

Write-Host "`n=== 4. kernel 版本 ===" -ForegroundColor Cyan
dsh --version