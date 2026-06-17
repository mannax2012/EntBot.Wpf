param(
    [string]$Configuration = "Release",
    [string]$RuntimeIdentifier = "win-x64",
    [string]$NodePath = "",
    [string]$ReleaseBaseUrl = ""
)

$ErrorActionPreference = "Stop"

function Invoke-WithRetry {
    param(
        [scriptblock]$Action,
        [int]$Attempts = 10,
        [int]$DelaySeconds = 1
    )

    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        try {
            & $Action
            return
        }
        catch {
            if ($attempt -eq $Attempts) {
                throw
            }

            Start-Sleep -Seconds $DelaySeconds
        }
    }
}

$projectPath = Join-Path $PSScriptRoot "EntBot.Wpf.csproj"
$updaterProjectPath = Join-Path $PSScriptRoot "EntBot.Updater\EntBot.Updater.csproj"
$versionSourcePath = Join-Path $PSScriptRoot "version.json"
$updateSettingsSourcePath = Join-Path $PSScriptRoot "update-settings.json"
$publishRoot = Join-Path $PSScriptRoot "publish"
$runtimeRoot = Join-Path $publishRoot $RuntimeIdentifier
$mainPublishDir = Join-Path $runtimeRoot "_main"
$updaterPublishDir = Join-Path $runtimeRoot "_updater"
$appPublishDir = Join-Path $runtimeRoot "app"

$versionManifest = Get-Content $versionSourcePath -Raw | ConvertFrom-Json
$version = [string]$versionManifest.version
if ([string]::IsNullOrWhiteSpace($version)) {
    throw "version.json does not define a version."
}

if ([string]::IsNullOrWhiteSpace($ReleaseBaseUrl)) {
    $ReleaseBaseUrl = "https://github.com/mannax2012/EntBot.Wpf/releases/download/v$version"
}

$packageName = "EntBot-$RuntimeIdentifier-v$version.zip"
$packagePath = Join-Path $runtimeRoot $packageName
$releaseManifestPath = Join-Path $runtimeRoot "version.json"

if ([string]::IsNullOrWhiteSpace($NodePath)) {
    $nodeCommand = Get-Command node -ErrorAction Stop
    $NodePath = $nodeCommand.Source
}

if (-not (Test-Path -LiteralPath $NodePath)) {
    throw "Node executable not found: $NodePath"
}

if (Test-Path -LiteralPath $runtimeRoot) {
    Remove-Item -LiteralPath $runtimeRoot -Recurse -Force
}

New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null

dotnet publish $projectPath `
    -c $Configuration `
    -r $RuntimeIdentifier `
    --self-contained true `
    /p:PublishSingleFile=true `
    /p:IncludeNativeLibrariesForSelfExtract=true `
    /p:PublishTrimmed=false `
    /p:Version=$version `
    /p:FileVersion=$version `
    /p:AssemblyVersion=$version `
    /p:InformationalVersion=$version `
    -o $mainPublishDir

dotnet publish $updaterProjectPath `
    -c $Configuration `
    -r $RuntimeIdentifier `
    --self-contained true `
    /p:PublishSingleFile=true `
    /p:IncludeNativeLibrariesForSelfExtract=true `
    /p:PublishTrimmed=false `
    /p:Version=$version `
    /p:FileVersion=$version `
    /p:AssemblyVersion=$version `
    /p:InformationalVersion=$version `
    -o $updaterPublishDir

New-Item -ItemType Directory -Force -Path $appPublishDir | Out-Null
Copy-Item -Path (Join-Path $mainPublishDir "*") -Destination $appPublishDir -Recurse -Force

$bundledNodeDir = Join-Path $appPublishDir "runtime\node"
New-Item -ItemType Directory -Force -Path $bundledNodeDir | Out-Null
Copy-Item -LiteralPath $NodePath -Destination (Join-Path $bundledNodeDir "node.exe") -Force

$bundledUpdaterDir = Join-Path $appPublishDir "updater"
New-Item -ItemType Directory -Force -Path $bundledUpdaterDir | Out-Null
Copy-Item -Path (Join-Path $updaterPublishDir "*") -Destination $bundledUpdaterDir -Recurse -Force

Get-ChildItem -LiteralPath $appPublishDir -File -Filter "EntBot.Updater*" -ErrorAction SilentlyContinue |
    Remove-Item -Force -ErrorAction SilentlyContinue

$releaseManifest = [ordered]@{
    version = $version
    packageUrl = $ReleaseBaseUrl.TrimEnd('/') + '/' + $packageName
    sha256 = ""
    publishedAtUtc = [DateTime]::UtcNow.ToString("o")
    releaseNotes = if ($versionManifest.releaseNotes) { [string]$versionManifest.releaseNotes } else { "" }
}

$releaseManifestJson = $releaseManifest | ConvertTo-Json -Depth 8
Set-Content -LiteralPath (Join-Path $appPublishDir "version.json") -Value $releaseManifestJson -Encoding UTF8
Copy-Item -LiteralPath $updateSettingsSourcePath -Destination (Join-Path $appPublishDir "update-settings.json") -Force

Invoke-WithRetry -Action {
    if (Test-Path -LiteralPath $packagePath) {
        Remove-Item -LiteralPath $packagePath -Force
    }

    Compress-Archive -Path (Join-Path $appPublishDir "*") -DestinationPath $packagePath -Force
}

$packageHash = (Get-FileHash -LiteralPath $packagePath -Algorithm SHA256).Hash
$releaseManifest.sha256 = $packageHash
$releaseManifestJson = $releaseManifest | ConvertTo-Json -Depth 8

Set-Content -LiteralPath (Join-Path $appPublishDir "version.json") -Value $releaseManifestJson -Encoding UTF8
Set-Content -LiteralPath $releaseManifestPath -Value $releaseManifestJson -Encoding UTF8

Write-Host "Standalone publish completed:"
Write-Host "  App folder:      $appPublishDir"
Write-Host "  Package zip:     $packagePath"
Write-Host "  Manifest:        $releaseManifestPath"
Write-Host "  Release URL:     $($releaseManifest.packageUrl)"
Write-Host "  Bundled Node:    $(Join-Path $bundledNodeDir 'node.exe')"
Write-Host "  Bundled Updater: $(Join-Path $bundledUpdaterDir 'EntBot.Updater.exe')"
