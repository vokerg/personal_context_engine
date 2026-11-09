#!/usr/bin/env bash
# Root-owned Certbot deploy hook; run only after a successful certificate renewal.
set -euo pipefail
/usr/sbin/nginx -t
/usr/bin/systemctl reload nginx.service
