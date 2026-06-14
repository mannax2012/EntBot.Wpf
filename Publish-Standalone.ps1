param(
    [string]$Configuration = "Release",
    [string]$RuntimeIdentifier = "win-x64",
    [string]$NodePath = ""
)

$ErrorActionPreference = "Stop"

$projectPath = Join-Path $PSScriptRoot "EntBot.Wpf.csproj"
$publishRoot = Join-Path $PSScriptRoot "publish"
$publishDir = Join-Path $publishRoot $RuntimeIdentifier

if ([string]::IsNullOrWhiteSpace($NodePath)) {
    $nodeCommand = Get-Command node -ErrorAction Stop
    $NodePath = $nodeCommand.Source
}

if (-not (Test-Path -LiteralPath $NodePath)) {
    throw "Node executable not found: $NodePath"
}

dotnet publish $projectPath `
    -c $Configuration `
    -r $RuntimeIdentifier `
    --self-contained true `
    /p:PublishSingleFile=true `
    /p:IncludeNativeLibrariesForSelfExtract=true `
    /p:PublishTrimmed=false `
    -o $publishDir

$bundledNodeDir = Join-Path $publishDir "runtime\node"
New-Item -ItemType Directory -Force -Path $bundledNodeDir | Out-Null
Copy-Item -LiteralPath $NodePath -Destination (Join-Path $bundledNodeDir "node.exe") -Force

Write-Host "Standalone publish completed:"
Write-Host "  Publish folder: $publishDir"
Write-Host "  Bundled Node:   $(Join-Path $bundledNodeDir 'node.exe')"
