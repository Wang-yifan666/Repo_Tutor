# git_push.ps1
# 用法: .\script\git_push.ps1 "提交信息"

param(
    [string]$Message
)

# 获取脚本所在目录，并切换到项目根目录（上一级）
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
Set-Location $ProjectRoot

# 检查是否提供了提交信息
if (-not $Message) {
    Write-Host "错误: 请提供提交信息" -ForegroundColor Red
    Write-Host "用法: .\script\git_push.ps1 `"提交信息`"" -ForegroundColor Yellow
    exit 1
}

# 执行 Git 操作
git add .
git commit -m "$Message"
git push