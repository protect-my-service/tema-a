#!/bin/bash
# ============================================================
# Week2 · 캐시 무효화 지연(Invalidation Lag) 측정
# ----------------------------------------------------------
# 쓰기 ACK ~ 읽기 반영까지 경과(ms)를 측정한다(장바구니 경로).
# 상품 캐시 무효화 엔드포인트가 생기면 폴링 대상만 getProduct 로 교체(스크립트 상단 주석 참고).
#
# 사용:
#   ./scripts/run-invalidation.sh               # 결과 파일명 자동(timestamp)
#   ./scripts/run-invalidation.sh inv-tag       # 결과 파일명 접두 인자
# 조절:
#   ITERATIONS=200 POLL_INTERVAL_MS=20 POLL_TIMEOUT_MS=3000 ./scripts/run-invalidation.sh
# 수비팀 서버 가리키기:
#   BASE_URL=http://수비팀-주소:8080 ./scripts/run-invalidation.sh
# ============================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
K6_DIR="$(dirname "$SCRIPT_DIR")"

ITERATIONS="${ITERATIONS:-100}"
VUS="${VUS:-1}"
POLL_INTERVAL_MS="${POLL_INTERVAL_MS:-20}"
POLL_TIMEOUT_MS="${POLL_TIMEOUT_MS:-3000}"
BASE_URL="${BASE_URL:-http://localhost:8080}"
TARGET_PRODUCT="${TARGET_PRODUCT:-1}"
# Week2 대규모 시드(data-cache.sql) 범위. env.js 기본값(소형 100/50)을 덮어쓴다.
MEMBER_MAX="${MEMBER_MAX:-10000}"
PRODUCT_MAX="${PRODUCT_MAX:-50000}"

# 동시성/재사용 가드(측정 스크립트 init에도 동일 가드 존재 — 여기선 k6 시작 전에 막아 결과 파일 생성 자체를 방지).
# VUS*ITERATIONS 가 회원 수(=MEMBER_MAX, MEMBER_MIN=1 기준)를 넘으면 회원/카트가 재사용되어 측정이 오염된다.
if [ $(( VUS * ITERATIONS )) -gt "$MEMBER_MAX" ]; then
    echo "[ABORT] VUS*ITERATIONS=$(( VUS * ITERATIONS )) > MEMBER_MAX=$MEMBER_MAX → 회원/카트 재사용으로 측정 오염." >&2
    echo "        ITERATIONS/VUS를 줄이거나 MEMBER_MAX를 늘리세요. 측정을 실행하지 않습니다." >&2
    exit 1
fi

SCRIPT="$K6_DIR/tests/measure/cache-invalidation-lag.js"
RESULTS_DIR="$K6_DIR/results"
mkdir -p "$RESULTS_DIR"

LABEL="${1:-invalidation}"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
RESULT_FILE="$RESULTS_DIR/$LABEL-$TIMESTAMP.json"
SUMMARY_FILE="$RESULTS_DIR/$LABEL-$TIMESTAMP-summary.json"

# preflight: 서버/시드/엔드포인트가 정상인지 smoke로 먼저 확인한다.
# 카트 쓰기 자체의 실패는 측정 스크립트의 cart_write_failed_rate 게이트가 추가로 막는다.
echo "[PREFLIGHT] smoke 확인 (BASE_URL/시드/TARGET_PRODUCT)…"
if ! k6 run \
    -e BASE_URL="$BASE_URL" \
    -e TARGET_PRODUCT="$TARGET_PRODUCT" \
    -e MEMBER_MAX="$MEMBER_MAX" \
    -e PRODUCT_MAX="$PRODUCT_MAX" \
    "$K6_DIR/tests/smoke/product-read.smoke.js"; then
    echo "[ABORT] preflight smoke 실패 — BASE_URL/시드/엔드포인트를 확인하세요. 측정을 실행하지 않습니다." >&2
    exit 1
fi
echo "[PREFLIGHT] OK"

echo "============================================================"
echo "[INVALIDATION START] ITERATIONS=$ITERATIONS VUS=$VUS POLL_INTERVAL_MS=$POLL_INTERVAL_MS POLL_TIMEOUT_MS=$POLL_TIMEOUT_MS"
echo "BASE_URL=$BASE_URL"
echo "============================================================"

k6 run \
    -e ITERATIONS="$ITERATIONS" \
    -e VUS="$VUS" \
    -e POLL_INTERVAL_MS="$POLL_INTERVAL_MS" \
    -e POLL_TIMEOUT_MS="$POLL_TIMEOUT_MS" \
    -e BASE_URL="$BASE_URL" \
    -e MEMBER_MAX="$MEMBER_MAX" \
    -e PRODUCT_MAX="$PRODUCT_MAX" \
    --out "json=$RESULT_FILE" \
    --summary-export="$SUMMARY_FILE" \
    "$SCRIPT"

echo "============================================================"
echo "[INVALIDATION STOP]"
echo "결과: $RESULT_FILE"
echo "요약: $SUMMARY_FILE"
echo "============================================================"
