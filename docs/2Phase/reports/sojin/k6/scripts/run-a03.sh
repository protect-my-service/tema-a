#!/bin/bash
# ============================================================
# ATK-A03 · 락 대기 누적 → 커넥션 풀 고갈
# ----------------------------------------------------------
# A03 은 ramping-arrival-rate (RPS 단계 상승) 이라 stages 가
# .js 안에 박혀있음. 강도 조절은 RATE 보다 BASE_URL 만 조정.
#
# 사용:
#   ./run-a03.sh
# 수비팀 서버 가리키기:
#   BASE_URL=http://수비팀-주소:8080 ./run-a03.sh
# Web Dashboard 끄기 (기본 ON, http://127.0.0.1:5665):
#   WEB_DASHBOARD=0 ./run-a03.sh
# ============================================================

set -e

TARGET_PRODUCT="${TARGET_PRODUCT:-1}"
BASE_URL="${BASE_URL:-http://localhost:8080}"
WEB_DASHBOARD="${WEB_DASHBOARD:-1}"

K6_DIR="${K6_DIR:-tema-a/docs/2Phase/reports/sojin/k6}"
SCRIPT="$K6_DIR/scenrio/a03-pool-exhaustion.js"
RESULTS_DIR="$K6_DIR/results"

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
RESULT_FILE="$RESULTS_DIR/a03-$TIMESTAMP.json"
SUMMARY_FILE="$RESULTS_DIR/a03-$TIMESTAMP-summary.json"
DASHBOARD_REPORT="$RESULTS_DIR/a03-$TIMESTAMP-dashboard.html"

mkdir -p "$RESULTS_DIR"

OUT_FLAGS=(--out "json=$RESULT_FILE")
if [ "$WEB_DASHBOARD" = "1" ]; then
    OUT_FLAGS+=(--out web-dashboard)
    export K6_WEB_DASHBOARD_EXPORT="$DASHBOARD_REPORT"
    export K6_WEB_DASHBOARD_OPEN="${K6_WEB_DASHBOARD_OPEN:-true}"
    export K6_WEB_DASHBOARD_PERIOD="${K6_WEB_DASHBOARD_PERIOD:-3s}"
fi

echo "============================================================"
echo "[A03 START] RPS 50 → 100 → 150 → 200 단계 상승  TARGET=$TARGET_PRODUCT"
echo "BASE_URL=$BASE_URL"
if [ "$WEB_DASHBOARD" = "1" ]; then
    echo "Web Dashboard: http://127.0.0.1:5665  (HTML: $DASHBOARD_REPORT)"
fi
echo "============================================================"

k6 run \
    -e TARGET_PRODUCT="$TARGET_PRODUCT" \
    -e BASE_URL="$BASE_URL" \
    "${OUT_FLAGS[@]}" \
    --summary-export="$SUMMARY_FILE" \
    "$SCRIPT"

echo "============================================================"
echo "[A03 STOP]"
echo "결과: $RESULT_FILE"
echo "요약: $SUMMARY_FILE"
if [ "$WEB_DASHBOARD" = "1" ]; then
    echo "대시보드: $DASHBOARD_REPORT"
fi
echo "============================================================"
