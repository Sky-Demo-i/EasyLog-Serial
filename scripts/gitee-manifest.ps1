param(
  [Parameter(Mandatory = $true)][string]$Version,
  [Parameter(Mandatory = $true)][string]$GiteeUrl
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$latestPath = Join-Path $root "release\latest.json"
$targetDir = Join-Path $root "update"
$targetPath = Join-Path $targetDir "latest.json"

if ($GiteeUrl -notmatch '^https://gitee\.com/sky_demo_lu/EasyLog-Serial/') {
  throw "GiteeUrl 必须是当前 Gitee 仓库的发行版附件地址"
}
if (-not (Test-Path $latestPath)) {
  throw "缺少 release/latest.json，请先运行 scripts/release.ps1"
}

$latest = Get-Content $latestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($latest.version -ne $Version) {
  throw "release/latest.json 版本是 $($latest.version)，与 $Version 不一致"
}

$document = [ordered]@{
  version = $latest.version
  notes = $latest.notes
  pubDate = $latest.pubDate
  url = $GiteeUrl
  size = $latest.size
  sha256 = $latest.sha256
  mandatory = $false
}

New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
$json = $document | ConvertTo-Json -Depth 4 | Out-String
[IO.File]::WriteAllText($targetPath, $json, (New-Object Text.UTF8Encoding($false)))

Write-Host "Gitee 清单: $targetPath"
Write-Host "版本:       $($latest.version)"
Write-Host "URL:        $GiteeUrl"
Write-Host "SHA256:     $($latest.sha256)"
Write-Host ""
Write-Host "下一步：提交并推送 update/latest.json 到 Gitee 的 main 分支。"
