#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
bin_source="$script_dir/bin"
lib_source="$script_dir/lib"
systemd_source="$script_dir/systemd"
local_bin="$HOME/.local/bin"
local_lib="$HOME/.local/lib"
applications_dir="$HOME/.local/share/applications"
config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/codex-account-switcher"
config_file="$config_dir/accounts.conf"
systemd_user_dir="$HOME/.config/systemd/user"
backup_dir="$HOME/.local/state/codex-auth-setup-backups/$(date +%Y%m%d-%H%M%S)"

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

for command_name in node npm gnome-terminal gsettings dconf script setsid pgrep pkill systemctl systemd-run busctl flock wmctrl xprop sqlite3; do
  command -v "$command_name" >/dev/null 2>&1 || fail "required command is missing: $command_name"
done
[[ -x /usr/libexec/gnome-terminal-server && -x /usr/bin/gnome-terminal.real ]] ||
  fail 'the GNOME Terminal server/client binaries are required for the status window'

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
codex_login_bin=$(command -v codex || true)
codex_login_bin=${codex_login_bin:-/usr/lib/chatgpt/resources/codex}

[[ -x $chatgpt_launcher ]] || fail "Desktop launcher is not executable: $chatgpt_launcher"
[[ -x $chatgpt_binary ]] || fail "Desktop binary is not executable: $chatgpt_binary"
[[ -x $codex_login_bin ]] || fail "Codex login binary is not executable: $codex_login_bin"

printf '\nAccounts currently known to codex-auth:\n'
"$codex_auth_bin" list --skip-api || fail 'codex-auth list failed; complete fresh interactive logins first'
printf '\nEnter the exact unique email or alias that each numbered launcher should use. Values stay in a mode-0600 local file.\n'
read -r -p 'Launcher/account 1 selector: ' account_1
read -r -p 'Launcher/account 2 selector: ' account_2
read -r -p 'Launcher/account 3 selector: ' account_3
[[ -n $account_1 && -n $account_2 && -n $account_3 ]] || fail 'all three account selectors are required'
[[ $account_1 != "$account_2" && $account_1 != "$account_3" && $account_2 != "$account_3" ]] || fail 'account selectors must be unique'

mkdir -p "$backup_dir" "$local_bin" "$local_lib" "$applications_dir" "$config_dir" "$systemd_user_dir"
chmod 700 "$config_dir"

status_was_running=false
status_process_pattern="(^|[[:space:]])${local_bin}/codex-usage-watch([[:space:]]|$)"
if pgrep -f "$status_process_pattern" >/dev/null 2>&1; then
  status_was_running=true
  pkill -TERM -f "$status_process_pattern" >/dev/null 2>&1 || true
  for ((attempt = 0; attempt < 25; attempt++)); do
    pgrep -f "$status_process_pattern" >/dev/null 2>&1 || break
    sleep 0.2
  done
  pgrep -f "$status_process_pattern" >/dev/null 2>&1 && fail 'the old status window did not stop; close it and rerun the installer'
fi

backup_if_present() {
  local source_path=$1
  if [[ -e $source_path ]]; then
    cp -a -- "$source_path" "$backup_dir/"
  fi
}

backup_if_present "$config_file"
backup_if_present "$local_bin/codex-account"
backup_if_present "$local_bin/codex-account-state"
backup_if_present "$local_bin/codex-auto-continue"
backup_if_present "$local_bin/codex-continuation-drafts"
backup_if_present "$local_bin/codex-auth-repair"
backup_if_present "$local_bin/codex-usage-launch"
backup_if_present "$local_bin/codex-usage-watch"
backup_if_present "$local_bin/codex-status-attention"
backup_if_present "$local_bin/codex-status-preferences"
backup_if_present "$local_bin/codex-quota-transition"
backup_if_present "$local_bin/codex-usage-annotate"
backup_if_present "$local_bin/codex-usage-refresh"
backup_if_present "$local_bin/codex-weekly-activate"
backup_if_present "$local_bin/codex-five-hour-activate"
backup_if_present "$local_bin/codex-five-hour-activation-worker"
backup_if_present "$local_bin/codex-turn-observer"
backup_if_present "$local_bin/codex-manual-resume"
backup_if_present "$local_bin/codex-vscode-normalize"
backup_if_present "$local_bin/codex-reset-credits-refresh"
backup_if_present "$local_lib/codex-account-ranking.js"
backup_if_present "$local_lib/codex-attention-policy.js"
backup_if_present "$local_lib/codex-account-state.js"
backup_if_present "$local_lib/codex-auto-continue.js"
backup_if_present "$local_lib/codex-continuation-drafts.js"
backup_if_present "$local_lib/codex-auth-repair.js"
backup_if_present "$local_lib/codex-reset-credits.js"
backup_if_present "$local_lib/codex-status-render.js"
backup_if_present "$local_lib/codex-status-preferences.js"
backup_if_present "$local_lib/codex-quota-transition.js"
backup_if_present "$local_lib/codex-usage-cache.js"
backup_if_present "$local_lib/codex-weekly-activation.js"
backup_if_present "$local_lib/codex-five-hour-activation.js"
backup_if_present "$local_lib/codex-five-hour-worker.js"
backup_if_present "$local_lib/codex-activation-lock.js"
backup_if_present "$local_lib/codex-activation-account.js"
backup_if_present "$local_lib/codex-activation-hold.js"
backup_if_present "$local_lib/codex-turn-observer.js"
backup_if_present "$local_lib/codex-turn-continuation.js"
backup_if_present "$local_lib/codex-manual-resume.js"
backup_if_present "$local_lib/codex-vscode-normalize.js"
backup_if_present "$local_lib/codex-usage-format.js"
for account_number in 1 2 3; do
  backup_if_present "$applications_dir/codex-account${account_number}.desktop"
done
backup_if_present "$applications_dir/codex-usage-watch.desktop"
backup_if_present "$systemd_user_dir/codex-five-hour-activation.service"
backup_if_present "$systemd_user_dir/codex-five-hour-activation.timer"
backup_if_present "$systemd_user_dir/codex-auto-continue.service"
backup_if_present "$systemd_user_dir/codex-auto-continue.timer"
backup_if_present "$systemd_user_dir/codex-turn-observer.service"

install -m 0755 "$bin_source/codex-account" "$local_bin/codex-account"
install -m 0755 "$bin_source/codex-account-state" "$local_bin/codex-account-state"
install -m 0755 "$bin_source/codex-auto-continue" "$local_bin/codex-auto-continue"
install -m 0755 "$bin_source/codex-continuation-drafts" "$local_bin/codex-continuation-drafts"
install -m 0755 "$bin_source/codex-auth-repair" "$local_bin/codex-auth-repair"
install -m 0755 "$bin_source/codex-usage-launch" "$local_bin/codex-usage-launch"
install -m 0755 "$bin_source/codex-usage-watch" "$local_bin/codex-usage-watch"
install -m 0755 "$bin_source/codex-status-attention" "$local_bin/codex-status-attention"
install -m 0755 "$bin_source/codex-status-preferences" "$local_bin/codex-status-preferences"
install -m 0755 "$bin_source/codex-quota-transition" "$local_bin/codex-quota-transition"
install -m 0755 "$bin_source/codex-usage-annotate" "$local_bin/codex-usage-annotate"
install -m 0755 "$bin_source/codex-usage-refresh" "$local_bin/codex-usage-refresh"
install -m 0755 "$bin_source/codex-weekly-activate" "$local_bin/codex-weekly-activate"
install -m 0755 "$bin_source/codex-five-hour-activate" "$local_bin/codex-five-hour-activate"
install -m 0755 "$bin_source/codex-five-hour-activation-worker" "$local_bin/codex-five-hour-activation-worker"
install -m 0755 "$bin_source/codex-turn-observer" "$local_bin/codex-turn-observer"
install -m 0755 "$bin_source/codex-manual-resume" "$local_bin/codex-manual-resume"
install -m 0755 "$bin_source/codex-vscode-normalize" "$local_bin/codex-vscode-normalize"
install -m 0755 "$bin_source/codex-reset-credits-refresh" "$local_bin/codex-reset-credits-refresh"
install -m 0644 "$lib_source/codex-account-ranking.js" "$local_lib/codex-account-ranking.js"
install -m 0644 "$lib_source/codex-attention-policy.js" "$local_lib/codex-attention-policy.js"
install -m 0644 "$lib_source/codex-account-state.js" "$local_lib/codex-account-state.js"
install -m 0644 "$lib_source/codex-auto-continue.js" "$local_lib/codex-auto-continue.js"
install -m 0644 "$lib_source/codex-continuation-drafts.js" "$local_lib/codex-continuation-drafts.js"
install -m 0644 "$lib_source/codex-auth-repair.js" "$local_lib/codex-auth-repair.js"
install -m 0644 "$lib_source/codex-reset-credits.js" "$local_lib/codex-reset-credits.js"
install -m 0644 "$lib_source/codex-status-render.js" "$local_lib/codex-status-render.js"
install -m 0644 "$lib_source/codex-status-preferences.js" "$local_lib/codex-status-preferences.js"
install -m 0644 "$lib_source/codex-quota-transition.js" "$local_lib/codex-quota-transition.js"
install -m 0644 "$lib_source/codex-usage-cache.js" "$local_lib/codex-usage-cache.js"
install -m 0644 "$lib_source/codex-weekly-activation.js" "$local_lib/codex-weekly-activation.js"
install -m 0644 "$lib_source/codex-five-hour-activation.js" "$local_lib/codex-five-hour-activation.js"
install -m 0644 "$lib_source/codex-five-hour-worker.js" "$local_lib/codex-five-hour-worker.js"
install -m 0644 "$lib_source/codex-activation-lock.js" "$local_lib/codex-activation-lock.js"
install -m 0644 "$lib_source/codex-activation-account.js" "$local_lib/codex-activation-account.js"
install -m 0644 "$lib_source/codex-activation-hold.js" "$local_lib/codex-activation-hold.js"
install -m 0644 "$lib_source/codex-turn-observer.js" "$local_lib/codex-turn-observer.js"
install -m 0644 "$lib_source/codex-turn-continuation.js" "$local_lib/codex-turn-continuation.js"
install -m 0644 "$lib_source/codex-manual-resume.js" "$local_lib/codex-manual-resume.js"
install -m 0644 "$lib_source/codex-vscode-normalize.js" "$local_lib/codex-vscode-normalize.js"
install -m 0644 "$lib_source/codex-usage-format.js" "$local_lib/codex-usage-format.js"
install -m 0644 "$systemd_source/codex-five-hour-activation.service" "$systemd_user_dir/codex-five-hour-activation.service"
install -m 0644 "$systemd_source/codex-five-hour-activation.timer" "$systemd_user_dir/codex-five-hour-activation.timer"
install -m 0644 "$systemd_source/codex-auto-continue.service" "$systemd_user_dir/codex-auto-continue.service"
install -m 0644 "$systemd_source/codex-auto-continue.timer" "$systemd_user_dir/codex-auto-continue.timer"
install -m 0644 "$systemd_source/codex-turn-observer.service" "$systemd_user_dir/codex-turn-observer.service"

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
  printf 'ACCOUNT_STATE_CHECKER=%s\n' "$(escape_config_value "$local_bin/codex-account-state")"
  printf 'CONTINUATION_DRAFTS=%s\n' "$(escape_config_value "$local_bin/codex-continuation-drafts")"
  printf 'AUTH_REPAIRER=%s\n' "$(escape_config_value "$local_bin/codex-auth-repair")"
  printf 'CODEX_LOGIN_BIN=%s\n' "$(escape_config_value "$codex_login_bin")"
  printf 'USAGE_ANNOTATOR=%s\n' "$(escape_config_value "$local_bin/codex-usage-annotate")"
  printf 'USAGE_REFRESHER=%s\n' "$(escape_config_value "$local_bin/codex-usage-refresh")"
  printf 'USAGE_CACHE=%s\n' "$(escape_config_value "${XDG_CACHE_HOME:-$HOME/.cache}/codex-account-switcher/usage.json")"
  printf 'USAGE_REFRESH_LOG=%s\n' "$(escape_config_value "${XDG_CACHE_HOME:-$HOME/.cache}/codex-account-switcher/usage-refresh.log")"
  printf 'FIVE_HOUR_ACTIVATION_STATE=%s\n' "$(escape_config_value "${XDG_CACHE_HOME:-$HOME/.cache}/codex-account-switcher/five-hour-activation.json")"
  printf 'CODEX_EVENT_STATE=%s\n' "$(escape_config_value "${XDG_CACHE_HOME:-$HOME/.cache}/codex-account-switcher/turn-events.json")"
  printf 'CODEX_RESUME_STATE=%s\n' "$(escape_config_value "${XDG_CACHE_HOME:-$HOME/.cache}/codex-account-switcher/manual-resume.json")"
  printf 'CODEX_MANUAL_RESUME=%s\n' "$(escape_config_value "$local_bin/codex-manual-resume")"
  printf 'CODEX_AUTO_CONTINUE_STATE=%s\n' "$(escape_config_value "${XDG_CACHE_HOME:-$HOME/.cache}/codex-account-switcher/auto-continue.json")"
  printf 'CODEX_STATUS_PREFERENCES=%s\n' "$(escape_config_value "$config_dir/status-preferences.json")"
  printf 'CODEX_STATUS_PREFERENCES_BIN=%s\n' "$(escape_config_value "$local_bin/codex-status-preferences")"
  printf 'CODEX_QUOTA_TRANSITION_STATE=%s\n' "$(escape_config_value "${XDG_CACHE_HOME:-$HOME/.cache}/codex-account-switcher/quota-transition.json")"
  printf 'CODEX_QUOTA_TRANSITION_BIN=%s\n' "$(escape_config_value "$local_bin/codex-quota-transition")"
  printf 'RESET_CREDITS_REFRESHER=%s\n' "$(escape_config_value "$local_bin/codex-reset-credits-refresh")"
  printf 'RESET_CREDITS_CACHE=%s\n' "$(escape_config_value "${XDG_CACHE_HOME:-$HOME/.cache}/codex-account-switcher/reset-credits.json")"
} >"$config_file"
chmod 600 "$config_file"

systemctl --user daemon-reload
systemctl --user enable --now codex-five-hour-activation.timer
systemctl --user enable --now codex-auto-continue.timer
systemctl --user enable --now codex-turn-observer.service

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
  printf 'Exec=%s\n' "$local_bin/codex-usage-launch"
  printf 'StartupWMClass=CodexStatus\n'
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
if [[ $status_was_running == true ]]; then
  setsid -f "$local_bin/codex-usage-launch" </dev/null >/dev/null 2>&1
  printf 'Restarted the status window with the newly installed code.\n'
fi
