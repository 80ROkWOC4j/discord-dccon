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

# All standalone installations use desktop_core. App archives and host-mod
# patchers are preserved; only the current core entry is wrapped.
function Get-DesktopCoreEntries([string]$VersionDirectory, [string]$DataRoot) {
    $name = Split-Path $VersionDirectory -Leaf
    foreach ($modules in @((Join-Path $VersionDirectory 'modules'), (Join-Path $DataRoot ($name + '/modules')), (Join-Path $DataRoot ($name.Substring(4) + '/modules')))) {
        if (!(Test-Path -LiteralPath $modules)) {continue}
        foreach ($module in Get-ChildItem -LiteralPath $modules -Directory | Where-Object {$_.Name -match '^discord_desktop_core(?:-\d+)?$'}) {
            foreach ($file in @((Join-Path $module.FullName 'index.js'), (Join-Path $module.FullName 'discord_desktop_core/index.js'))) {
                if (Test-Path -LiteralPath $file -PathType Leaf) {$file}
            }
        }
    }
}

function Test-VencordArchive([string]$Resources, [string]$Archive = '') {
    if (!(Test-Path -LiteralPath (Join-Path $Resources '_app.asar') -PathType Leaf)) {return $false}
    $patcher = Join-Path $env:APPDATA 'Vencord/dist/patcher.js'
    if (!$Archive) {$Archive = Join-Path $Resources 'app.asar'}
    if (!(Test-Path -LiteralPath $patcher -PathType Leaf) -or !(Test-Path -LiteralPath $archive -PathType Leaf)) {throw 'Incomplete Vencord installation. Repair Vencord first.'}
    # Official Vencord Installer writes require(JSON.stringify(patcherPath)) into this small ASAR.
    $text = [Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($archive))
    foreach ($match in [regex]::Matches($text, 'require\(("(?:\\.|[^"\\])*")\)')) {
        try {$target = ConvertFrom-Json -InputObject $match.Groups[1].Value} catch {continue}
        if ([IO.Path]::IsPathRooted($target) -and
            [IO.Path]::GetFullPath($target).Equals([IO.Path]::GetFullPath($patcher), [StringComparison]::OrdinalIgnoreCase)) {return $true}
    }
    throw 'Unknown app.asar loader beside _app.asar. Only the standard Vencord installer layout is supported.'
}

function Get-LegacyStandalone([string]$Resources) {
    $app = Join-Path $Resources 'app'
    $manifest = Join-Path $app 'discord-dccon-install.json'
    $original = Join-Path $Resources 'discord-dccon-original.asar'
    if (!(Test-Path -LiteralPath $manifest) -and !(Test-Path -LiteralPath $original)) {return $null}
    $asar = Join-Path $Resources 'app.asar'
    if (!(Test-Path -LiteralPath $manifest -PathType Leaf) -or !(Test-Path -LiteralPath $original -PathType Leaf) -or (Test-Path -LiteralPath $asar)) {
        throw 'Incomplete or conflicting legacy installation. No files were changed.'
    }
    $record = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
    $installedChannel = if ($record.channel) {$record.channel} else {'Stable'}
    if ($record.kind -ne 'discord-dccon-standalone' -or $installedChannel -ne $Channel -or
        (Get-FileHash -LiteralPath $original).Hash -ne $record.originalHash) {throw 'Legacy installation record or original archive changed. No files were changed.'}
    foreach ($file in @('index.js', 'package.json')) {
        if ((Get-FileHash -LiteralPath (Join-Path $app $file)).Hash -ne $record.$file) {throw "Modified legacy loader: $file. No files were changed."}
    }
    return @{app=$app;original=$original;asar=$asar;archive=(Join-Path $Resources ('discord-dccon-removed-' + [guid]::NewGuid().ToString('N')))}
}

function Remove-LegacyStandalone($Legacy) {
    Move-Item -LiteralPath $Legacy.app -Destination $Legacy.archive
    try {Move-Item -LiteralPath $Legacy.original -Destination $Legacy.asar}
    catch {Move-Item -LiteralPath $Legacy.archive -Destination $Legacy.app; throw}
}

function Undo-LegacyRemoval($Legacy) {
    Move-Item -LiteralPath $Legacy.asar -Destination $Legacy.original
    try {Move-Item -LiteralPath $Legacy.archive -Destination $Legacy.app}
    catch {Move-Item -LiteralPath $Legacy.original -Destination $Legacy.asar; throw}
}

function Get-CoreEntryState([string]$Index) {
    $installed = Join-Path (Split-Path $Index) 'discord-dccon'
    if (Test-Path -LiteralPath $installed) {
        $manifest = Join-Path $installed 'discord-dccon-install.json'
        if (!(Test-Path -LiteralPath $manifest)) {throw 'Unrecognized desktop_core addon. No files were changed.'}
        $record = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
        if ($record.kind -ne 'discord-dccon-core' -or [string]$record.hostMod -notin @('', 'vencord') -or $record.channel -ne $Channel) {throw 'Unexpected desktop_core installation record.'}
        if ((Get-FileHash -LiteralPath (Join-Path $installed 'original.js')).Hash -ne $record.originalHash) {throw 'Modified desktop_core backup. No files were changed.'}
        $current = (Get-FileHash -LiteralPath $Index).Hash
        if ($current -eq $record.loaderHash) {return @{state='addon';record=$record}}
        if ($current -eq $record.originalHash) {return @{state='original';record=$record}}
        throw 'Modified desktop_core loader. No files were changed.'
    }
    if (((Get-Content -LiteralPath $Index -Raw) -replace '\s', '') -match '^module\.exports=require\(["'']\./core\.asar["'']\);?$') {return @{state='original';record=$null}}
    return @{state='other';record=$null}
}

function Install-Standalone([string]$PackageDirectory, [string]$HostMod = '') {
    $root = [IO.Path]::GetFullPath($DiscordRoot)
    $version = Get-ChildItem -LiteralPath $root -Directory |
        Where-Object {$_.Name -match '^app-\d+(\.\d+)+$'} |
        Sort-Object {[version]($_.Name.Substring(4))} -Descending | Select-Object -First 1
    if (!$version) {throw "Discord $Channel installation not found at $root"}
    $legacy = Get-LegacyStandalone (Join-Path $version.FullName 'resources')
    if ($Remove -and $legacy) {
        Remove-LegacyStandalone $legacy
        Write-Output 'Legacy discord-dccon removed; original app archive restored. User data and removed loader were preserved.'
        return
    }
    if (!$Remove) {
        $metadata = Join-Path $PackageDirectory 'shelter-version.json'
        if (!(Test-Path -LiteralPath $metadata)) {throw "This release does not support standalone $Channel (desktop_core metadata is missing). Choose a newer release."}
        $packageInfo = Get-Content -LiteralPath $metadata -Raw | ConvertFrom-Json
        if ($packageInfo.installLayout -ne 'desktop_core') {throw 'This package does not use the desktop_core layout. Use a newer release.'}
        if ($Channel -notin @($packageInfo.channels)) {throw "This release does not support standalone $Channel. Choose a newer release."}
    }
    $entries = @(Get-DesktopCoreEntries $version.FullName $dataRoot | Select-Object -Unique)
    if ($entries.Count -ne 1) {throw 'Launch Discord once, then quit it. Expected exactly one current desktop_core entry.'}
    $index = $entries[0]; $core = Split-Path $index
    if (!(Test-Path -LiteralPath (Join-Path $core 'core.asar'))) {throw 'Discord desktop_core is incomplete.'}
    $installed = Join-Path $core 'discord-dccon'
    $entry = Get-CoreEntryState $index
    if ($entry.state -eq 'other') {throw 'Unknown desktop_core loader. No files were changed.'}
    $record = $entry.record
    if ($Remove -and !$record) {throw 'No discord-dccon installation in the current desktop_core.'}
    $temporary = Join-Path $core ('dccon-entry-' + [guid]::NewGuid().ToString('N') + '.tmp')
    if ($Remove) {
        $archive = Join-Path $core ('discord-dccon-removed-' + [guid]::NewGuid().ToString('N'))
        Move-Item -LiteralPath $installed -Destination $archive
        try {
            Copy-Item -LiteralPath (Join-Path $archive 'original.js') -Destination $temporary
            [IO.File]::Replace($temporary, $index, [System.Management.Automation.Language.NullString]::Value)
        } catch {Move-Item -LiteralPath $archive -Destination $installed; throw}
        finally {if (Test-Path -LiteralPath $temporary) {Remove-Item -LiteralPath $temporary}}
        Write-Output 'discord-dccon removed. The original desktop_core entry, host mods and user data were preserved.'
        return
    }
    $build = Join-Path $PackageDirectory 'runtime'
    $files = @('bootstrap.js', 'main.cjs', 'preload.cjs', 'native.js', 'shared-storage.cjs')
    foreach ($file in $files) {if (!(Test-Path -LiteralPath (Join-Path $build $file))) {throw "Package is missing runtime/$file"}}
    $stage = Join-Path $core ('discord-dccon-stage-' + [guid]::NewGuid().ToString('N'))
    $previous = $null; $activated = $false; $legacyRemoved = $false
    try {
        New-Item -ItemType Directory -Path (Join-Path $stage 'runtime') -Force | Out-Null
        foreach ($file in $files) {Copy-Item -LiteralPath (Join-Path $build $file) -Destination (Join-Path $stage "runtime/$file")}
        $runtimeConfig = @{channel=$Channel}
        if ($HostMod) {$runtimeConfig.hostMod = $HostMod}
        [IO.File]::WriteAllText((Join-Path $stage 'runtime/channel.json'), ($runtimeConfig | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
        $original = if ($record) {Join-Path $installed 'original.js'} else {$index}
        Copy-Item -LiteralPath $original -Destination (Join-Path $stage 'original.js')
        $entry = @'
// discord-dccon: preserve the app loader and the vendor desktop_core.
try { require('./discord-dccon/runtime/main.cjs'); }
catch (error) { console.error('[discord-dccon] Loader failed', error); }
module.exports = require('./core.asar');
'@
        [IO.File]::WriteAllText((Join-Path $stage 'index.js'), $entry, [Text.UTF8Encoding]::new($false))
        $saved = @{kind='discord-dccon-core';hostMod=$HostMod;channel=$Channel;originalHash=(Get-FileHash -LiteralPath (Join-Path $stage 'original.js')).Hash;loaderHash=(Get-FileHash -LiteralPath (Join-Path $stage 'index.js')).Hash}
        $saved | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stage 'discord-dccon-install.json') -Encoding utf8
        if ($legacy) {Remove-LegacyStandalone $legacy; $legacyRemoved = $true}
        if ($record) {
            $backup = Join-Path $core ('discord-dccon-previous-' + [guid]::NewGuid().ToString('N'))
            Move-Item -LiteralPath $installed -Destination $backup
            $previous = $backup
        }
        Move-Item -LiteralPath $stage -Destination $installed; $activated = $true
        Copy-Item -LiteralPath (Join-Path $installed 'index.js') -Destination $temporary
        [IO.File]::Replace($temporary, $index, [System.Management.Automation.Language.NullString]::Value)
    } catch {
        if ($activated) {Move-Item -LiteralPath $installed -Destination $stage}
        if ($previous) {Move-Item -LiteralPath $previous -Destination $installed}
        if ($legacyRemoved) {Undo-LegacyRemoval $legacy}
        throw
    } finally {
        if (Test-Path -LiteralPath $stage) {Remove-Item -LiteralPath $stage -Recurse -Force}
        if (Test-Path -LiteralPath $temporary) {Remove-Item -LiteralPath $temporary}
    }
    Write-Output "discord-dccon standalone installed for Discord $Channel (desktop_core). Start Discord normally. Host updates may require reinstalling discord-dccon."
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
    $legacy = Get-LegacyStandalone $resources
    if ($legacy) {
        # Validated above; cleanup happens only after the new package is verified and staged.
    } elseif (Test-Path -LiteralPath (Join-Path $resources 'app')) {
        if (!(Test-Path -LiteralPath $appEntry)) {throw 'Unknown Discord app loader.'}
        $entry = Get-Content -LiteralPath $appEntry -Raw
        if ($entry -notmatch 'betterdiscord\.asar' -or
            !(Test-Path -LiteralPath (Join-Path $resources 'betterdiscord.app.asar')) -or
            (Test-Path -LiteralPath (Join-Path $resources 'app.asar'))) {throw 'Unknown or inactive Discord app loader.'}
        $states += 'BetterDiscord'
    } elseif (!(Test-Path -LiteralPath (Join-Path $resources 'app.asar'))) {throw 'Discord app.asar is missing.'}
    $archive = if ($legacy) {$legacy.original} else {Join-Path $resources 'app.asar'}
    if (Test-VencordArchive $resources $archive) {$states += 'Vencord'}
    $hasStandalone = $false
    # Inspect only this host version, never a stale module left by an older Discord.
    foreach ($file in @(Get-DesktopCoreEntries $version.FullName $DataRoot | Select-Object -Unique)) {
        $entry = Get-CoreEntryState $file
        if ($entry.record) {$hasStandalone = $true}
        elseif ($entry.state -eq 'other') {
            $text = Get-Content -LiteralPath $file -Raw
            if ($text -match 'betterdiscord\.asar' -and $text -match 'core\.asar') {$states += 'BetterDiscord'}
            else {throw "Unknown core loader: $file"}
        }
    }
    if ($states.Count -gt 1 -or ($hasStandalone -and $legacy) -or (($hasStandalone -or $legacy) -and $states -contains 'BetterDiscord')) {throw 'Multiple client mod loaders detected. Resolve them before installing.'}
    if ($states -contains 'BetterDiscord') {
        if (!(Test-Path -LiteralPath (Join-Path $env:APPDATA 'BetterDiscord/data/betterdiscord.asar'))) {throw 'BetterDiscord injection exists but its runtime is missing. Repair BetterDiscord first.'}
        return 'BetterDiscord'
    }
    if ($states -contains 'Vencord') {return 'Vencord'}
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
$HostMod = if ($detected -eq 'Vencord') {'vencord'} else {''}
if ($HostMod) {$detected = 'Standalone'}
if ($Mode -ne 'Auto' -and $Mode -ne $detected) {throw "Detected $detected; requested $Mode. Existing loaders are not replaced."}
$Mode = $detected
Write-Host "Selected $Mode for Discord $Channel."
if ($Remove) {
    if ($Mode -eq 'BetterDiscord') {Install-BetterDiscord} else {Install-Standalone -HostMod $HostMod}
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
    if ($Mode -eq 'BetterDiscord') {Install-BetterDiscord $package} else {Install-Standalone $package $HostMod}
} finally {
    $resolved = [IO.Path]::GetFullPath($workspace)
    $prefix = $tempBase.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if ($resolved.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -and
        [IO.Path]::GetFileName($resolved) -match '^discord-dccon-install-[a-f0-9]{32}$') {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
