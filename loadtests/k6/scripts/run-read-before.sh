#!/bin/bash
# ============================================================
# Week2 · 캐시 적용 전(BEFORE) 조회 폭주 측정
# ----------------------------------------------------------
# 캐시 OFF 상태에서 조회 p99 / RPS / health 지연의 기준선을 수집한다.
# AFTER 와 "동일한 RATE/DURATION"으로 돌려야 비교가 성립한다.
#   → run-read-after.sh 와 같은 RATE/DURATION 을 쓸 것.
# p99 합격선은 적용하지 않는다(적용 전은 느린 게 정상). 단, 정확성 게이트(read_failed_rate)는
# 항상 적용해 잘못된 BASE_URL/시드 누락으로 "에러를 벤치마킹"하는 것을 막는다.
# 본 측정 전에 preflight smoke 로 조회 동작을 먼저 확인하고, 실패하면 벤치마크를 돌리지 않는다.
#
# 사용:
#   ./scripts/run-read-before.sh                 # 결과 파일명 자동(timestamp)
#   ./scripts/run-read-before.sh my-before-tag   # 결과 파일명 접두 인자
# 강도/대상 조절:
#   RATE=300 DURATION=2m TARGET_PRODUCT=1 COLD_RATIO=0.1 ./scripts/run-read-before.sh
# 수비팀 서버 가리키기:
#   BASE_URL=http://수비팀-주소:8080 ./scripts/run-read-before.sh
# ============================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
K6_DIR="$(dirname "$SCRIPT_DIR")"

RATE="${RATE:-200}"
DURATION="${DURATION:-1m}"
TARGET_PRODUCT="${TARGET_PRODUCT:-1}"
COLD_RATIO="${COLD_RATIO:-0.1}"
BASE_URL="${BASE_URL:-http://localhost:8080}"
MODE="${MODE:-steady}"
# Week2 대규모 시드(data-cache.sql) 범위. env.js 기본값(소형 100/50)을 덮어쓴다.
MEMBER_MAX="${MEMBER_MAX:-10000}"
PRODUCT_MAX="${PRODUCT_MAX:-50000}"

SCRIPT="$K6_DIR/tests/attack/a02-product-hotspot-read.js"
RESULTS_DIR="$K6_DIR/results"
mkdir -p "$RESULTS_DIR"

# 결과 파일 접두: 인자로 받으면 그 값, 없으면 'before'. timestamp 는 항상 붙인다.
LABEL="${1:-before}"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
RESULT_FILE="$RESULTS_DIR/read-$LABEL-$TIMESTAMP.json"
SUMMARY_FILE="$RESULTS_DIR/read-$LABEL-$TIMESTAMP-summary.json"

# preflight: 본 측정 전에 조회가 실제로 동작하는지(BASE_URL/시드/엔드포인트) smoke로 확인한다.
# 실패하면 벤치마크를 실행하지 않아 "에러를 벤치마킹한" 잘못된 결과 파일이 생기지 않는다.
echo "[PREFLIGHT] smoke 확인 (BASE_URL/시드/TARGET_PRODUCT)…"
if ! k6 run \
    -e BASE_URL="$BASE_URL" \
    -e TARGET_PRODUCT="$TARGET_PRODUCT" \
    -e MEMBER_MAX="$MEMBER_MAX" \
    -e PRODUCT_MAX="$PRODUCT_MAX" \
    "$K6_DIR/tests/smoke/product-read.smoke.js"; then
    echo "[ABORT] preflight smoke 실패 — BASE_URL/시드(TARGET_PRODUCT 상품 존재)/엔드포인트를 확인하세요." >&2
    echo "        벤치마크를 실행하지 않습니다(잘못된 결과 파일 생성 방지)." >&2
    exit 1
fi
echo "[PREFLIGHT] OK"

echo "============================================================"
echo "[READ BEFORE START] RATE=$RATE DURATION=$DURATION TARGET=$TARGET_PRODUCT COLD_RATIO=$COLD_RATIO MODE=$MODE"
echo "BASE_URL=$BASE_URL"
echo "============================================================"

k6 run \
    -e RATE="$RATE" \
    -e DURATION="$DURATION" \
    -e TARGET_PRODUCT="$TARGET_PRODUCT" \
    -e COLD_RATIO="$COLD_RATIO" \
    -e MODE="$MODE" \
    -e BASE_URL="$BASE_URL" \
    -e MEMBER_MAX="$MEMBER_MAX" \
    -e PRODUCT_MAX="$PRODUCT_MAX" \
    --out "json=$RESULT_FILE" \
    --summary-export="$SUMMARY_FILE" \
    "$SCRIPT"

echo "============================================================"
echo "[READ BEFORE STOP]"
echo "결과: $RESULT_FILE"
echo "요약: $SUMMARY_FILE"
echo "============================================================"
