param([switch]$SkipPrepare, [switch]$Repackage)
$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path -Parent $PSScriptRoot
$payloadDirectory = Join-Path $projectDirectory 'build\portable\staging'
$outputDirectory = Join-Path $projectDirectory 'dist'
Push-Location $projectDirectory
try {
    if (-not $SkipPrepare -and -not $Repackage) {
        & node (Join-Path $PSScriptRoot 'prepare.mjs')
        if ($LASTEXITCODE -ne 0) { throw '准备运行依赖失败。' }
    }
    if (-not (Test-Path -LiteralPath (Join-Path $payloadDirectory 'runtime\node.exe'))) { throw '未找到打包后的 Node.js。' }
    if (-not (Test-Path -LiteralPath (Join-Path $payloadDirectory 'browser\chrome-win64\chrome.exe'))) { throw '未找到打包后的浏览器。' }
    $env:ELECTRON_CACHE = Join-Path $projectDirectory 'build\electron-cache'
    $env:ELECTRON_BUILDER_CACHE = Join-Path $projectDirectory 'build\electron-builder-cache'
    $env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
    $env:ELECTRON_BUILDER_COMPRESSION_LEVEL = '3'
    Write-Output '正在打包 Electron 窗口和无头采集运行环境……'
    $builderArguments = @('--config', 'packaging/electron-builder.cjs', '--win', 'portable', '--x64', '--publish', 'never')
    if ($Repackage) { $builderArguments += @('--prepackaged', 'build/electron-release/win-unpacked') }
    & node (Join-Path $projectDirectory 'node_modules\electron-builder\cli.js') @builderArguments
    if ($LASTEXITCODE -ne 0) { throw '打包 Electron EXE 失败。' }
    New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $projectDirectory 'build\electron-release\XinlePriceDashboard-Electron.exe') -Destination $outputDirectory -Force
    $executable = Join-Path $outputDirectory 'XinlePriceDashboard-Electron.exe'
    if (-not (Test-Path -LiteralPath $executable)) { throw '未生成目标 EXE。' }
    $hash = (Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash.ToLowerInvariant()
    [System.IO.File]::WriteAllText((Join-Path $outputDirectory 'XinlePriceDashboard-Electron.sha256'), "$hash  XinlePriceDashboard-Electron.exe`n", [System.Text.Encoding]::ASCII)
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'WINDOWS-EXE.md') -Destination (Join-Path $outputDirectory '使用说明.md') -Force
    $size = [Math]::Round((Get-Item -LiteralPath $executable).Length / 1MB, 1)
    Write-Output "已生成：$executable ($size MiB)"
} finally {
    Pop-Location
}
