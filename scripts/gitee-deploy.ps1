$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$user = "sky_demo_lu"
$repoUrl = "https://gitee.com/sky_demo_lu/EasyLog-Serial.git"
$releasePage = "https://gitee.com/sky_demo_lu/EasyLog-Serial/releases/new"
$rawManifest = "https://gitee.com/sky_demo_lu/EasyLog-Serial/raw/main/update/latest.json"
$tokenFile = Join-Path $root "gitee-token.txt"
$zip = Join-Path $root "release\EasyLog-Serial-0.4.6-portable.zip"

try {
  Write-Host "========================================" -ForegroundColor Cyan
  Write-Host " EasyLog Serial - Gitee 发布" -ForegroundColor Cyan
  Write-Host "========================================" -ForegroundColor Cyan
  Write-Host ""

  if (-not (Test-Path $tokenFile)) {
    Set-Content -Path $tokenFile -Value "" -Encoding UTF8
    Start-Process notepad.exe $tokenFile
    Read-Host "已打开 gitee-token.txt，请粘贴令牌并保存，然后按 Enter"
  }

  $token = (Get-Content $tokenFile -Raw -Encoding UTF8).Trim()
  if ([string]::IsNullOrWhiteSpace($token) -or $token -match "PASTE|粘贴|令牌") {
    $token = (Read-Host "请输入 Gitee 私人令牌").Trim()
  }
  if ($token.Length -lt 20) {
    throw "令牌为空或长度不对。请在 gitee-token.txt 中只粘贴令牌本身。"
  }

  $encoded = [uri]::EscapeDataString($token)

  Write-Host "[1/4] 验证令牌..." -ForegroundColor Yellow
  try {
    $me = Invoke-RestMethod -Uri "https://gitee.com/api/v5/user?access_token=$encoded" -TimeoutSec 20
    Write-Host "      令牌账号: $($me.login)" -ForegroundColor Green
  } catch {
    Write-Host "      令牌验证未通过，仍尝试推送（部分令牌没有 user_info 权限）" -ForegroundColor DarkYellow
  }

  Write-Host "[2/4] 推送 main 和 tags 到 Gitee..." -ForegroundColor Yellow
  $oldRemote = $null
  try { $oldRemote = (git remote get-url gitee 2>$null) } catch { }
  if ($oldRemote) { git remote remove gitee | Out-Null }
  $pushUrl = "https://{0}:{1}@gitee.com/sky_demo_lu/EasyLog-Serial.git" -f $user, $encoded
  git remote add gitee $pushUrl
  git -c credential.helper= push -u gitee main --tags
  $pushCode = $LASTEXITCODE
  git remote set-url gitee $repoUrl

  if ($pushCode -ne 0) {
    throw @"
Gitee 推送失败，退出码 $pushCode。
常见原因：
  - 令牌没有 projects（仓库读写）权限
  - 令牌账号不是 sky_demo_lu，或没有该仓库权限
  - 令牌已过期
请重新生成私人令牌后，替换 gitee-token.txt 再执行。
"@
  }
  Write-Host "      Gitee 推送成功" -ForegroundColor Green

  Write-Host "[3/4] 检查 Gitee 清单..." -ForegroundColor Yellow
  $manifest = $null
  for ($i = 0; $i -lt 15; $i++) {
    try {
      $manifest = Invoke-RestMethod -Uri "$rawManifest?t=$([guid]::NewGuid())" -TimeoutSec 15
      break
    } catch {
      Start-Sleep -Seconds 2
    }
  }
  if (-not $manifest) {
    Write-Host "      推送成功，但 Gitee raw 清单暂时还读不到" -ForegroundColor DarkYellow
    Write-Host "      请稍后手动打开：$rawManifest" -ForegroundColor DarkYellow
  } else {
    Write-Host "      清单版本: $($manifest.version)" -ForegroundColor Green
    Write-Host "      下载地址: $($manifest.url)" -ForegroundColor DarkGray
    Write-Host "      SHA256:   $($manifest.sha256)" -ForegroundColor DarkGray
    $downloadCode = curl.exe -sS -o NUL -w "%{http_code}" -L --max-time 30 $manifest.url
    if ($downloadCode -eq "200") {
      Write-Host "      发行版附件: HTTP 200" -ForegroundColor Green
    } else {
      Write-Host "      发行版附件: HTTP $downloadCode（可能还没上传）" -ForegroundColor DarkYellow
    }
  }

  Write-Host "[4/4] 打开 Gitee 发行版页面..." -ForegroundColor Yellow
  if (Test-Path $zip) {
    Start-Process explorer.exe -ArgumentList "/select,`"$zip`""
  }
  Start-Process $releasePage
  Write-Host ""
  Write-Host "还需要在打开的网页里手动完成：" -ForegroundColor Cyan
  Write-Host "  1. 标签填 v0.4.6，目标分支 main"
  Write-Host "  2. 上传：$zip"
  Write-Host "  3. 点击发布"
  Write-Host ""
  Write-Host "发布完成后重新双击本脚本，会再次检查清单和下载地址。" -ForegroundColor Cyan
} catch {
  Write-Host ""
  Write-Host "执行失败：" -ForegroundColor Red
  Write-Host $_.Exception.Message -ForegroundColor Red
  exit 1
}
