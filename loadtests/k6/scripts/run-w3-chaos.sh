#!/usr/bin/env bash
# ============================================================
# W3 · 장애 주입 실험 (ATK-C03 재현 / Before·After 공용)
# ----------------------------------------------------------
# lifecycle 부하를 흘리면서 고정 시점에 RabbitMQ를 1회 내렸다 올린다.
# 같은 스크립트를 방어 "적용 전(before)"과 "적용 후(after)"에 동일 강도로 돌려
# Before/After를 비교한다. 공정성을 위해 강도·장애 타이밍을 환경변수로 고정한다.
#
# 사용:
#   ./scripts/run-w3-chaos.sh before
#   ./scripts/run-w3-chaos.sh after
#   VUS=40 DURATION=90s OUTAGE_AT=30 OUTAGE_SECONDS=15 ./scripts/run-w3-chaos.sh before
#
# 공정성 고정 권장 변수(before/after 동일하게):
#   VUS DURATION RAMP THINK QTY  /  MODE OUTAGE_AT OUTAGE_SECONDS
# ============================================================
set -euo pipefail

LABEL="${1:-before}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
K6_DIR="$(dirname "$SCRIPT_DIR")"
RESULTS_DIR="$K6_DIR/results"; mkdir -p "$RESULTS_DIR"

BASE_URL="${BASE_URL:-http://localhost:8080}"
TS=$(date +%Y%m%d-%H%M%S)
SUMMARY="$RESULTS_DIR/w3-$LABEL-$TS-summary.json"
RAW="$RESULTS_DIR/w3-$LABEL-$TS.json"
LAG_JSON="$RESULTS_DIR/w3-$LABEL-$TS-lag.json"

# 장애 타이밍 기본값(공정성 위해 명시)
export MODE="${MODE:-stop}"
export OUTAGE_AT="${OUTAGE_AT:-20}"
export OUTAGE_SECONDS="${OUTAGE_SECONDS:-10}"
# lag 측정은 부하+장애+회복을 모두 덮도록 넉넉히.
LAG_DURATION="${LAG_DURATION:-200s}"

echo "[PREFLIGHT] order-lifecycle smoke…"
if ! k6 run -e BASE_URL="$BASE_URL" "$K6_DIR/tests/smoke/order-lifecycle.smoke.js"; then
  echo "[ABORT] smoke 실패 — 앱/시드/RabbitMQ Mgmt 확인. 실험 미실행." >&2
  exit 1
fi

echo "[W3 CHAOS:$LABEL] reset consumed_events…"
"$SCRIPT_DIR/verify-w3.sh" reset

echo "[W3 CHAOS:$LABEL] 강도 VUS=${VUS:-기본} DURATION=${DURATION:-기본} | 장애 MODE=$MODE AT=${OUTAGE_AT}s FOR=${OUTAGE_SECONDS}s"

# (1) 컨슈머 lag 곡선 측정 — 백그라운드
LAG_DURATION="$LAG_DURATION" k6 run --out "json=$LAG_JSON" \
  "$K6_DIR/tests/measure/consumer-lag.js" >/dev/null 2>&1 &
LAGPID=$!

# (2) 장애 주입 — 백그라운드(부하 시작 후 OUTAGE_AT초에 1회)
"$SCRIPT_DIR/inject-rabbitmq-outage.sh" &
OUTPID=$!

# (3) lifecycle 부하 — 포그라운드
k6 run \
  -e BASE_URL="$BASE_URL" \
  ${VUS:+-e VUS="$VUS"} ${DURATION:+-e DURATION="$DURATION"} \
  ${RAMP:+-e RAMP="$RAMP"} ${THINK:+-e THINK="$THINK"} ${QTY:+-e QTY="$QTY"} \
  ${MEMBER_MAX:+-e MEMBER_MAX="$MEMBER_MAX"} ${PRODUCT_MAX:+-e PRODUCT_MAX="$PRODUCT_MAX"} \
  --out "json=$RAW" --summary-export="$SUMMARY" \
  "$K6_DIR/tests/attack/w3-async-order-lifecycle.js" || true

wait "$OUTPID" 2>/dev/null || true

# (4) 재기동 후 잔여 적체 드레인 시간(회복 tail) 측정
#     이 단계가 끝나면 회복 곡선은 이미 lag.json에 기록됐으므로, 남은 LAG_DURATION을
#     끝까지 기다리지 않고 측정기를 종료한다(불필요한 수십~수백 초 대기 방지).
echo "[W3 CHAOS:$LABEL] 컨슈머 lag 회복 시간 측정…"
"$SCRIPT_DIR/verify-w3.sh" lag 180 || true

kill "$LAGPID" 2>/dev/null || true   # k6는 SIGTERM에 graceful stop + 결과 flush
wait "$LAGPID" 2>/dev/null || true

# (5) 정밀 지표 계산
echo "[W3 CHAOS:$LABEL] 지표 계산"
"$SCRIPT_DIR/verify-w3.sh" compute "$SUMMARY"

echo "════════════════════════════════════════════"
echo "결과 RAW : $RAW"
echo "요약     : $SUMMARY"
echo "lag 곡선 : $LAG_JSON"
echo "→ reports/week3-async-ordering.template.md 의 '$LABEL' 칸에 위 수치를 채우세요."
echo "════════════════════════════════════════════"
