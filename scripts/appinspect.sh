#!/usr/bin/env bash
# Run Splunk AppInspect on a built package with the check sets Splunk Cloud
# vetting uses. Fails if any check reports a failure or error; warnings are
# listed but do not fail. JSON reports go to the report directory.
# Usage: scripts/appinspect.sh <package.spl> [report-dir]
# Needs: pip install splunk-appinspect   (use a virtualenv; see README)
set -euo pipefail

pkg=${1:?usage: scripts/appinspect.sh <package.spl> [report-dir]}
report_dir=${2:-dist/appinspect}
command -v splunk-appinspect >/dev/null || { echo "error: splunk-appinspect not found" >&2; exit 1; }
mkdir -p "$report_dir"

status=0
for tag in cloud private_victoria private_classic; do
  report="$report_dir/$tag.json"
  splunk-appinspect inspect "$pkg" --mode precert --included-tags "$tag" \
    --data-format json --output-file "$report" >/dev/null
  python3 - "$report" "$tag" <<'EOF' || status=1
import json, sys
report, tag = sys.argv[1], sys.argv[2]
r = json.load(open(report))["reports"][0]
s = r["summary"]
print(f"{tag}: {s['success']} passed, {s['failure']} failed, {s['error']} errors, "
      f"{s['future_failure']} future failures, {s['warning']} warnings")
bad = False
for group in r["groups"]:
    for check in group["checks"]:
        result = check["result"]
        if result not in ("failure", "error", "future_failure", "warning"):
            continue
        print(f"  [{result}] {check['name']}")
        if result in ("failure", "error", "future_failure"):
            for m in check["messages"]:
                where = m.get("message_filename") or ""
                line = m.get("message_line")
                print(f"      {where}{':' + str(line) if line else ''} {m.get('message', '').strip()}")
        bad = bad or result in ("failure", "error")
sys.exit(1 if bad else 0)
EOF
done
exit $status
