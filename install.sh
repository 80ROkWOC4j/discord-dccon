#!/bin/bash
# Online macOS installer. Uses only tools shipped with macOS.
# curl -fsSL https://github.com/80ROkWOC4j/discord-dccon/releases/latest/download/install.sh | bash
set -euo pipefail
fail() { echo "$*" >&2; exit 1; }
hash() { shasum -a 256 "$1" | awk '{print $1}'; }
json_value() {
  /usr/bin/osascript -l JavaScript -e '
ObjC.import("Foundation");
function run(args) {
  var text = $.NSString.stringWithContentsOfFileEncodingError(args[0], $.NSUTF8StringEncoding, null);
  if (!text) throw Error("Cannot read JSON file");
  var value = JSON.parse(ObjC.unwrap(text));
  for (var i = 1; i < args.length; i++) {
    if (value === null || value === undefined || !Object.prototype.hasOwnProperty.call(value, args[i])) return "";
    value = value[args[i]];
  }
  if (value === null || value === undefined) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}' "$@"
}
is_vencord() {
  local resources=$1 patcher=$2 needle
  [[ -e "$resources/_app.asar" ]] || return 1
  [[ -f "$resources/_app.asar" && -f "$resources/app.asar" && -f "$patcher" ]] || fail 'Incomplete Vencord installation. Repair Vencord first.'
  needle=$(/usr/bin/osascript -l JavaScript -e 'function run(args) { return "require(" + JSON.stringify(args[0]).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026") + ")"; }' "$patcher")
  /usr/bin/grep -aFq "$needle" "$resources/app.asar" || fail 'Unknown Vencord app loader.'
}
core_entry_state() {
  local file=$1 installed entry original_hash loader_hash current
  installed="$(dirname "$file")/discord-dccon"
  if [[ -e "$installed" ]]; then
    [[ -d "$installed" && -f "$installed/loader.sha256" && -f "$installed/original.sha256" && -f "$installed/original.js" ]] || fail 'Unknown standalone installation.'
    original_hash=$(cat "$installed/original.sha256") || return 1
    loader_hash=$(cat "$installed/loader.sha256") || return 1
    [[ $(hash "$installed/original.js") == "$original_hash" ]] || fail 'Original module entry was modified.'
    current=$(hash "$file") || return 1
    if [[ $current == "$loader_hash" ]]; then printf 'addon\n';
    elif [[ $current == "$original_hash" ]]; then printf 'original\n';
    else fail 'Standalone loader or backup was modified.'; fi
  else
    entry=$(tr -d '[:space:]' < "$file") || return 1
    if [[ $entry == 'module.exports=require("./core.asar");' || $entry == "module.exports=require('./core.asar');" ]]; then printf 'original\n';
    else printf 'other\n'; fi
  fi
}
is_shelter_core() {
  local file=$1 core
  core=$(dirname "$file")
  [[ ! -d "$core/discord-dccon" ]] || file="$core/discord-dccon/original.js"
  [[ -f "$core/preload.js" && -f "$core/branches.json" ]] &&
    /usr/bin/grep -q 'SHELTUPDATE_FRAMEWORK_ORIGINAL_PRELOAD' "$file" &&
    /usr/bin/grep -q 'SHELTER_BUNDLE_FETCH' "$file" &&
    /usr/bin/grep -q 'SHELTER_BUNDLE_FETCH' "$core/preload.js"
}
detect_installation() {
  local app=$1 data=$2 bd=$3 version resources entry file installed state=Standalone found=false vencord=false shelter=false shelter_core=false
  [[ -d "$app" ]] || fail "Discord not found: $app"
  resources="$app/Contents/Resources"
  version=$(/usr/bin/plutil -extract version raw -o - "$resources/build_info.json")
  [[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail 'Unexpected Discord version.'
  if [[ -f "$data/settings.json" ]]; then
    for key in UPDATE_ENDPOINT NEW_UPDATE_ENDPOINT; do
      entry=$(json_value "$data/settings.json" "$key") || fail 'Invalid Discord settings.json'
      if [[ -n "$entry" ]]; then
        [[ ${entry%/} == https://inject.shelter.uwu.network/shelter ]] || fail 'Custom Discord update endpoints detected. Remove the existing client mod first.'
        shelter=true
      fi
    done
  fi
  if [[ -e "$resources/app" ]]; then
    [[ -f "$resources/app/index.js" && -f "$resources/betterdiscord.app.asar" && ! -e "$resources/app.asar" ]] || fail 'Unknown or inactive Discord app loader.'
    /usr/bin/grep -q 'betterdiscord\.asar' "$resources/app/index.js" || fail 'Unknown Discord app loader.'
    state=BetterDiscord; found=true
  else
    [[ -f "$resources/app.asar" ]] || fail 'Discord app.asar is missing.'
  fi
  if is_vencord "$resources" "$(dirname "$bd")/Vencord/dist/patcher.js"; then vencord=true; fi
  local cores=()
  shopt -s nullglob
  cores=("$data/app-$version/modules/"discord_desktop_core-*/discord_desktop_core/index.js
    "$data/$version/modules/discord_desktop_core/index.js")
  local existing=()
  for file in "${cores[@]}"; do [[ ! -f "$file" ]] || existing+=("$file"); done
  [[ ${#existing[@]} -le 1 ]] || fail 'Multiple Discord core modules detected.'
  if [[ ${#existing[@]} == 0 ]]; then
    $found || fail 'Launch Discord once to install its core module, then quit it.'
  fi
  for file in "${existing[@]}"; do
    installed="$(dirname "$file")/discord-dccon"
    entry=$(core_entry_state "$file") || return 1
    if $shelter && is_shelter_core "$file"; then shelter_core=true; fi
    if [[ -d "$installed" ]]; then
      $found && fail 'Multiple client mod loaders detected.'
      found=true
    elif [[ $entry == original ]]; then
      :
    elif $shelter && $shelter_core; then
      :
    elif /usr/bin/grep -q 'betterdiscord\.asar' "$file" && /usr/bin/grep -q 'core\.asar' "$file"; then
      $found && fail 'Multiple client mod loaders detected.'
      state=BetterDiscord; found=true
    else
      fail "Unknown Discord core loader: $file"
    fi
  done
  if [[ $state == BetterDiscord ]]; then
    [[ -f "$bd/data/betterdiscord.asar" && -d "$bd/plugins" ]] || fail 'BetterDiscord injection exists but its runtime or plugin directory is missing. Repair BetterDiscord first.'
  fi
  if $vencord; then
    [[ $state != BetterDiscord ]] || fail 'Multiple client mod loaders detected.'
    state=Vencord
  fi
  if $shelter; then
    $shelter_core || fail 'Incomplete Shelter installation. Repair sheltupdate first.'
    [[ $state == Standalone ]] || fail 'Multiple client mod loaders detected.'
    state=Shelter
  fi
  printf '%s\n' "$state"
}

install_betterdiscord() {
  plugins="$HOME/Library/Application Support/BetterDiscord/plugins"
  [[ -d "$plugins" ]] || { echo 'BetterDiscord plugin directory not found.' >&2; exit 1; }
  target="$plugins/discord-dccon.plugin.js"
  if $remove; then
    [[ -f "$target" ]] || { echo 'discord-dccon plugin is not installed.' >&2; exit 1; }
    mv "$target" "$target.removed-$(uuidgen)"
    echo 'discord-dccon plugin removed. BetterDiscord, settings and cache were preserved.'
    return
  fi
  source="$package/discord-dccon.plugin.js"
  [[ -f "$source" ]] || { echo 'Plugin file is missing from this package.' >&2; exit 1; }
  if [[ -f "$target" ]]; then
    if cmp -s "$source" "$target"; then echo 'This discord-dccon version is already installed.'; return; fi
    cp "$target" "$target.backup-$(uuidgen)"
  fi
  cp "$source" "$target.installing"
  mv "$target.installing" "$target"
  cmp "$source" "$target"
  echo 'discord-dccon installed. Enable it in Discord Settings > BetterDiscord > Plugins.'
}

install_standalone() {
  local host_mod=${1:-} app_before= app_binary vencord_patcher
  if [[ $host_mod == vencord ]]; then
    vencord_patcher="$HOME/Library/Application Support/Vencord/dist/patcher.js"
    is_vencord "$app/Contents/Resources" "$vencord_patcher" || fail 'Expected the standard Vencord installation.'
    app_binary=$(/usr/bin/plutil -extract CFBundleExecutable raw -o - "$app/Contents/Info.plist")
    [[ -n $app_binary && $app_binary != */* ]] || fail 'Unexpected Discord executable name.'
    # Vencord already changed the signed bundle. Preserve its exact bytes.
    app_before=$(shasum -a 256 "$app/Contents/Resources/"{app,_app}.asar "$app/Contents/MacOS/$app_binary")
  elif [[ -z $host_mod || $host_mod == shelter ]]; then
    codesign --verify --deep --strict "$app"
  else
    fail 'Unsupported standalone host mod.'
  fi
  version=$(/usr/bin/plutil -extract version raw -o - "$app/Contents/Resources/build_info.json")
  [[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail 'Unexpected Discord version.'
  shopt -s nullglob
  cores=("$data/app-$version/modules/"discord_desktop_core-*/discord_desktop_core/index.js
    "$data/$version/modules/discord_desktop_core/index.js")
  local existing=()
  for file in "${cores[@]}"; do [[ ! -f "$file" ]] || existing+=("$file"); done
  [[ ${#existing[@]} == 1 ]] || fail 'Launch Discord once to install its core module, then quit it. Expected exactly one core module.'
  core=$(dirname "${existing[0]}")
  [[ -f "$core/core.asar" && -f "$core/index.js" ]] || fail 'Incomplete Discord core module.'
  installed="$core/discord-dccon"
  entry=$(core_entry_state "$core/index.js") || return 1
  if [[ $host_mod == shelter ]]; then
    is_shelter_core "$core/index.js" || fail 'Expected the standard sheltupdate Shelter installation.'
  else
    [[ $entry != other ]] || fail 'Unknown Discord core loader.'
  fi
  if $remove && [[ ! -d "$installed" ]]; then fail 'No standalone installation in the current Discord core module.'; fi
  if $remove; then
    [[ -z $app_before || $app_before == "$(shasum -a 256 "$app/Contents/Resources/"{app,_app}.asar "$app/Contents/MacOS/$app_binary")" ]] || fail 'Vencord app changed before removal.'
    if ! cp "$installed/original.js" "$core/index.js.restoring"; then
      rm -f "$core/index.js.restoring"; fail 'Could not prepare original core entry.'
    fi
    local archive="$core/discord-dccon-removed-$(uuidgen)"
    if ! mv "$installed" "$archive"; then
      rm -f "$core/index.js.restoring"; fail 'Could not archive installed runtime.'
    fi
    if ! mv "$core/index.js.restoring" "$core/index.js"; then
      mv "$archive" "$installed"
      rm -f "$core/index.js.restoring"; fail 'Could not restore original core entry; runtime restored.'
    fi
    echo 'Standalone removed. Original Discord module restored; user data preserved.'
    return
  fi
  build="$package/runtime"
  [[ -f "$package/shelter-version.json" ]] || fail 'Package metadata is missing. Choose a newer release.'
  [[ $(json_value "$package/shelter-version.json" installLayout) == desktop_core ]] || fail 'This package does not use the desktop_core layout. Choose a newer release.'
  supported=$(json_value "$package/shelter-version.json" channels)
  [[ $supported == *"\"$channel\""* ]] || fail "This release does not support standalone $channel. Choose a newer release."
  if [[ $host_mod == shelter ]]; then
    [[ $(json_value "$package/shelter-version.json" hostMods) == *'"shelter"'* ]] || fail 'This release does not support Shelter coexistence. Choose a newer release.'
  fi
  for file in bootstrap.js main.cjs preload.cjs native.js shared-storage.cjs; do
    [[ -f "$build/$file" ]] || fail 'Missing runtime. Use a built release package or run npm run build:packages.'
  done
  stage=$(mktemp -d "$core/.discord-dccon-stage.XXXXXX")

  mkdir "$stage/runtime"
  for file in bootstrap.js main.cjs preload.cjs native.js shared-storage.cjs; do cp "$build/$file" "$stage/runtime/$file"; done
  if [[ -n $host_mod ]]; then
    printf '{"channel":"%s","hostMod":"%s"}\n' "$channel" "$host_mod" > "$stage/runtime/channel.json"
  else
    printf '{"channel":"%s"}\n' "$channel" > "$stage/runtime/channel.json"
  fi
  if [[ -d "$installed" ]]; then cp "$installed/original.js" "$stage/original.js";
  else cp "$core/index.js" "$stage/original.js"; fi
  cat > "$stage/index.js" <<'JS'
// discord-dccon standalone: preserve the vendor application bundle.
try { require('./discord-dccon/runtime/main.cjs'); }
catch (error) { console.error('[discord-dccon] Loader failed', error); }
JS
  if [[ $host_mod == shelter ]]; then
    # Keep sheltupdate's relative paths and __dirname in the original core directory.
    cat "$stage/original.js" >> "$stage/index.js"
  else
    printf "module.exports = require('./core.asar');\n" >> "$stage/index.js"
  fi
  hash "$stage/index.js" > "$stage/loader.sha256"
  hash "$stage/original.js" > "$stage/original.sha256"
  # Complete preparation and app validation before changing the active runtime.
  if [[ $host_mod == vencord ]]; then
    [[ $app_before == "$(shasum -a 256 "$app/Contents/Resources/"{app,_app}.asar "$app/Contents/MacOS/$app_binary")" ]] || fail 'Vencord app changed before installation.'
  else
    codesign --verify --deep --strict "$app"
  fi
  if ! cp "$stage/index.js" "$core/index.js.installing"; then
    rm -f "$core/index.js.installing"; fail 'Could not prepare core entry.'
  fi
  previous=
  if [[ -d "$installed" ]]; then
    previous="$core/discord-dccon-previous-$(uuidgen)"
    if ! mv "$installed" "$previous"; then
      rm -f "$core/index.js.installing"; fail 'Could not archive installed runtime.'
    fi
  fi
  if ! mv "$stage" "$installed"; then
    [[ -z "$previous" ]] || mv "$previous" "$installed"
    rm -f "$core/index.js.installing"; fail 'Could not install runtime.'
  fi
  if ! mv "$core/index.js.installing" "$core/index.js"; then
    mv "$installed" "$stage"
    [[ -z "$previous" ]] || mv "$previous" "$installed"
    rm -f "$core/index.js.installing"; fail 'Could not activate core entry; previous runtime restored.'
  fi
  if [[ $host_mod == shelter ]]; then
    echo "discord-dccon installed in existing Shelter for Discord $channel $version. Start Discord normally."
  else
    echo "Standalone installed for Discord $channel $version. Start Discord normally."
  fi
  echo 'Discord core updates may require running this installer again.'
}

# Online entry point.
[[ $(uname -s) == Darwin ]] || fail 'This installer requires macOS.'
mode=Auto; channel=Stable; version=; remove=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode|--channel|--version)
      [[ $# -ge 2 ]] || fail "Missing value for $1"
      case "$1" in --mode) mode=$2;; --channel) channel=$2;; --version) version=$2;; esac
      shift 2 ;;
    --remove) remove=true; shift ;;
    *) fail 'Usage: bash install.sh [--mode auto|betterdiscord|standalone] [--channel stable|ptb|canary] [--version vX.Y.Z] [--remove]' ;;
  esac
done
case "$mode" in
  auto|Auto) mode=Auto ;;
  betterdiscord|BetterDiscord) mode=BetterDiscord ;;
  standalone|Standalone) mode=Standalone ;;
  *) fail 'Mode must be auto, betterdiscord or standalone.' ;;
esac
case "$channel" in
  stable|Stable) channel=Stable; app=/Applications/Discord.app; data="$HOME/Library/Application Support/discord"; process=Discord ;;
  ptb|PTB) channel=PTB; app='/Applications/Discord PTB.app'; data="$HOME/Library/Application Support/discordptb"; process='Discord PTB' ;;
  canary|Canary) channel=Canary; app='/Applications/Discord Canary.app'; data="$HOME/Library/Application Support/discordcanary"; process='Discord Canary' ;;
  *) fail 'Channel must be stable, ptb or canary.' ;;
esac
pgrep -x "$process" >/dev/null && fail "Fully quit Discord $channel first."
bd="$HOME/Library/Application Support/BetterDiscord"
detected=$(detect_installation "$app" "$data" "$bd")
host_mod=
if [[ $detected == Vencord ]]; then host_mod=vencord; detected=Standalone; fi
if [[ $detected == Shelter ]]; then host_mod=shelter; detected=Standalone; fi
[[ $mode == Auto || $mode == "$detected" ]] || fail "Detected $detected; requested $mode. Existing loaders are not replaced."
mode=$detected
printf 'Selected %s for Discord %s.\n' "$mode" "$channel"
workspace=; stage=
trap '[[ -z "$stage" ]] || rm -rf "$stage"; [[ -z "$workspace" ]] || rm -rf "$workspace"' EXIT
if $remove; then
  if [[ $mode == BetterDiscord ]]; then install_betterdiscord; else install_standalone "$host_mod"; fi
  exit
fi
repository=80ROkWOC4j/discord-dccon
release="https://api.github.com/repos/$repository/releases/latest"
if [[ -n "$version" ]]; then
  [[ $version =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.-]+)?$ ]] || fail 'Version must be a release tag such as v3.5.1.'
  release="https://api.github.com/repos/$repository/releases/tags/$version"
fi
workspace=$(mktemp -d "${TMPDIR:-/tmp}/discord-dccon-install.XXXXXX")
fetch() { curl --fail --location --silent --show-error --retry 2 --connect-timeout 15 --max-time 180 --proto '=https' --proto-redir '=https' -H 'User-Agent: discord-dccon-Installer' "$1" -o "$2"; }
fetch "$release" "$workspace/release.json"
case "$mode" in BetterDiscord) asset=discord-dccon-betterdiscord.zip;; Standalone) asset=discord-dccon-standalone.zip;; esac
asset_url=; checksum_url=; index=0
while true; do
  name=$(json_value "$workspace/release.json" assets "$index" name)
  [[ -n "$name" ]] || break
  case "$name" in
    "$asset"|checksums.json)
      url=$(json_value "$workspace/release.json" assets "$index" browser_download_url)
      [[ $url == "https://github.com/$repository/releases/download/"* ]] || fail 'Unexpected release asset URL.'
      if [[ $name == "$asset" ]]; then
        [[ -z "$asset_url" ]] || fail 'Duplicate package asset.'; asset_url=$url
      else
        [[ -z "$checksum_url" ]] || fail 'Duplicate checksum asset.'; checksum_url=$url
      fi ;;
  esac
  index=$((index + 1))
done
[[ -n "$asset_url" && -n "$checksum_url" ]] || fail "Release is missing $asset or checksums.json. No installation was changed."
fetch "$asset_url" "$workspace/package.zip"
fetch "$checksum_url" "$workspace/checksums.json"
expected=$(json_value "$workspace/checksums.json" "$asset")
[[ $expected =~ ^[a-fA-F0-9]{64}$ ]] || fail 'Invalid package checksum.'
[[ $(hash "$workspace/package.zip") == "$(printf '%s' "$expected" | tr 'A-F' 'a-f')" ]] || fail 'Downloaded package checksum mismatch. No installation was changed.'
mkdir "$workspace/package"
/usr/bin/ditto -x -k "$workspace/package.zip" "$workspace/package"
package="$workspace/package"
if [[ $mode == BetterDiscord ]]; then install_betterdiscord; else install_standalone "$host_mod"; fi
