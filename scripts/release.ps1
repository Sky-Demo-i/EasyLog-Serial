param(
  [Parameter(Mandatory = $true)][string]$Version,
  [string]$Notes = "",
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if ($Version -notmatch '^\d+\.\d+\.\d+$') {
  throw "版本号必须形如 0.4.0"
}

$pkg = "$root\release\EasyLog-Serial-$Version-portable"
$zip = "$root\release\EasyLog-Serial-$Version-portable.zip"
$manifest = "$root\release\latest.json"
$pnpm = "C:\Users\luyan\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs"
$cargoPath = "$env:USERPROFILE\.cargo\bin;$env:USERPROFILE\tools\w64devkit\bin"
$env:PATH = "$cargoPath;$env:PATH"

if (-not $SkipBuild) {
  Write-Host "==> 构建前端"
  node $pnpm build
  if ($LASTEXITCODE -ne 0) { throw "前端构建失败" }

  Write-Host "==> 构建主程序"
  Push-Location "$root\src-tauri"
  try {
    cargo build --release --features custom-protocol
    if ($LASTEXITCODE -ne 0) { throw "主程序构建失败" }
  } finally {
    Pop-Location
  }

  Write-Host "==> 构建 updater helper"
  Push-Location "$root\src-tauri\updater"
  try {
    cargo build --release
    if ($LASTEXITCODE -ne 0) { throw "updater 构建失败" }
  } finally {
    Pop-Location
  }
}

if (-not (Test-Path "$root\src-tauri\target\release\easylog-serial.exe")) {
  throw "缺少主程序产物"
}
if (-not (Test-Path "$root\src-tauri\updater\target\release\EasyLogSerialUpdater.exe")) {
  throw "缺少 EasyLogSerialUpdater.exe"
}

Write-Host "==> 组装便携包"
if (Test-Path $pkg) { Remove-Item $pkg -Recurse -Force }
New-Item -ItemType Directory -Force -Path $pkg | Out-Null
Copy-Item "$root\src-tauri\target\release\easylog-serial.exe" "$pkg\EasyLogSerial.exe" -Force
Copy-Item "$root\src-tauri\target\release\WebView2Loader.dll" "$pkg\WebView2Loader.dll" -Force
Copy-Item "$root\src-tauri\updater\target\release\EasyLogSerialUpdater.exe" "$pkg\EasyLogSerialUpdater.exe" -Force

$usage = @"
EasyLog Serial $Version — 免安装绿色版
======================================
作者：lyg
标题：EasyLog Serial — 串口工作台 · lyg · v$Version

$Notes

自动更新：
  - 程序通过 GitHub Releases 检查更新
  - 下载校验通过后自动退出、替换文件并重启
  - 配置和 logs 目录保留

文件：
  EasyLogSerial.exe          主程序
  EasyLogSerialUpdater.exe   更新替换器
  WebView2Loader.dll         WebView2 依赖
"@
[IO.File]::WriteAllText("$pkg\使用说明.txt", $usage, [Text.UTF8Encoding]::new($true))
if (Test-Path "$pkg\logs") { Remove-Item "$pkg\logs" -Recurse -Force }

if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path "$pkg\*" -DestinationPath $zip -Force

$hash = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLowerInvariant()
$size = (Get-Item $zip).Length
$url = "https://github.com/Sky-Demo-i/EasyLog-Serial/releases/download/v$Version/EasyLog-Serial-$Version-portable.zip"
$document = [ordered]@{
  version = $Version
  notes = $Notes
  pubDate = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  url = $url
  size = $size
  sha256 = $hash
  mandatory = $false
}
$document | ConvertTo-Json -Depth 4 | Out-String | ForEach-Object { [IO.File]::WriteAllText($manifest, $_, (New-Object Text.UTF8Encoding($false))) }

Write-Host ""
Write-Host "便携包: $zip"
Write-Host "SHA256: $hash"
Write-Host "大小:   $size"
Write-Host "清单:   $manifest"
Write-Host ""
Write-Host "下一步：创建 GitHub Release v$Version，并上传以下两个文件："
Write-Host "  - $zip"
Write-Host "  - $manifest"
Write-Host ""
Write-Host "如果安装并登录了 GitHub CLI："
Write-Host "  gh release create v$Version `"$zip`" `"$manifest`" --title `"v$Version`" --notes `"$Notes`""
