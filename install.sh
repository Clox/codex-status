#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
bin_source="$script_dir/bin"
lib_source="$script_dir/lib"
local_bin="$HOME/.local/bin"
local_lib="$HOME/.local/lib"
applications_dir="$HOME/.local/share/applications"
config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/codex-account-switcher"
config_file="$config_dir/accounts.conf"
backup_dir="$HOME/.local/state/codex-auth-setup-backups/$(date +%Y%m%d-%H%M%S)"

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

for command_name in node npm gnome-terminal gsettings dconf script setsid pgrep pkill; do
  command -v "$command_name" >/dev/null 2>&1 || fail "required command is missing: $command_name"
done

node_major=$(node --version | sed -E 's/^v([0-9]+).*/\1/')
[[ $node_major =~ ^[0-9]+$ ]] || fail 'could not determine the Node.js version'
((node_major >= 22)) || fail 'Node.js 22 or newer is required; check the current codex-auth README for exact support'

if ! command -v codex-auth >/dev/null 2>&1; then
  printf 'codex-auth is missing; installing the upstream npm package...\n'
  npm install -g @loongphy/codex-auth
fi

codex_auth_bin=$(command -v codex-auth)
node_bin_dir=$(dirname -- "$(command -v node)")
codex_home=${CODEX_HOME:-"$HOME/.codex"}
chatgpt_launcher=${CHATGPT_LAUNCHER:-/usr/bin/chatgpt}
chatgpt_binary=${CHATGPT_BINARY:-/usr/lib/chatgpt/ChatGPT}

[[ -x $chatgpt_launcher ]] || fail "Desktop launcher is not executable: $chatgpt_launcher"
[[ -x $chatgpt_binary ]] || fail "Desktop binary is not executable: $chatgpt_binary"

printf '\nAccounts currently known to codex-auth:\n'
"$codex_auth_bin" list --skip-api || fail 'codex-auth list failed; complete fresh interactive logins first'
printf '\nEnter an exact unique email or alias for each visible row. Values stay in a mode-0600 local file.\n'
read -r -p 'Row/account 1 selector: ' account_1
read -r -p 'Row/account 2 selector: ' account_2
read -r -p 'Row/account 3 selector: ' account_3
[[ -n $account_1 && -n $account_2 && -n $account_3 ]] || fail 'all three account selectors are required'
[[ $account_1 != "$account_2" && $account_1 != "$account_3" && $account_2 != "$account_3" ]] || fail 'account selectors must be unique'

mkdir -p "$backup_dir" "$local_bin" "$local_lib" "$applications_dir" "$config_dir"
chmod 700 "$config_dir"

backup_if_present() {
  local source_path=$1
  if [[ -e $source_path ]]; then
    cp -a -- "$source_path" "$backup_dir/"
  fi
}

backup_if_present "$config_file"
backup_if_present "$local_bin/codex-account"
backup_if_present "$local_bin/codex-usage-watch"
backup_if_present "$local_bin/codex-usage-annotate"
backup_if_present "$local_bin/codex-reset-credits-refresh"
backup_if_present "$local_lib/codex-account-ranking.js"
backup_if_present "$local_lib/codex-reset-credits.js"
backup_if_present "$local_lib/codex-usage-format.js"
for account_number in 1 2 3; do
  backup_if_present "$applications_dir/codex-account${account_number}.desktop"
done
backup_if_present "$applications_dir/codex-usage-watch.desktop"

install -m 0755 "$bin_source/codex-account" "$local_bin/codex-account"
install -m 0755 "$bin_source/codex-usage-watch" "$local_bin/codex-usage-watch"
install -m 0755 "$bin_source/codex-usage-annotate" "$local_bin/codex-usage-annotate"
install -m 0755 "$bin_source/codex-reset-credits-refresh" "$local_bin/codex-reset-credits-refresh"
install -m 0644 "$lib_source/codex-account-ranking.js" "$local_lib/codex-account-ranking.js"
install -m 0644 "$lib_source/codex-reset-credits.js" "$local_lib/codex-reset-credits.js"
install -m 0644 "$lib_source/codex-usage-format.js" "$local_lib/codex-usage-format.js"

escape_config_value() {
  printf '%q' "$1"
}

{
  printf '# Generated locally by Spadrig tools/workstation/codex-auth/install.sh\n'
  printf '# Contains account selectors; keep mode 0600 and never commit this file.\n'
  printf 'ACCOUNT_1=%s\n' "$(escape_config_value "$account_1")"
  printf 'ACCOUNT_2=%s\n' "$(escape_config_value "$account_2")"
  printf 'ACCOUNT_3=%s\n' "$(escape_config_value "$account_3")"
  printf 'CODEX_HOME=%s\n' "$(escape_config_value "$codex_home")"
  printf 'NODE_BIN_DIR=%s\n' "$(escape_config_value "$node_bin_dir")"
  printf 'CODEX_AUTH_BIN=%s\n' "$(escape_config_value "$codex_auth_bin")"
  printf 'CHATGPT_LAUNCHER=%s\n' "$(escape_config_value "$chatgpt_launcher")"
  printf 'CHATGPT_BINARY_PATTERN=%s\n' "$(escape_config_value "$chatgpt_binary")"
  printf 'ACCOUNT_SWITCHER=%s\n' "$(escape_config_value "$local_bin/codex-account")"
  printf 'USAGE_ANNOTATOR=%s\n' "$(escape_config_value "$local_bin/codex-usage-annotate")"
  printf 'RESET_CREDITS_REFRESHER=%s\n' "$(escape_config_value "$local_bin/codex-reset-credits-refresh")"
  printf 'RESET_CREDITS_CACHE=%s\n' "$(escape_config_value "${XDG_CACHE_HOME:-$HOME/.cache}/codex-account-switcher/reset-credits.json")"
} >"$config_file"
chmod 600 "$config_file"

for account_number in 1 2 3; do
  desktop_file="$applications_dir/codex-account${account_number}.desktop"
  {
    printf '[Desktop Entry]\n'
    printf 'Type=Application\n'
    printf 'Name=Codex - Konto %s\n' "$account_number"
    printf 'Comment=Byt Codex-konto och starta om Desktop\n'
    printf 'Exec=%s %s --desktop\n' "$local_bin/codex-account" "$account_number"
    printf 'Icon=chatgpt\n'
    printf 'Terminal=false\n'
    printf 'Categories=Development;\n'
  } >"$desktop_file"
  chmod 0644 "$desktop_file"
done

profile_name='Codex-status'
profile_uuid=''
profile_existed=false
profile_list=$(gsettings get org.gnome.Terminal.ProfilesList list)
for candidate in $(printf '%s' "$profile_list" | tr -d "[],'"); do
  candidate_name=$(gsettings get "org.gnome.Terminal.Legacy.Profile:/org/gnome/terminal/legacy/profiles:/:${candidate}/" visible-name 2>/dev/null || true)
  if [[ $candidate_name == "'$profile_name'" ]]; then
    profile_uuid=$candidate
    profile_existed=true
    break
  fi
done

if [[ -z $profile_uuid ]]; then
  if command -v uuidgen >/dev/null 2>&1; then
    profile_uuid=$(uuidgen)
  else
    read -r profile_uuid </proc/sys/kernel/random/uuid
  fi
  default_uuid=$(gsettings get org.gnome.Terminal.ProfilesList default | tr -d "'")
  dconf dump "/org/gnome/terminal/legacy/profiles:/:${default_uuid}/" |
    dconf load "/org/gnome/terminal/legacy/profiles:/:${profile_uuid}/"
  if [[ $profile_list == '@as []' || $profile_list == '[]' ]]; then
    new_profile_list="['$profile_uuid']"
  else
    new_profile_list="${profile_list%]}"
    new_profile_list="${new_profile_list}, '$profile_uuid']"
  fi
  gsettings set org.gnome.Terminal.ProfilesList list "$new_profile_list"
fi

profile_schema="org.gnome.Terminal.Legacy.Profile:/org/gnome/terminal/legacy/profiles:/:${profile_uuid}/"
if [[ $profile_existed == true ]]; then
  dconf dump "/org/gnome/terminal/legacy/profiles:/:${profile_uuid}/" >"$backup_dir/gnome-terminal-Codex-status.dconf"
fi
gsettings set "$profile_schema" visible-name "$profile_name"
gsettings set "$profile_schema" scrollbar-policy 'never'

status_desktop="$applications_dir/codex-usage-watch.desktop"
{
  printf '[Desktop Entry]\n'
  printf 'Type=Application\n'
  printf 'Name=Codex-kontostatus\n'
  printf 'Comment=Visa Codex-konton och återstående kvoter\n'
  printf 'Exec=%s --hide-menubar --profile=%s -- %s\n' "$(command -v gnome-terminal)" "$profile_name" "$local_bin/codex-usage-watch"
  printf 'Icon=utilities-terminal\n'
  printf 'Terminal=false\n'
  printf 'Categories=Development;Utility;\n'
} >"$status_desktop"
chmod 0644 "$status_desktop"

printf '\nInstalled account switchers and status window.\n'
printf 'Local backup: %s\n' "$backup_dir"
printf 'Private configuration: %s\n' "$config_file"
printf 'Run "codex-auth config auto disable" for the stable restart workflow.\n'
printf 'Review API/local usage mode with "codex-auth status".\n'
