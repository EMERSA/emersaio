#!/usr/bin/env bash
# Header and routing probes against a running Worker (wrangler dev) or the live site.
#   bash tests/browser/probe.sh 8850            -> http://127.0.0.1:8850
#   bash tests/browser/probe.sh 8850 https      -> https://127.0.0.1:8850 (wrangler dev --local-protocol https)
#   bash tests/browser/probe.sh https://emersa.io
# Exactly one Content-Security-Policy and one Permissions-Policy on "/" is the whole point of ADR-0004.
# The Host-poisoning and rate-limit probes run against local targets only: on the live site a forged Host never
# reaches this Worker, and a burst of 31 posts would trip the zone's WAF rule before the Worker's limiter.
set -u
if [[ "${1:-}" =~ ^https?:// ]]; then B="${1%/}"; else B="${2:-http}://127.0.0.1:${1:?port or base URL}"; fi
LOCAL=0; [[ "$B" =~ ^https?://(127\.0\.0\.1|localhost|\[::1\])(:|/|$) ]] && LOCAL=1
K="-sk --max-time 15"
pass=0; fail=0
row() { # status name detail
  printf "  %-4s  %-52s  %s\n" "$1" "$2" "$3"
  if [[ "$1" == "PASS" ]]; then pass=$((pass+1)); else fail=$((fail+1)); fi
}
code() { curl $K -o /dev/null -w '%{http_code}' -X "$1" "$B$2" "${@:3}" 2>/dev/null; }
# The static assets layer normalises odd paths with a redirect before anything else sees them; follow it.
# --path-as-is sends the dot segments as written: curl would otherwise collapse "/api/../x" to "/x" itself.
final() { curl $K -L --max-redirs 3 --path-as-is -o /dev/null -w '%{http_code}' "$B$1" 2>/dev/null; }
hdrs() { curl $K -D - -o /dev/null "$B$1" "${@:2}" 2>/dev/null | tr -d '\r'; }
count() { echo "$1" | grep -ciE "^$2:" ; }
has() { echo "$1" | grep -qiE "^$2" ; }
expect() { # name actual wanted
  if [[ "$2" == "$3" ]]; then row PASS "$1" "$2"; else row FAIL "$1" "got $2, wanted $3"; fi
}
# A CSP report with a host that is plainly ours to filter out of the emersa_metrics counts (RFC 2606 .invalid).
CSP_REPORT='{"csp-report":{"document-uri":"https://emersa.io/","violated-directive":"script-src","blocked-uri":"https://probe.invalid"}}'
csp_post() { code POST /api/csp -H 'content-type: application/csp-report' -H "origin: $B" --data "$CSP_REPORT"; }

echo "probe: $B"

echo "--- headers on / (static asset, from _headers)"
H=$(hdrs /)
expect "/ has exactly one Content-Security-Policy" "$(count "$H" content-security-policy)" 1
expect "/ has exactly one Permissions-Policy" "$(count "$H" permissions-policy)" 1
expect "/ has exactly one Cross-Origin-Resource-Policy" "$(count "$H" cross-origin-resource-policy)" 1
has "$H" "strict-transport-security: max-age=63072000; includeSubDomains; preload" && row PASS "/ HSTS with preload" "yes" || row FAIL "/ HSTS with preload" "missing"
has "$H" "x-frame-options: DENY" && row PASS "/ X-Frame-Options DENY" "yes" || row FAIL "/ X-Frame-Options DENY" "missing"
has "$H" "permissions-policy: .*microphone=\(\)" && row PASS "/ microphone off (Phase 1)" "microphone=()" || row PASS "/ microphone (Phase 2 or absent)" "$(echo "$H" | grep -ioE 'microphone=\([a-z]*\)' | head -1)"

echo "--- headers on /api/health (Worker response, SECURE_HEADERS)"
H=$(hdrs /api/health)
expect "/api/health status" "$(code GET /api/health)" 200
expect "/api/health has exactly one Content-Security-Policy" "$(count "$H" content-security-policy)" 1
n=$(count "$H" permissions-policy)
if [[ "$n" == "0" ]]; then row PASS "/api/health Permissions-Policy" "none (SECURE_HEADERS sets none; not doubled)"; else expect "/api/health has at most one Permissions-Policy" "$n" 1; fi
has "$H" "cache-control: no-store" && row PASS "/api/health Cache-Control no-store" "yes" || row FAIL "/api/health Cache-Control no-store" "missing"
has "$H" "x-content-type-options: nosniff" && row PASS "/api/health nosniff" "yes" || row FAIL "/api/health nosniff" "missing"
if [[ "$LOCAL" == "1" ]]; then
  expect "forged Host on /api/health -> 404 (host check)" "$(code GET /api/health -H 'Host: evil.example')" 404
fi

echo "--- caching and per-path overrides"
if [[ "$(code GET /og.png)" == "200" ]]; then
  H=$(hdrs /og.png)
  expect "/og.png CORP cross-origin, once" "$(echo "$H" | grep -ciE '^cross-origin-resource-policy: cross-origin$')" 1
else
  row PASS "/og.png" "not present yet (skipped)"
fi
ASSET=$(curl $K "$B/" 2>/dev/null | grep -oE '/_astro/[^"'"'"']+\.(js|css)' | head -1)
if [[ -n "$ASSET" ]]; then
  H=$(hdrs "$ASSET")
  has "$H" "cache-control: public, max-age=31536000, immutable" && row PASS "$ASSET immutable" "yes" || row FAIL "$ASSET immutable" "$(echo "$H" | grep -i '^cache-control' | head -1)"
else
  row FAIL "/_astro/* immutable" "no /_astro/ asset referenced by /"
fi
# Cloudflare's assets layer answers the trailing-slash redirect with a 307 (wrangler dev shows the same); 301 is accepted for other hosts.
R=$(curl $K -o /dev/null -w '%{http_code} %{redirect_url}' "$B/docs/" 2>/dev/null | sed -E 's#https?://[^/]+##')
if [[ "$R" == "301 /docs" || "$R" == "307 /docs" ]]; then row PASS "/docs/ redirects to /docs" "$R"; else row FAIL "/docs/ redirects to /docs" "got $R, wanted 301 or 307 /docs"; fi

echo "--- traversal and unknown routes"
for p in "/%2e%2e/%2e%2e/etc/passwd" "/..%2f..%2fwrangler.jsonc" "/api/%2e%2e/health" "/api/../wrangler.jsonc" "/%00"; do
  c=$(final "$p")
  if [[ "$c" == "404" || "$c" == "400" ]]; then row PASS "traversal $p" "$c"; else row FAIL "traversal $p" "$c"; fi
done
H=$(hdrs /api/nope)
expect "/api/nope -> 404" "$(code GET /api/nope)" 404
has "$H" "content-type: application/json" && row PASS "/api/nope answers JSON" "yes" || row FAIL "/api/nope answers JSON" "$(echo "$H" | grep -i '^content-type' | head -1)"

echo "--- methods and bodies"
expect "PUT /api/health -> 405" "$(code PUT /api/health)" 405
has "$(curl $K -D - -o /dev/null -X PUT "$B/api/health" 2>/dev/null | tr -d '\r')" "allow:" && row PASS "405 carries Allow" "yes" || row FAIL "405 carries Allow" "missing"
expect "POST /api/csp (csp-report) -> 204" "$(csp_post)" 204
BIG=$(mktemp)
head -c 200000 /dev/zero | tr '\0' 'a' > "$BIG"
expect "200 KB form body -> 413" "$(code POST /api/contact -H 'accept: application/json' -H "origin: $B" -H 'content-type: application/x-www-form-urlencoded' --data-binary "@$BIG")" 413
rm -f "$BIG"

if [[ "$LOCAL" == "1" ]]; then
  echo "--- rate limit (CSP_LIMITER: 30 per minute per connection)"
  # One report went out above; a burst of 31 more must meet the limiter, which answers 429 with Retry-After.
  limited=""
  for i in $(seq 1 31); do
    c=$(csp_post)
    if [[ "$c" == "429" ]]; then limited="$i"; break; fi
  done
  if [[ -n "$limited" ]]; then
    row PASS "burst of CSP reports meets a 429" "after $limited more report(s)"
    H=$(curl $K -D - -o /dev/null -X POST "$B/api/csp" -H 'content-type: application/csp-report' -H "origin: $B" --data "$CSP_REPORT" 2>/dev/null | tr -d '\r')
    has "$H" "retry-after: [0-9]+" && row PASS "429 carries Retry-After" "$(echo "$H" | grep -i '^retry-after' | head -1)" || row FAIL "429 carries Retry-After" "missing"
  else
    row FAIL "burst of CSP reports meets a 429" "31 reports answered without a 429 (is CSP_LIMITER bound?)"
  fi
fi

echo
echo "probe: $pass passed, $fail failed"
[[ "$fail" == "0" ]]
