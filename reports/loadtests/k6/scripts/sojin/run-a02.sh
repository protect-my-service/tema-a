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
# ============================================================

set -e

RATE="${RATE:-100}"
DURATION="${DURATION:-3m}"
TARGET_PRODUCT="${TARGET_PRODUCT:-1}"
BASE_URL="${BASE_URL:-http://localhost:8080}"

K6_DIR="${K6_DIR:-tema-a/reports/loadtests/k6}"
SCRIPT="$K6_DIR/scenrio/a02-hot-row-lock.js"
RESULTS_DIR="$K6_DIR/results"

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
RESULT_FILE="$RESULTS_DIR/a02-$TIMESTAMP.json"
SUMMARY_FILE="$RESULTS_DIR/a02-$TIMESTAMP-summary.json"

mkdir -p "$RESULTS_DIR"

echo "============================================================"
echo "[A02 START] RATE=$RATE  DURATION=$DURATION  TARGET=$TARGET_PRODUCT"
echo "BASE_URL=$BASE_URL"
echo "============================================================"

k6 run \
    -e RATE="$RATE" \
    -e DURATION="$DURATION" \
    -e TARGET_PRODUCT="$TARGET_PRODUCT" \
    -e BASE_URL="$BASE_URL" \
    --out json="$RESULT_FILE" \
    --summary-export="$SUMMARY_FILE" \
    "$SCRIPT"

echo "============================================================"
echo "[A02 STOP]"
echo "결과: $RESULT_FILE"
echo "요약: $SUMMARY_FILE"
echo "============================================================"
