#!/bin/bash
# ============================================================
# ATK-A05 · 락 획득 순서 교차 데드락
# ----------------------------------------------------------
# 두 그룹(group_xy / group_yx) 이 반대 순서로 cancel 호출.
# 시드 PAID 주문 400 건 안에서 30초 권장.
#
# 사용:
#   ./run-a05.sh
# 시간 조절:
#   DURATION=15s ./run-a05.sh   (시드 부족 시)
# 수비팀 서버 가리키기:
#   BASE_URL=http://수비팀-주소:8080 ./run-a05.sh
# Web Dashboard 끄기 (기본 ON, http://127.0.0.1:5665):
#   WEB_DASHBOARD=0 ./run-a05.sh
# ============================================================

set -e

DURATION="${DURATION:-30s}"
BASE_URL="${BASE_URL:-http://localhost:8080}"
WEB_DASHBOARD="${WEB_DASHBOARD:-1}"

K6_DIR="${K6_DIR:-tema-a/docs/2Phase/reports/sojin/k6}"
SCRIPT="$K6_DIR/scenrio/a05-cancel-deadlock.js"
RESULTS_DIR="$K6_DIR/results"

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
RESULT_FILE="$RESULTS_DIR/a05-$TIMESTAMP.json"
SUMMARY_FILE="$RESULTS_DIR/a05-$TIMESTAMP-summary.json"
DASHBOARD_REPORT="$RESULTS_DIR/a05-$TIMESTAMP-dashboard.html"

mkdir -p "$RESULTS_DIR"

OUT_FLAGS=(--out "json=$RESULT_FILE")
if [ "$WEB_DASHBOARD" = "1" ]; then
    OUT_FLAGS+=(--out web-dashboard)
    export K6_WEB_DASHBOARD_EXPORT="$DASHBOARD_REPORT"
    export K6_WEB_DASHBOARD_OPEN="${K6_WEB_DASHBOARD_OPEN:-true}"
    export K6_WEB_DASHBOARD_PERIOD="${K6_WEB_DASHBOARD_PERIOD:-3s}"
fi

echo "============================================================"
echo "[A05 START] DURATION=$DURATION  group_xy(P1→P2) + group_yx(P2→P1)"
echo "BASE_URL=$BASE_URL"
if [ "$WEB_DASHBOARD" = "1" ]; then
    echo "Web Dashboard: http://127.0.0.1:5665  (HTML: $DASHBOARD_REPORT)"
fi
echo "============================================================"

k6 run \
    -e DURATION="$DURATION" \
    -e BASE_URL="$BASE_URL" \
    "${OUT_FLAGS[@]}" \
    --summary-export="$SUMMARY_FILE" \
    "$SCRIPT"

echo "============================================================"
echo "[A05 STOP]"
echo "결과: $RESULT_FILE"
echo "요약: $SUMMARY_FILE"
if [ "$WEB_DASHBOARD" = "1" ]; then
    echo "대시보드: $DASHBOARD_REPORT"
fi
echo "============================================================"
