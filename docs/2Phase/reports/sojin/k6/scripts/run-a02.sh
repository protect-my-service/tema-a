#!/bin/bash
# ============================================================
# ATK-A02 · 동일 상품 집중 주문 락 경합
# ----------------------------------------------------------
# 사용:
#   ./run-a02.sh
# 강도 조절:
#   RATE=200 DURATION=5m ./run-a02.sh
# 수비팀 서버 가리키기:
#   BASE_URL=http://수비팀-주소:8080 ./run-a02.sh
# Web Dashboard 끄기 (기본 ON, http://127.0.0.1:5665):
#   WEB_DASHBOARD=0 ./run-a02.sh
# ============================================================

set -e

RATE="${RATE:-100}"
DURATION="${DURATION:-3m}"
TARGET_PRODUCT="${TARGET_PRODUCT:-1}"
BASE_URL="${BASE_URL:-http://localhost:8080}"
WEB_DASHBOARD="${WEB_DASHBOARD:-1}"

K6_DIR="${K6_DIR:-tema-a/docs/2Phase/reports/sojin/k6}"
SCRIPT="$K6_DIR/scenrio/a02-hot-row-lock.js"
RESULTS_DIR="$K6_DIR/results"

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
RESULT_FILE="$RESULTS_DIR/a02-$TIMESTAMP.json"
SUMMARY_FILE="$RESULTS_DIR/a02-$TIMESTAMP-summary.json"
DASHBOARD_REPORT="$RESULTS_DIR/a02-$TIMESTAMP-dashboard.html"

mkdir -p "$RESULTS_DIR"

OUT_FLAGS=(--out "json=$RESULT_FILE")
if [ "$WEB_DASHBOARD" = "1" ]; then
    OUT_FLAGS+=(--out web-dashboard)
    export K6_WEB_DASHBOARD_EXPORT="$DASHBOARD_REPORT"
    export K6_WEB_DASHBOARD_OPEN="${K6_WEB_DASHBOARD_OPEN:-true}"
    export K6_WEB_DASHBOARD_PERIOD="${K6_WEB_DASHBOARD_PERIOD:-3s}"
fi

echo "============================================================"
echo "[A02 START] RATE=$RATE  DURATION=$DURATION  TARGET=$TARGET_PRODUCT"
echo "BASE_URL=$BASE_URL"
if [ "$WEB_DASHBOARD" = "1" ]; then
    echo "Web Dashboard: http://127.0.0.1:5665  (HTML: $DASHBOARD_REPORT)"
fi
echo "============================================================"

k6 run \
    -e RATE="$RATE" \
    -e DURATION="$DURATION" \
    -e TARGET_PRODUCT="$TARGET_PRODUCT" \
    -e BASE_URL="$BASE_URL" \
    "${OUT_FLAGS[@]}" \
    --summary-export="$SUMMARY_FILE" \
    "$SCRIPT"

echo "============================================================"
echo "[A02 STOP]"
echo "결과: $RESULT_FILE"
echo "요약: $SUMMARY_FILE"
if [ "$WEB_DASHBOARD" = "1" ]; then
    echo "대시보드: $DASHBOARD_REPORT"
fi
echo "============================================================"
