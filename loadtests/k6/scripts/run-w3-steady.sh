#!/usr/bin/env bash
# ============================================================
# W3 · 정상(무장애) 기준선 측정
# ----------------------------------------------------------
# 장애 없이 lifecycle 부하만 흘려, "정상이면 유실 0 / 순서위반 0"과
# E2E p99 기준값을 얻는다. 본 측정(run-w3-chaos) 전에 베이스라인 신뢰성 확인용.
#
# 사용:
#   ./scripts/run-w3-steady.sh
#   VUS=40 DURATION=90s THINK=0.2 ./scripts/run-w3-steady.sh
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
K6_DIR="$(dirname "$SCRIPT_DIR")"
RESULTS_DIR="$K6_DIR/results"; mkdir -p "$RESULTS_DIR"

BASE_URL="${BASE_URL:-http://localhost:8080}"
TS=$(date +%Y%m%d-%H%M%S)
SUMMARY="$RESULTS_DIR/w3-steady-$TS-summary.json"
RAW="$RESULTS_DIR/w3-steady-$TS.json"

echo "[PREFLIGHT] order-lifecycle smoke…"
if ! k6 run -e BASE_URL="$BASE_URL" "$K6_DIR/tests/smoke/order-lifecycle.smoke.js"; then
  echo "[ABORT] smoke 실패 — 앱/시드/RabbitMQ Mgmt 확인. 벤치마크 미실행." >&2
  exit 1
fi

echo "[W3 STEADY] reset consumed_events…"
"$SCRIPT_DIR/verify-w3.sh" reset

echo "[W3 STEADY] lifecycle 부하 (무장애)…"
k6 run \
  -e BASE_URL="$BASE_URL" \
  ${VUS:+-e VUS="$VUS"} ${DURATION:+-e DURATION="$DURATION"} \
  ${RAMP:+-e RAMP="$RAMP"} ${THINK:+-e THINK="$THINK"} ${QTY:+-e QTY="$QTY"} \
  ${MEMBER_MAX:+-e MEMBER_MAX="$MEMBER_MAX"} ${PRODUCT_MAX:+-e PRODUCT_MAX="$PRODUCT_MAX"} \
  --out "json=$RAW" --summary-export="$SUMMARY" \
  "$K6_DIR/tests/attack/w3-async-order-lifecycle.js"

# 소비가 끝까지 따라잡도록 잠깐 대기 후 계산
echo "[W3 STEADY] 소비 드레인 대기…"
"$SCRIPT_DIR/verify-w3.sh" lag 60 || true

echo "[W3 STEADY] 지표 계산"
"$SCRIPT_DIR/verify-w3.sh" compute "$SUMMARY"
echo "결과: $RAW"
echo "요약: $SUMMARY"
echo "기대(무장애): 유실 0 / 중복 0. 0이 아니면 강도↓ 또는 환경 점검."
echo "  ※ 순서 꼬임은 무장애에도 >0일 수 있다 — created/paid/cancelled가 3개 큐에서 동시"
echo "     소비되며 시뮬 지연이 달라 같은 주문 내 순서가 뒤집힌다. 이게 본 실습의 핵심 관찰점."
