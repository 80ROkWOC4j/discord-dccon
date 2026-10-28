# Online installer. Example:
# powershell -c "irm https://github.com/80ROkWOC4j/discord-dccon/releases/latest/download/install.ps1 | iex"
param(
    [ValidateSet('auto', 'betterdiscord', 'standalone')][string]$mode = 'auto',
    [string]$version,
    [Alias('restore')][switch]$remove,
    [switch]$purge,
    [switch]$dryrun,
    [switch]$yes,
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

function Get-LegacyStandalone([string]$Resources, [string]$Prefix = 'discord-dccon') {
    $app = Join-Path $Resources 'app'
    $manifest = Join-Path $app ($Prefix + '-install.json')
    $original = Join-Path $Resources ($Prefix + '-original.asar')
    if (!(Test-Path -LiteralPath $manifest) -and !(Test-Path -LiteralPath $original)) {return $null}
    $asar = Join-Path $Resources 'app.asar'
    if (!(Test-Path -LiteralPath $manifest -PathType Leaf) -or !(Test-Path -LiteralPath $original -PathType Leaf) -or (Test-Path -LiteralPath $asar)) {
        throw 'Incomplete or conflicting legacy installation. No files were changed.'
    }
    $record = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
    $installedChannel = if ($record.channel) {$record.channel} else {'Stable'}
    if ($record.kind -ne ($Prefix + '-standalone') -or $installedChannel -ne $Channel -or
        (Get-FileHash -LiteralPath $original).Hash -ne $record.originalHash) {throw 'Legacy installation record or original archive changed. No files were changed.'}
    foreach ($file in @('index.js', 'package.json')) {
        if ((Get-FileHash -LiteralPath (Join-Path $app $file)).Hash -ne $record.$file) {throw "Modified legacy loader: $file. No files were changed."}
    }
    return @{app=$app;original=$original;asar=$asar;archive=(Join-Path $Resources ('discord-dccon-removed-' + [guid]::NewGuid().ToString('N')))}
}

function Remove-CoreAddon([string]$Index) {
    $core = Split-Path $Index
    $installed = Join-Path $core 'discord-dccon'
    $temporary = Join-Path $core ('dccon-entry-' + [guid]::NewGuid().ToString('N') + '.tmp')
    $archive = Join-Path $core ('discord-dccon-removed-' + [guid]::NewGuid().ToString('N'))
    Assert-PurgePath $archive $core
    Move-Item -LiteralPath $installed -Destination $archive
    try {
        Copy-Item -LiteralPath (Join-Path $archive 'original.js') -Destination $temporary
        [IO.File]::Replace($temporary, $Index, [System.Management.Automation.Language.NullString]::Value)
    } catch {Move-Item -LiteralPath $archive -Destination $installed; throw}
    finally {if (Test-Path -LiteralPath $temporary) {Remove-Item -LiteralPath $temporary}}
    return $archive
}

function Remove-LegacyStandalone($Legacy) {
    Assert-PurgePath $Legacy.archive (Split-Path $Legacy.app)
    Move-Item -LiteralPath $Legacy.app -Destination $Legacy.archive
    try {Move-Item -LiteralPath $Legacy.original -Destination $Legacy.asar}
    catch {Move-Item -LiteralPath $Legacy.archive -Destination $Legacy.app; throw}
}

function Undo-LegacyRemoval($Legacy) {
    Move-Item -LiteralPath $Legacy.asar -Destination $Legacy.original
    try {Move-Item -LiteralPath $Legacy.archive -Destination $Legacy.app}
    catch {Move-Item -LiteralPath $Legacy.original -Destination $Legacy.asar; throw}
}

function Test-ShelterCore([string]$Index) {
    $core = Split-Path $Index
    $installed = Join-Path $core 'discord-dccon'
    if (Test-Path -LiteralPath $installed) {$Index = Join-Path $installed 'original.js'}
    $preload = Join-Path $core 'preload.js'
    if (!(Test-Path -LiteralPath $preload) -or !(Test-Path -LiteralPath (Join-Path $core 'branches.json'))) {return $false}
    $text = Get-Content -LiteralPath $Index -Raw
    return $text.Contains('SHELTUPDATE_FRAMEWORK_ORIGINAL_PRELOAD') -and $text.Contains('SHELTER_BUNDLE_FETCH') -and
        (Get-Content -LiteralPath $preload -Raw).Contains('SHELTER_BUNDLE_FETCH')
}

function Get-CoreEntryState([string]$Index) {
    $installed = Join-Path (Split-Path $Index) 'discord-dccon'
    if (Test-Path -LiteralPath $installed) {
        $manifest = Join-Path $installed 'discord-dccon-install.json'
        if (!(Test-Path -LiteralPath $manifest)) {throw 'Unrecognized desktop_core addon. No files were changed.'}
        $record = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
        if ($record.kind -ne 'discord-dccon-core' -or [string]$record.hostMod -notin @('', 'vencord', 'shelter') -or $record.channel -ne $Channel) {throw 'Unexpected desktop_core installation record.'}
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
        if ($HostMod -eq 'shelter' -and 'shelter' -notin @($packageInfo.hostMods)) {throw 'This release does not support Shelter coexistence. Choose a newer release.'}
    }
    $entries = @(Get-DesktopCoreEntries $version.FullName $dataRoot | Select-Object -Unique)
    if ($entries.Count -ne 1) {throw 'Launch Discord once, then quit it. Expected exactly one current desktop_core entry.'}
    $index = $entries[0]; $core = Split-Path $index
    if (!(Test-Path -LiteralPath (Join-Path $core 'core.asar'))) {throw 'Discord desktop_core is incomplete.'}
    $installed = Join-Path $core 'discord-dccon'
    $entry = Get-CoreEntryState $index
    if ($HostMod -eq 'shelter') {
        if (!(Test-ShelterCore $index)) {throw 'Expected the standard sheltupdate Shelter installation.'}
    } elseif ($entry.state -eq 'other') {throw 'Unknown desktop_core loader. No files were changed.'}
    $record = $entry.record
    if ($Remove -and !$record) {throw 'No discord-dccon installation in the current desktop_core.'}
    $temporary = Join-Path $core ('dccon-entry-' + [guid]::NewGuid().ToString('N') + '.tmp')
    if ($Remove) {
        $null = Remove-CoreAddon $index
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
        if ($HostMod -eq 'shelter') {
            # Execute the original source in its original directory, preserving relative paths.
            $entry = $entry.Replace("module.exports = require('./core.asar');", [IO.File]::ReadAllText($original))
        }
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
    if ($HostMod -eq 'shelter') {
        Write-Output "discord-dccon installed in existing Shelter for Discord $Channel. Start Discord normally. Host updates may require reinstalling discord-dccon."
    } else {
        Write-Output "discord-dccon standalone installed for Discord $Channel (desktop_core). Start Discord normally. Host updates may require reinstalling discord-dccon."
    }
}
function Get-InstallationMode([string]$Root, [string]$DataRoot) {
    $version = Get-ChildItem -LiteralPath $Root -Directory |
        Where-Object {$_.Name -match '^app-\d+(\.\d+)+$'} |
        Sort-Object {[version]($_.Name.Substring(4))} -Descending | Select-Object -First 1
    if (!$version) {throw "Discord installation not found at $Root"}
    $resources = Join-Path $version.FullName 'resources'
    $settings = Join-Path $DataRoot 'settings.json'
    $shelter = $false; $shelterCore = $false
    if (Test-Path -LiteralPath $settings) {
        $config = Get-Content -LiteralPath $settings -Raw | ConvertFrom-Json
        foreach ($endpoint in @($config.UPDATE_ENDPOINT, $config.NEW_UPDATE_ENDPOINT)) {
            if ($endpoint) {
                if ($endpoint -cnotmatch '^https://inject\.shelter\.uwu\.network/shelter/?$') {throw 'Custom Discord update endpoints detected. Remove the existing client mod first.'}
                $shelter = $true
            }
        }
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
        if ($shelter -and (Test-ShelterCore $file)) {$shelterCore = $true}
        if ($entry.record) {$hasStandalone = $true}
        elseif ($entry.state -eq 'other') {
            $text = Get-Content -LiteralPath $file -Raw
            if ($shelter -and $shelterCore) { }
            elseif ($text -match 'betterdiscord\.asar' -and $text -match 'core\.asar') {$states += 'BetterDiscord'}
            else {throw "Unknown core loader: $file"}
        }
    }
    if ($shelter) {
        if (!$shelterCore) {throw 'Incomplete Shelter installation. Repair sheltupdate first.'}
        $states += 'Shelter'
    }
    if ($states.Count -gt 1 -or ($hasStandalone -and $legacy) -or (($hasStandalone -or $legacy) -and $states -contains 'BetterDiscord')) {throw 'Multiple client mod loaders detected. Resolve them before installing.'}
    if ($states -contains 'BetterDiscord') {
        if (!(Test-Path -LiteralPath (Join-Path $env:APPDATA 'BetterDiscord/data/betterdiscord.asar'))) {throw 'BetterDiscord injection exists but its runtime is missing. Repair BetterDiscord first.'}
        return 'BetterDiscord'
    }
    if ($states -contains 'Vencord') {return 'Vencord'}
    if ($states -contains 'Shelter') {return 'Shelter'}
    return 'Standalone'
}
# Purge only named application-owned paths. Never follow junctions/symlinks,
# including ancestors of a candidate, into another installation or profile.
function Assert-PurgePath([string]$Path, [string]$Root) {
    $full = [IO.Path]::GetFullPath($Path)
    $prefix = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    if (!$full.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {throw "Purge path escapes its root: $full"}
    $ancestor = $full
    while ($ancestor) {
        if (Test-Path -LiteralPath $ancestor) {
            if ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {throw "Linked path requires manual cleanup: $ancestor"}
        }
        $ancestor = [IO.Path]::GetDirectoryName($ancestor)
    }
}
function Assert-PurgeTree([string]$Path, [string]$Root) {
    Assert-PurgePath $Path $Root
    if ((Get-Item -LiteralPath $Path -Force).PSIsContainer) {
        foreach ($child in Get-ChildItem -LiteralPath $Path -Force) {Assert-PurgeTree $child.FullName $Root}
    }
}
function Invoke-Purge {
    $deletions = [Collections.Generic.List[object]]::new()
    $restores = [Collections.Generic.List[object]]::new()
    $failures = [Collections.Generic.List[string]]::new()
    function Add-PurgeTarget([string]$Path, [string]$Root) {
        Assert-PurgePath $Path $Root
        if (!(Test-Path -LiteralPath $Path)) {return}
        Assert-PurgeTree $Path $Root
        if (!($deletions | Where-Object {$_.path -eq $Path})) {$deletions.Add(@{path=$Path;root=$Root})}
    }
    function Add-PurgeArchives([string]$Parent, [string]$Root) {
        if (!(Test-Path -LiteralPath $Parent)) {return}
        Assert-PurgePath $Parent $Root
        foreach ($item in Get-ChildItem -LiteralPath $Parent -Force) {
            if ($item.Name -notmatch '^(?:discord-dccon|dccon)-(?:previous|removed|stage)-[a-f0-9]{32}$') {continue}
            Assert-PurgeTree $item.FullName $Root
            $manifest = @('discord-dccon-install.json', 'dccon-install.json') | ForEach-Object {Join-Path $item.FullName $_} | Where-Object {Test-Path -LiteralPath $_}
            if (@($manifest).Count -ne 1) {throw "Unrecognized runtime archive: $($item.FullName)"}
            $record = Get-Content -LiteralPath @($manifest)[0] -Raw | ConvertFrom-Json
            if ($record.kind -notin @('discord-dccon-core', 'discord-dccon-standalone', 'dccon-standalone')) {throw "Unrecognized runtime archive: $($item.FullName)"}
            $hashes = if ($record.kind -eq 'discord-dccon-core') {@{'original.js'=$record.originalHash;'index.js'=$record.loaderHash}} else {@{'index.js'=$record.'index.js';'package.json'=$record.'package.json'}}
            foreach ($name in $hashes.Keys) {
                if ($hashes[$name] -notmatch '^[a-fA-F0-9]{64}$' -or (Get-FileHash -LiteralPath (Join-Path $item.FullName $name)).Hash -ne $hashes[$name]) {throw "Modified runtime archive: $($item.FullName)"}
            }
            Add-PurgeTarget $item.FullName $Root
        }
    }
    foreach ($client in @('Discord', 'DiscordPTB', 'DiscordCanary')) {
        $Channel = switch ($client) {'DiscordPTB' {'PTB'} 'DiscordCanary' {'Canary'} default {'Stable'}}
        $root = Join-Path $env:LOCALAPPDATA $client
        $dataRoot = Join-Path $env:APPDATA $client.ToLowerInvariant()
        foreach ($base in @($root, $dataRoot)) {
            try {
                Assert-PurgePath $base (Split-Path $base)
                if (!(Test-Path -LiteralPath $base)) {continue}
                foreach ($folder in Get-ChildItem -LiteralPath $base -Directory) {
                    if ($folder.Name -notmatch '^(?:app-)?\d+(\.\d+)+$') {continue}
                    Assert-PurgePath $folder.FullName $base
                    $resources = Join-Path $folder.FullName 'resources'
                    if ($base -eq $root -and (Test-Path -LiteralPath $resources)) {
                        Assert-PurgePath $resources $base
                        foreach ($prefix in @('discord-dccon', 'dccon')) {
                            $app = Join-Path $resources 'app'
                            if ((Test-Path -LiteralPath (Join-Path $app ($prefix + '-install.json'))) -or (Test-Path -LiteralPath (Join-Path $resources ($prefix + '-original.asar')))) {
                                Assert-PurgeTree $app $base
                                Assert-PurgePath (Join-Path $resources ($prefix + '-original.asar')) $base
                                $legacy = Get-LegacyStandalone $resources $prefix
                                $restores.Add(@{kind='legacy';path=$app;root=$base;channel=$Channel;resources=$resources;prefix=$prefix;legacy=$legacy})
                            }
                        }
                        Add-PurgeArchives $resources $base
                    }
                    $modules = Join-Path $folder.FullName 'modules'
                    Assert-PurgePath $modules $base
                    if (!(Test-Path -LiteralPath $modules)) {continue}
                    foreach ($module in Get-ChildItem -LiteralPath $modules -Directory) {
                        if ($module.Name -notmatch '^discord_desktop_core(?:-\d+)?$') {continue}
                        foreach ($core in @($module.FullName, (Join-Path $module.FullName 'discord_desktop_core'))) {
                            Assert-PurgePath $core $base
                            $addon = Join-Path $core 'discord-dccon'
                            $index = Join-Path $core 'index.js'
                            Assert-PurgePath $index $base
                            if (Test-Path -LiteralPath $addon) {
                                Assert-PurgeTree $addon $base
                                $null = Get-CoreEntryState $index
                                $restores.Add(@{kind='core';path=$addon;root=$base;channel=$Channel;index=$index})
                            } elseif ((Test-Path -LiteralPath $index) -and (Get-Content -LiteralPath $index -Raw).Contains('./discord-dccon/runtime/main.cjs')) {
                                throw "Missing standalone backup: $index"
                            }
                            Add-PurgeArchives $core $base
                        }
                    }
                }
            } catch {$failures.Add($_.Exception.Message)}
        }
    }
    foreach ($name in @('discord-dccon', 'discord-dccon-canary', 'DCCon-shelter', 'DCCon-shelter-poc')) {
        try {Add-PurgeTarget (Join-Path $env:APPDATA $name) $env:APPDATA} catch {$failures.Add($_.Exception.Message)}
    }
    foreach ($plugins in @((Join-Path $env:APPDATA 'BetterDiscord/plugins'), [IO.Path]::GetFullPath($PluginsDirectory)) | Select-Object -Unique) {
        try {
            Assert-PurgePath $plugins (Split-Path $plugins)
            if (!(Test-Path -LiteralPath $plugins)) {continue}
            foreach ($name in @('discord-dccon-cache', 'discord-dccon-library', 'DCCon-cache')) {Add-PurgeTarget (Join-Path $plugins $name) $plugins}
            foreach ($file in Get-ChildItem -LiteralPath $plugins -Force) {
                if ($file.Name -match '^(?:discord-dccon|DCCon)\.(?:plugin\.js|config\.json)(?:\.(?:backup|removed)-[a-f0-9]{32})?$' -or $file.Name -eq 'discord-dccon.plugin.js.installing') {
                    Add-PurgeTarget $file.FullName $plugins
                }
            }
        } catch {$failures.Add($_.Exception.Message)}
    }
    Write-Host 'Purge scope: all Discord channels, current and historical discord-dccon/DCCon data for this user.'
    foreach ($item in $restores) {Write-Host "RESTORE original loader, DELETE addon: $($item.path)"}
    foreach ($item in $deletions) {Write-Host "DELETE: $($item.path)"}
    Write-Host 'Browser/userscript and old Shelter IndexedDB settings are not removed. Clear this addon in its script/plugin manager; Discord profiles and other mods are preserved.'
    if ($failures.Count) {throw ("Purge blocked; no files changed:`n" + ($failures -join "`n"))}
    if (!$restores.Count -and !$deletions.Count) {Write-Host 'No known filesystem installation or data found.'; return}
    if ($DryRun) {Write-Host 'Dry run only. No files changed.'; return}
    if (Get-Process -Name Discord,DiscordPTB,DiscordCanary -ErrorAction SilentlyContinue) {throw 'Fully quit all Discord channels before purging.'}
    if (!$Yes -and (Read-Host 'Permanently delete settings, saved cons, personal images and caches? Type PURGE') -cne 'PURGE') {Write-Host 'Cancelled. No files changed.'; return}
    # Validate every candidate again before the first write, then detach loaders
    # before deleting shared data. A failed restore preserves all remaining data.
    foreach ($item in $deletions) {Assert-PurgeTree $item.path $item.root}
    foreach ($item in $restores) {
        $Channel = $item.channel
        Assert-PurgeTree $item.path $item.root
        if ($item.kind -eq 'core') {Assert-PurgePath $item.index $item.root; $null = Get-CoreEntryState $item.index}
        else {Assert-PurgePath $item.legacy.original $item.root; $null = Get-LegacyStandalone $item.resources $item.prefix}
    }
    foreach ($item in $restores) {
        if ($item.kind -eq 'core') {$archive = Remove-CoreAddon $item.index}
        else {Remove-LegacyStandalone $item.legacy; $archive = $item.legacy.archive}
        $deletions.Add(@{path=$archive;root=$item.root})
    }
    foreach ($item in $deletions) {
        try {
            Assert-PurgeTree $item.path $item.root
            Remove-Item -LiteralPath ([IO.Path]::GetFullPath($item.path)) -Recurse -Force
            Write-Host "Deleted: $($item.path)"
        } catch {$failures.Add("$($item.path): $($_.Exception.Message)")}
    }
    if ($failures.Count) {throw ("Some paths could not be deleted; rerun after resolving them:`n" + ($failures -join "`n"))}
    Write-Host 'Purge complete for the listed filesystem paths.'
}
$Mode = switch ($Mode) { 'betterdiscord' {'BetterDiscord'} 'standalone' {'Standalone'} default {'Auto'} }
$Channel = switch ($Channel) { 'PTB' {'PTB'} 'Canary' {'Canary'} default {'Stable'} }
if ($Purge) {
    foreach ($option in @('remove', 'mode', 'channel', 'version', 'discordroot')) {
        if ($PSBoundParameters.ContainsKey($option)) {throw "-purge covers all channels; do not combine it with -$option."}
    }
    Invoke-Purge
    return
}
if ($DryRun -or $Yes) {throw '-dryrun and -yes require -purge.'}
$client = switch ($Channel) { 'PTB' {'DiscordPTB'} 'Canary' {'DiscordCanary'} default {'Discord'} }
if (!$DiscordRoot) {$DiscordRoot = Join-Path $env:LOCALAPPDATA $client}
$DiscordRoot = [IO.Path]::GetFullPath($DiscordRoot)
if (Get-Process -Name Discord,DiscordPTB,DiscordCanary -ErrorAction SilentlyContinue | Where-Object { $_.Path -and [IO.Path]::GetFullPath($_.Path).StartsWith($DiscordRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) }) {
    throw "Fully quit Discord $Channel first."
}
$dataRoot = Join-Path $env:APPDATA $client.ToLowerInvariant()
$detected = Get-InstallationMode $DiscordRoot $dataRoot
$HostMod = if ($detected -in @('Vencord', 'Shelter')) {$detected.ToLowerInvariant()} else {''}
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
$downloadBase = "https://github.com/$repository/releases/latest/download"
if ($Version) {
    if ($Version -cnotmatch '^v[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.-]+)?$') {throw 'Version must be a release tag such as v3.5.1.'}
    $downloadBase = "https://github.com/$repository/releases/download/$Version"
}
$assetName = 'discord-dccon-' + $Mode.ToLowerInvariant() + '.zip'
$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$workspace = Join-Path $tempBase ('discord-dccon-install-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $workspace | Out-Null
try {
    $releaseLabel = if ($Version) {$Version} else {'latest'}
    Write-Host "Downloading discord-dccon $releaseLabel ($Mode)..."
    $archive = Join-Path $workspace $assetName
    $checksumPath = Join-Path $workspace 'checksums.json'
    # Direct release downloads avoid the unauthenticated GitHub API quota.
    # If latest changes between downloads, checksum verification fails safely.
    foreach ($download in @(@("$downloadBase/$assetName", $archive), @("$downloadBase/checksums.json", $checksumPath))) {
        try {
            Invoke-WebRequest -UseBasicParsing -Uri $download[0] -Headers @{'User-Agent'='discord-dccon-Installer'} -OutFile $download[1]
        } catch {
            throw "Could not download release file $($download[0]). No installation was changed. $($_.Exception.Message)"
        }
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
