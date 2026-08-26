#!/usr/bin/env bash
# claudops egress firewall -- default-deny plus an ipset whitelist.
#
# Runs exactly once per container start, as root, from the entrypoint:
#
#     sudo -n /usr/local/bin/init-firewall.sh
#
# Modelled on Anthropic's .devcontainer/init-firewall.sh, with four deliberate
# deviations. Each of them is load-bearing for "reaches whitelisted domains and
# no others":
#
#  * Every exit that is not the success path seals the namespace off. The
#    reference exits non-zero mid-resolution with the policies still ACCEPT and
#    the rules flushed -- it fails open while reporting failure.
#  * The host's /24 is not whitelisted. Here that subnet is the docker bridge:
#    the claudops API listens on the gateway, and the neighbours are other
#    instances. Only the nameservers from /etc/resolv.conf are allowed, port 53.
#  * No blanket ACCEPT for tcp/22. claudops clones over HTTPS through the
#    credential helper; an open SSH port is an exfiltration channel.
#  * IPv6 is rejected wholesale. There is no v6 ipset, and half-filtered v6
#    would be a hole. REJECT rather than DROP so happy-eyeballs falls straight
#    back to v4 instead of waiting out a timeout.
#
# Two smaller substitutions keep the image thin: `getent ahostsv4` (libc, always
# present) instead of dnsutils' `dig`, and jq instead of `aggregate`. Only the
# filter table is flushed, so Docker's nat redirect for 127.0.0.11 -- the
# embedded DNS resolver -- survives untouched.
#
# Inputs arrive through the environment, which sudoers passes through for this
# one command (`Defaults!` ... `env_keep`). Arguments stay forbidden by the ""
# in the sudoers entry. What makes that safe is not the transport but the
# sentinel below: the agent may well invoke this with FIREWALL_ALLOW=evil.example
# in its environment, and the run exits 3 before reading a single variable
# (knowledge/proc-environ-needs-cap-sys-ptrace.md explains why PID 1's
# environment is not readable here instead).
set -uo pipefail

CHAIN='CLAUDOPS-EGRESS'
ALLOW_SET='claudops-allow'
ALLOW_DIR='/etc/claudops/firewall-allow.d'
STATE_FILE='/run/claudops-firewall.state'
GITHUB_META='https://api.github.com/meta'

# Without this one name nothing works at all, so it is the only fatal
# resolution failure -- a flaky CDN name must not cost the operator a session.
REQUIRED_DOMAIN='api.anthropic.com'

success=0
declare -a domains=()
declare -a resolvers=()

log() { printf '[firewall] %s\n' "$*"; }

# state <token> [detail ...] -- first line is one word, so a smoke test can read
# it without parsing.
state() {
  local token="$1"
  shift
  {
    printf '%s\n' "$token"
    [[ "$#" -gt 0 ]] && printf '%s\n' "$@"
  } >"$STATE_FILE" 2>/dev/null
  chmod 0444 "$STATE_FILE" 2>/dev/null
  return 0
}

# Falls back to loopback-only. Returns 0 only if that really took effect:
# setting a policy is itself an iptables call, so without CAP_NET_ADMIN even
# sealing is impossible -- and a container that is not sealed must not be told
# it is.
seal() {
  log 'Sealing the container off -- loopback only.'
  iptables -P INPUT DROP 2>/dev/null
  iptables -P OUTPUT DROP 2>/dev/null
  iptables -P FORWARD DROP 2>/dev/null
  iptables -F INPUT 2>/dev/null
  iptables -F OUTPUT 2>/dev/null
  iptables -A INPUT -i lo -j ACCEPT 2>/dev/null
  iptables -A OUTPUT -o lo -j ACCEPT 2>/dev/null

  if iptables -n -L OUTPUT 2>/dev/null | head -1 | grep -q 'policy DROP'; then
    log 'Sealed: loopback only.'
    return 0
  fi

  log 'WARNING: cannot seal either -- this container is UNFILTERED.'
  return 1
}

# The one thing the reference gets wrong: a setup that dies halfway must not
# leave the door open. Where the door cannot be closed at all, say so plainly
# rather than report a seal that is not there.
on_exit() {
  local status=$?
  [[ "$success" -eq 1 ]] && return 0
  log "ERROR: setup did not complete (status $status)."
  if seal; then
    state 'failed' "exit status $status" 'egress sealed: loopback only'
  else
    state 'unfiltered' "exit status $status" 'no CAP_NET_ADMIN -- egress is NOT filtered'
  fi
  exit 1
}

# ------------------------------------------------------- guards, before the trap

[[ "$(id -u)" == '0' ]] || {
  log 'ERROR: must run as root: sudo -n /usr/local/bin/init-firewall.sh'
  exit 2
}

# The sentinel is the chain itself: it lives in this network namespace, and
# touching that takes CAP_NET_ADMIN, which the unprivileged agent does not hold
# -- so it can neither remove it nor forge it. Deliberately checked *before* the
# EXIT trap exists, so a refused re-run changes nothing at all. A file under
# /run would be the wrong sentinel: it survives docker stop/start while the
# netns does not, so it would refuse after a legitimate restart and permit after
# a hostile flush (knowledge/firewall-sentinel-is-an-iptables-chain.md).
if iptables -n -L "$CHAIN" >/dev/null 2>&1; then
  log "REFUSED: $CHAIN exists -- this container's firewall is already configured."
  log 'Restarting the container is the only way to configure it again.'
  exit 3
fi

for tool in iptables ipset curl jq getent; do
  command -v "$tool" >/dev/null 2>&1 || {
    log "ERROR: $tool is missing from the image."
    exit 2
  }
done

trap on_exit EXIT
state 'configuring'

# Sentinel first, work second: a run that dies before the rules are up must not
# hand a second attempt to whoever caused the first one to fail.
iptables -N "$CHAIN" || {
  log 'ERROR: cannot create the chain -- is --cap-add=NET_ADMIN missing?'
  exit 1
}

# ------------------------------------------------------------------- whitelist

add_cidr() {
  ipset add -exist "$ALLOW_SET" "$1" 2>/dev/null && log "  + $1 ($2)"
}

# A word is either something to resolve later or an address to add right now.
add_word() {
  local word="$1"
  word="${word%$'\r'}" # a CRLF checkout must not turn a host into "github.com\r"
  word="${word#"${word%%[![:space:]]*}"}"
  word="${word%"${word##*[![:space:]]}"}"
  word="${word%%#*}"
  word="${word%"${word##*[![:space:]]}"}"
  [[ -n "$word" ]] || return 0

  if [[ "$word" == */* || "$word" =~ ^[0-9]+(\.[0-9]+){3}$ ]]; then
    add_cidr "$word" 'configured'
  else
    domains+=("$word")
  fi
  return 0
}

resolve_domain() {
  local domain="$1" ip found=0
  while read -r ip; do
    [[ "$ip" =~ ^[0-9]+(\.[0-9]+){3}$ ]] || continue
    add_cidr "$ip" "$domain" && found=1
  done < <(getent ahostsv4 "$domain" 2>/dev/null | awk '{print $1}' | sort -u)

  [[ "$found" -eq 1 ]] && return 0
  log "WARNING: $domain does not resolve -- skipped."
  return 1
}

fetch_github() {
  local body count=0 cidr
  body="$(curl -fsS --max-time 20 "$GITHUB_META")" || {
    log "ERROR: $GITHUB_META is unreachable."
    return 1
  }
  jq -e '.web and .api and .git' >/dev/null 2>&1 <<<"$body" || {
    log 'ERROR: unexpected answer from api.github.com/meta.'
    return 1
  }
  while IFS= read -r cidr; do
    [[ "$cidr" =~ ^[0-9]+(\.[0-9]+){3}/[0-9]{1,2}$ ]] || continue
    add_cidr "$cidr" 'github' && count=$((count + 1))
  done < <(jq -r '((.web // []) + (.api // []) + (.git // []) + (.packages // []))[]
                  | select(contains(":") | not)' <<<"$body")

  [[ "$count" -gt 0 ]] || {
    log 'ERROR: no IPv4 range in the GitHub answer.'
    return 1
  }
  log "GitHub: $count ranges."
  return 0
}

ipset destroy "$ALLOW_SET" 2>/dev/null
ipset create "$ALLOW_SET" hash:net family inet maxelem 131072 || {
  log 'ERROR: ipset create failed -- no ip_set module in this kernel?'
  exit 1
}

shopt -s nullglob
for file in "$ALLOW_DIR"/*.conf; do
  log "Reading $file"
  while IFS= read -r line || [[ -n "$line" ]]; do add_word "$line"; done <"$file"
done
shopt -u nullglob

# The project repository has to be reachable or the clone fails, and its host is
# whatever the operator configured -- not necessarily GitHub.
repo_url="${REPO_URL:-}"
if [[ -n "$repo_url" ]]; then
  repo_host="${repo_url#*://}"
  repo_host="${repo_host#*@}"
  repo_host="${repo_host%%/*}"
  repo_host="${repo_host%%:*}"
  if [[ -n "$repo_host" ]]; then
    log "Repo host from REPO_URL: $repo_host"
    add_word "$repo_host"
  fi
fi

extra="${FIREWALL_ALLOW:-}"
if [[ -n "$extra" ]]; then
  saved_ifs="$IFS"
  IFS=$',; \t\n'
  for word in $extra; do add_word "$word"; done
  IFS="$saved_ifs"
fi

while read -r keyword value _; do
  [[ "$keyword" == 'nameserver' ]] || continue
  value="${value%$'\r'}"
  [[ "$value" =~ ^[0-9]+(\.[0-9]+){3}$ ]] && resolvers+=("$value")
done </etc/resolv.conf
[[ "${#resolvers[@]}" -gt 0 ]] || log 'WARNING: no IPv4 nameserver in /etc/resolv.conf.'

# Everything is resolved while the policies are still ACCEPT. After the flip
# there is no DNS for anything that is not already in the set.
fetch_github || exit 1

for domain in "${domains[@]}"; do
  resolve_domain "$domain" || {
    [[ "$domain" == "$REQUIRED_DOMAIN" ]] && {
      log "ERROR: $REQUIRED_DOMAIN does not resolve."
      exit 1
    }
  }
done

# ----------------------------------------------------------------------- rules

iptables -A "$CHAIN" -o lo -j ACCEPT
iptables -A "$CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
for ns in "${resolvers[@]}"; do
  iptables -A "$CHAIN" -d "$ns" -p udp --dport 53 -j ACCEPT
  iptables -A "$CHAIN" -d "$ns" -p tcp --dport 53 -j ACCEPT
done
iptables -A "$CHAIN" -m set --match-set "$ALLOW_SET" dst -j ACCEPT
# REJECT rather than DROP: the agent gets "connection refused" at once instead of
# a two-minute hang, and the blocked probe below returns immediately.
iptables -A "$CHAIN" -j REJECT --reject-with icmp-admin-prohibited

iptables -F OUTPUT
iptables -A OUTPUT -j "$CHAIN"
iptables -F INPUT
iptables -A INPUT -i lo -j ACCEPT
iptables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

iptables -P INPUT DROP
iptables -P FORWARD DROP
iptables -P OUTPUT DROP

if ip6tables -n -L >/dev/null 2>&1; then
  ip6tables -F 2>/dev/null
  ip6tables -A INPUT -i lo -j ACCEPT
  ip6tables -A OUTPUT -o lo -j ACCEPT
  ip6tables -A OUTPUT -j REJECT --reject-with icmp6-adm-prohibited
  ip6tables -P INPUT DROP
  ip6tables -P FORWARD DROP
  ip6tables -P OUTPUT DROP
  log 'IPv6: rejected except loopback (there is no v6 whitelist).'
else
  log 'IPv6: no ip6tables in this netns -- nothing to filter.'
fi

# ---------------------------------------------------------------- verification

probe() { curl -sS --max-time "$2" -o /dev/null "$1" >/dev/null 2>&1; }

if probe 'https://example.com' 5; then
  log 'ERROR: example.com is reachable -- the firewall is not filtering.'
  exit 1
fi
log 'Blocked probe: example.com refused, as expected.'

for url in "https://$REQUIRED_DOMAIN/" 'https://api.github.com/zen'; do
  probe "$url" 15 || {
    log "ERROR: allowed probe $url failed."
    exit 1
  }
  log "Allowed probe: $url reachable."
done

success=1
state 'active' "$(ipset list "$ALLOW_SET" | grep -c '^[0-9]') entries" "${#domains[@]} domains"
log 'Egress firewall active.'

# --------------------------------------------------------------------- CDN drift
# An A record pinned once goes stale: the CDNs behind nuget, npm and GitHub's
# asset downloads rotate their edges within minutes, so a session that worked
# starts failing halfway through. The loop only ever *adds*, never flushes and
# never touches a policy, and it re-resolves the same names this run already
# accepted -- so it widens nothing the first run would not have allowed. It also
# runs silently: it survives sudo on the container's own stdout, and a per-IP log
# line every fifteen minutes would bury everything else in `docker logs`.
refresh_seconds="${FIREWALL_REFRESH_SECONDS:-}"
[[ "$refresh_seconds" =~ ^[0-9]+$ ]] || refresh_seconds=900

if [[ "$refresh_seconds" -gt 0 ]]; then
  log "Re-resolving the whitelist every ${refresh_seconds}s."
  (
    # Mandatory: bash runs an inherited EXIT trap in a subshell too, and this
    # one seals the container.
    trap - EXIT
    while sleep "$refresh_seconds"; do
      fetch_github >/dev/null 2>&1
      for domain in "${domains[@]}"; do resolve_domain "$domain" >/dev/null 2>&1; done
    done
  ) &
  disown
fi

exit 0
