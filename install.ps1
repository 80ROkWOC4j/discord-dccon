# Online installer. Example:
# powershell -c "irm https://github.com/80ROkWOC4j/discord-dccon/releases/latest/download/install.ps1 | iex"
param(
    [ValidateSet('auto', 'betterdiscord', 'standalone')][string]$mode = 'auto',
    [string]$version,
    [Alias('restore')][switch]$remove,
    [ValidateSet('stable', 'ptb', 'canary')][string]$channel = 'stable',
    [string]$discordroot,
    [string]$pluginsdirectory = (Join-Path $env:APPDATA 'BetterDiscord/plugins')
)
$ErrorActionPreference = 'Stop'
function Install-BetterDiscord([string]$PackageDirectory) {
    if (!(Test-Path -LiteralPath $PluginsDirectory -PathType Container)) {throw 'BetterDiscord plugin directory not found. Install BetterDiscord first.'}
    $target = Join-Path $PluginsDirectory 'discord-dccon.plugin.js'
    if ($Remove) {
        if (!(Test-Path -LiteralPath $target)) {throw 'discord-dccon plugin is not installed.'}
        Move-Item -LiteralPath $target -Destination ($target + '.removed-' + [guid]::NewGuid().ToString('N'))
        Write-Output 'discord-dccon plugin removed. BetterDiscord, settings and cache were preserved.'
        return
    }
    $source = Join-Path $PackageDirectory 'discord-dccon.plugin.js'
    if (!(Test-Path -LiteralPath $source)) {throw 'Package is missing discord-dccon.plugin.js.'}
    if (Test-Path -LiteralPath $target) {
        if ((Get-FileHash -LiteralPath $source).Hash -eq (Get-FileHash -LiteralPath $target).Hash) {
            Write-Output 'This discord-dccon version is already installed.'
            return
        }
        Copy-Item -LiteralPath $target -Destination ($target + '.backup-' + [guid]::NewGuid().ToString('N'))
    }
    Copy-Item -LiteralPath $source -Destination $target
    if ((Get-FileHash -LiteralPath $source).Hash -ne (Get-FileHash -LiteralPath $target).Hash) {throw 'Installation verification failed'}
    Write-Output 'discord-dccon installed. Enable it in Discord Settings > BetterDiscord > Plugins. Existing settings and cache were preserved.'
}

function Install-Standalone([string]$PackageDirectory) {
    $root = [IO.Path]::GetFullPath($DiscordRoot)
    $version = Get-ChildItem -LiteralPath $root -Directory |
        Where-Object {$_.Name -match '^app-\d+(\.\d+)+$'} |
        Sort-Object {[version]($_.Name.Substring(4))} -Descending | Select-Object -First 1
    if (!$version) {throw "Discord $Channel installation not found at $root"}
    $resources = [IO.Path]::GetFullPath((Join-Path $version.FullName 'resources'))
    if (!$resources.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {throw 'Unexpected Discord path'}
    $app = Join-Path $resources 'app'
    $asar = Join-Path $resources 'app.asar'
    $original = Join-Path $resources 'discord-dccon-original.asar'
    $manifest = Join-Path $app 'discord-dccon-install.json'
    $record = if (Test-Path -LiteralPath $manifest) {Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json} else {$null}
    if ($record) {
        $installedChannel = if ($record.channel) {$record.channel} else {'Stable'}
        if ($installedChannel -ne $Channel) {throw "This installation uses -channel $installedChannel"}
        if ($record.kind -ne 'discord-dccon-standalone' -or !(Test-Path -LiteralPath $original) -or
            (Get-FileHash -LiteralPath $original).Hash -ne $record.originalHash) {throw 'Invalid discord-dccon installation or original archive changed'}
        foreach ($file in @('index.js', 'package.json')) {
            if ((Get-FileHash -LiteralPath (Join-Path $app $file)).Hash -ne $record.$file) {throw "Modified loader: $file"}
        }
    }
    if ($Remove) {
        if (!$record -or (Test-Path -LiteralPath $asar)) {throw 'No restorable standalone installation, or app.asar already exists'}
        # Keep the removed loader as a recoverable sibling; never delete user files.
        $archive = Join-Path $resources ('discord-dccon-removed-' + [guid]::NewGuid().ToString('N'))
        if (![IO.Path]::GetFullPath($archive).StartsWith($resources + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {throw 'Unexpected archive path'}
        Move-Item -LiteralPath $app -Destination $archive
        try {Move-Item -LiteralPath $original -Destination $asar}
        catch {Move-Item -LiteralPath $archive -Destination $app; throw}
        Write-Output 'discord-dccon removed; vanilla Discord restored. User data and removed loader were preserved.'
        return
    }
    $build = Join-Path $PackageDirectory 'runtime'
    if ($Channel -eq 'PTB') {
        $metadata = Join-Path $PackageDirectory 'shelter-version.json'
        if (!(Test-Path -LiteralPath $metadata) -or
            'PTB' -notin @((Get-Content -LiteralPath $metadata -Raw | ConvertFrom-Json).channels)) {
            throw 'This release does not support standalone PTB. Choose a newer release.'
        }
    }
    $files = @('bootstrap.js', 'main.cjs', 'preload.cjs', 'native.js')
    if (Test-Path -LiteralPath (Join-Path $build 'shared-storage.cjs')) {$files += 'shared-storage.cjs'}
    foreach ($file in $files) {if (!(Test-Path -LiteralPath (Join-Path $build $file))) {throw "Package is missing runtime/$file"}}
    if (!$record -and ((Test-Path -LiteralPath $app) -or (Test-Path -LiteralPath $original) -or !(Test-Path -LiteralPath $asar))) {
        throw 'This installer requires vanilla Discord. Existing mods are not replaced.'
    }
    $stage = Join-Path $resources ('discord-dccon-stage-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path (Join-Path $stage 'runtime') -Force | Out-Null
    foreach ($file in $files) {Copy-Item -LiteralPath (Join-Path $build $file) -Destination (Join-Path $stage "runtime/$file")}
    [IO.File]::WriteAllText((Join-Path $stage 'runtime/channel.json'), (@{channel=$Channel} | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
    $entry = @'
const path = require('node:path');
const electron = require('electron');
const original = path.resolve(__dirname, '../discord-dccon-original.asar');
const metadata = require(path.join(original, 'package.json'));
electron.app.setAppPath(original);
electron.app.name = metadata.name;
try { require('./runtime/main.cjs'); }
catch (error) { try { console.error('[discord-dccon] Loader failed', error); } catch (_) {} }
const entry = path.join(original, metadata.main);
require.main.filename = entry;
require('node:module')._load(entry, null, true);
'@
    [IO.File]::WriteAllText((Join-Path $stage 'index.js'), $entry)
    [IO.File]::WriteAllText((Join-Path $stage 'package.json'), '{"main":"index.js"}')
    $saved = @{kind='discord-dccon-standalone';channel=$Channel;originalHash=if ($record) {$record.originalHash} else {(Get-FileHash -LiteralPath $asar).Hash}}
    foreach ($file in @('index.js', 'package.json')) {$saved[$file] = (Get-FileHash -LiteralPath (Join-Path $stage $file)).Hash}
    $saved | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stage 'discord-dccon-install.json') -Encoding utf8
    if ($record) {
        $previous = Join-Path $resources ('discord-dccon-previous-' + [guid]::NewGuid().ToString('N'))
        Move-Item -LiteralPath $app -Destination $previous
        try {Move-Item -LiteralPath $stage -Destination $app}
        catch {Move-Item -LiteralPath $previous -Destination $app; throw}
    } else {
        Move-Item -LiteralPath $asar -Destination $original
        try {Move-Item -LiteralPath $stage -Destination $app}
        catch {Move-Item -LiteralPath $original -Destination $asar; throw}
    }
    Write-Output "discord-dccon standalone installed for Discord $Channel. Start Discord normally. Host updates may require running this installer again."
}

function Get-InstallationMode([string]$Root, [string]$DataRoot) {
    $version = Get-ChildItem -LiteralPath $Root -Directory |
        Where-Object {$_.Name -match '^app-\d+(\.\d+)+$'} |
        Sort-Object {[version]($_.Name.Substring(4))} -Descending | Select-Object -First 1
    if (!$version) {throw "Discord installation not found at $Root"}
    $resources = Join-Path $version.FullName 'resources'
    $settings = Join-Path $DataRoot 'settings.json'
    if (Test-Path -LiteralPath $settings) {
        $config = Get-Content -LiteralPath $settings -Raw | ConvertFrom-Json
        if ($config.UPDATE_ENDPOINT -or $config.NEW_UPDATE_ENDPOINT) {throw 'Custom Discord update endpoints detected. Remove the existing client mod first.'}
    }
    $states = @()
    $appEntry = Join-Path $resources 'app/index.js'
    $record = Join-Path $resources 'app/discord-dccon-install.json'
    if (Test-Path -LiteralPath $record) {
        if ((Get-Content -LiteralPath $record -Raw | ConvertFrom-Json).kind -ne 'discord-dccon-standalone') {throw 'Unknown installation record.'}
        $states += 'Standalone'
    } elseif (Test-Path -LiteralPath (Join-Path $resources 'app')) {
        if (!(Test-Path -LiteralPath $appEntry)) {throw 'Unknown Discord app loader.'}
        $entry = Get-Content -LiteralPath $appEntry -Raw
        if ($entry -notmatch 'betterdiscord\.asar' -or
            !(Test-Path -LiteralPath (Join-Path $resources 'betterdiscord.app.asar')) -or
            (Test-Path -LiteralPath (Join-Path $resources 'app.asar'))) {throw 'Unknown or inactive Discord app loader.'}
        $states += 'BetterDiscord'
    } elseif (!(Test-Path -LiteralPath (Join-Path $resources 'app.asar'))) {throw 'Discord app.asar is missing.'}
    # Inspect only this host version, never a stale module left by an older Discord.
    $moduleRoots = @((Join-Path $version.FullName 'modules'),
        (Join-Path $DataRoot ($version.Name + '/modules')),
        (Join-Path $DataRoot ($version.Name.Substring(4) + '/modules')))
    foreach ($modules in $moduleRoots) {
        if (!(Test-Path -LiteralPath $modules)) {continue}
        foreach ($module in Get-ChildItem -LiteralPath $modules -Directory | Where-Object {$_.Name -match '^discord_desktop_core(?:-\d+)?$'}) {
            $entries = @((Join-Path $module.FullName 'index.js'), (Join-Path $module.FullName 'discord_desktop_core/index.js')) |
                Where-Object {Test-Path -LiteralPath $_}
            foreach ($file in $entries) {
                $entry = Get-Content -LiteralPath $file -Raw
                if (($entry -replace '\s', '') -match '^module\.exports=require\(["'']\./core\.asar["'']\);?$') {continue}
                if ($entry -match 'betterdiscord\.asar' -and $entry -match 'core\.asar') {$states += 'BetterDiscord'}
                else {throw "Unknown core loader: $file"}
            }
        }
    }
    if ($states.Count -gt 1) {throw 'Multiple client mod loaders detected. Resolve them before installing.'}
    if ($states -contains 'BetterDiscord') {
        if (!(Test-Path -LiteralPath (Join-Path $env:APPDATA 'BetterDiscord/data/betterdiscord.asar'))) {throw 'BetterDiscord injection exists but its runtime is missing. Repair BetterDiscord first.'}
        return 'BetterDiscord'
    }
    return 'Standalone'
}
$Mode = switch ($Mode) { 'betterdiscord' {'BetterDiscord'} 'standalone' {'Standalone'} default {'Auto'} }
$Channel = switch ($Channel) { 'PTB' {'PTB'} 'Canary' {'Canary'} default {'Stable'} }
$client = switch ($Channel) { 'PTB' {'DiscordPTB'} 'Canary' {'DiscordCanary'} default {'Discord'} }
if (!$DiscordRoot) {$DiscordRoot = Join-Path $env:LOCALAPPDATA $client}
$DiscordRoot = [IO.Path]::GetFullPath($DiscordRoot)
if (Get-Process -Name Discord,DiscordPTB,DiscordCanary -ErrorAction SilentlyContinue | Where-Object { $_.Path -and [IO.Path]::GetFullPath($_.Path).StartsWith($DiscordRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) }) {
    throw "Fully quit Discord $Channel first."
}
$dataRoot = Join-Path $env:APPDATA $client.ToLowerInvariant()
$detected = Get-InstallationMode $DiscordRoot $dataRoot
if ($Mode -ne 'Auto' -and $Mode -ne $detected) {throw "Detected $detected; requested $Mode. Existing loaders are not replaced."}
$Mode = $detected
Write-Host "Selected $Mode for Discord $Channel."
if ($Remove) {
    if ($Mode -eq 'BetterDiscord') {Install-BetterDiscord} else {Install-Standalone}
    return
}
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$repository = '80ROkWOC4j/discord-dccon'
$releaseUrl = "https://api.github.com/repos/$repository/releases/latest"
if ($Version) {$releaseUrl = "https://api.github.com/repos/$repository/releases/tags/$([uri]::EscapeDataString($Version))"}
$headers = @{'User-Agent'='discord-dccon-Installer';'Accept'='application/vnd.github+json'}
try {$release = Invoke-RestMethod -Uri $releaseUrl -Headers $headers}
catch {throw "Could not find a published discord-dccon release. No installation was changed. $($_.Exception.Message)"}
$assetName = 'discord-dccon-' + $Mode.ToLowerInvariant() + '.zip'
$archiveAsset = @($release.assets | Where-Object {$_.name -eq $assetName})
$checksumAsset = @($release.assets | Where-Object {$_.name -eq 'checksums.json'})
if ($archiveAsset.Count -ne 1 -or $checksumAsset.Count -ne 1) {throw "Release $($release.tag_name) is missing $assetName or checksums.json. No installation was changed."}
$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$workspace = Join-Path $tempBase ('discord-dccon-install-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $workspace | Out-Null
try {
    Write-Host "Downloading discord-dccon $($release.tag_name) ($Mode)..."
    $archive = Join-Path $workspace $assetName
    $checksumPath = Join-Path $workspace 'checksums.json'
    foreach ($download in @(@($archiveAsset[0], $archive), @($checksumAsset[0], $checksumPath))) {
        $url = [uri]$download[0].browser_download_url
        if ($url.Scheme -ne 'https' -or $url.Host -ne 'github.com' -or !$url.AbsolutePath.StartsWith("/$repository/releases/download/")) {
            throw 'Unexpected release asset URL.'
        }
        Invoke-WebRequest -UseBasicParsing -Uri $url.AbsoluteUri -Headers @{'User-Agent'='discord-dccon-Installer'} -OutFile $download[1]
    }
    $checksums = Get-Content -LiteralPath $checksumPath -Raw | ConvertFrom-Json
    $expected = $checksums.$assetName
    if ($expected -notmatch '^[a-fA-F0-9]{64}$' -or (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $expected) {
        throw 'Downloaded package checksum mismatch. No installation was changed.'
    }
    $package = Join-Path $workspace 'package'
    Expand-Archive -LiteralPath $archive -DestinationPath $package
    if ($Mode -eq 'BetterDiscord') {Install-BetterDiscord $package} else {Install-Standalone $package}
} finally {
    $resolved = [IO.Path]::GetFullPath($workspace)
    $prefix = $tempBase.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if ($resolved.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -and
        [IO.Path]::GetFileName($resolved) -match '^discord-dccon-install-[a-f0-9]{32}$') {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
