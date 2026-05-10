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
# ============================================================

set -e

DURATION="${DURATION:-30s}"
BASE_URL="${BASE_URL:-http://localhost:8080}"

K6_DIR="${K6_DIR:-tema-a/loadtests/k6}"
SCRIPT="$K6_DIR/scenrio/a05-cancel-deadlock.js"
RESULTS_DIR="$K6_DIR/results"

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
RESULT_FILE="$RESULTS_DIR/a05-$TIMESTAMP.json"
SUMMARY_FILE="$RESULTS_DIR/a05-$TIMESTAMP-summary.json"

mkdir -p "$RESULTS_DIR"

echo "============================================================"
echo "[A05 START] DURATION=$DURATION  group_xy(P1→P2) + group_yx(P2→P1)"
echo "BASE_URL=$BASE_URL"
echo "============================================================"

k6 run \
    -e DURATION="$DURATION" \
    -e BASE_URL="$BASE_URL" \
    --out json="$RESULT_FILE" \
    --summary-export="$SUMMARY_FILE" \
    "$SCRIPT"

echo "============================================================"
echo "[A05 STOP]"
echo "결과: $RESULT_FILE"
echo "요약: $SUMMARY_FILE"
echo "============================================================"
