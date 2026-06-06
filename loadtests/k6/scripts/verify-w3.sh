#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# W3 · 정합성/지표 검증 (관찰 싱크 consumed_events + 큐 깊이 + k6 summary)
# ─────────────────────────────────────────────────────────────────────
# 진실 원천 2개를 대조해 유실·중복·순서·E2E를 "정밀" 계산한다.
#   (P) producer 기대 = k6 --summary-export (w3_expected_* 카운터)
#   (C) consumer 도착 = 앱 consumed_events 테이블
#   + RabbitMQ 큐 잔량(messages_ready)
#
# 서브커맨드:
#   reset                     consumed_events TRUNCATE (측정 윈도우 초기화)
#   compute [summary.json]    유실/중복/순서/E2E 표 출력 (summary 있으면 유실률까지)
#   lag [timeout_sec]         재기동 후 main 큐가 빌 때까지 폴링 → 회복 시간(초)
#   snapshot <label>          큐 깊이 + 컨슈머 카운터 스냅샷 저장(보조)
#
# 환경변수:
#   PG_CONTAINER     기본 pms-order-bteam-postgres-1
#   PG_USER/PG_DB    기본 pms / pms_order
#   RABBIT_MGMT      기본 http://guest:guest@localhost:15672
#   RABBIT_VHOST     기본 %2F
#   PROM_URL         기본 http://localhost:8080/actuator/prometheus
# ─────────────────────────────────────────────────────────────────────

set -euo pipefail

CMD="${1:-compute}"

PG_CONTAINER="${PG_CONTAINER:-pms-order-bteam-postgres-1}"
PG_USER="${PG_USER:-pms}"
PG_DB="${PG_DB:-pms_order}"
RABBIT_MGMT="${RABBIT_MGMT:-http://guest:guest@localhost:15672}"
RABBIT_VHOST="${RABBIT_VHOST:-%2F}"
PROM_URL="${PROM_URL:-http://localhost:8080/actuator/prometheus}"

MAIN_QUEUES=(order.created.queue order.paid.queue order.cancelled.queue)
DLQ_QUEUES=(order.created.dlq order.paid.dlq order.cancelled.dlq)

need() { command -v "$1" >/dev/null 2>&1 || { echo "[ERROR] '$1' 필요" >&2; exit 1; }; }
need curl

psql_q() { docker exec -i "$PG_CONTAINER" psql -tAF'|' -U "$PG_USER" -d "$PG_DB" -c "$1"; }

# 큐의 messages_ready(대기 메시지 수)
q_ready() {
  local resp; resp=$(curl -sS "$RABBIT_MGMT/api/queues/$RABBIT_VHOST/$1" 2>/dev/null || echo '{}')
  if command -v jq >/dev/null 2>&1; then echo "$resp" | jq -r '.messages_ready // 0'
  else echo "$resp" | grep -o '"messages_ready":[0-9]*' | head -1 | cut -d: -f2 || echo 0; fi
}

# 큐의 messages_unacknowledged(컨슈머가 가져갔지만 아직 ack 안 한, 처리 중 메시지)
q_unacked() {
  local resp; resp=$(curl -sS "$RABBIT_MGMT/api/queues/$RABBIT_VHOST/$1" 2>/dev/null || echo '{}')
  if command -v jq >/dev/null 2>&1; then echo "$resp" | jq -r '.messages_unacknowledged // 0'
  else echo "$resp" | grep -o '"messages_unacknowledged":[0-9]*' | head -1 | cut -d: -f2 || echo 0; fi
}

# permille(정수, 천분율)를 "x.y%" 문자열로 (awk 없이)
pct_str() { printf '%d.%d%%' $(( $1 / 10 )) $(( $1 % 10 )); }

# k6 summary-export에서 카운터 값
# 폴백(jq 없을 때): pretty-print JSON이라 공백/개행을 제거해 평탄화 후 "name":{"count":N 추출.
k6_count() { # $1=file $2=metric
  if command -v jq >/dev/null 2>&1; then jq -r ".metrics[\"$2\"].count // 0" "$1" 2>/dev/null || echo 0
  else
    local v
    v=$(tr -d '[:space:]' < "$1" | grep -o "\"$2\":{\"count\":[0-9]*" | grep -oE '[0-9]+$' | head -1)
    echo "${v:-0}"
  fi
}

# ════════════════════════════════════════════════════════════════════
case "$CMD" in

reset)
  psql_q "TRUNCATE consumed_events RESTART IDENTITY;" >/dev/null
  # 이전 윈도우/세션의 잔여 메시지(특히 DLQ)가 residual로 새어들지 않도록 큐를 비운다.
  purged=0
  for q in "${MAIN_QUEUES[@]}" "${DLQ_QUEUES[@]}"; do
    curl -sS -XDELETE "$RABBIT_MGMT/api/queues/$RABBIT_VHOST/$q/contents" >/dev/null 2>&1 && purged=$(( purged + 1 )) || true
  done
  echo "[reset] consumed_events 초기화 + 큐 purge($purged/6) 완료 (측정 윈도우 시작)"
  ;;

lag)
  TIMEOUT="${2:-180}"
  # ready + unacked == 0 이 STABLE_NEED회 "연속"으로 관측돼야 드레인 완료로 본다.
  # (transient 0 — 배치가 잠깐 비거나 prefetch 직전 — 을 회복으로 오인하지 않기 위함)
  STABLE_NEED="${STABLE_NEED:-3}"
  echo "[lag] main 큐 드레인 대기 (ready+unacked==0 ×${STABLE_NEED}연속, timeout=${TIMEOUT}s)…"
  start=$(date +%s); stable=0
  while :; do
    total=0
    for q in "${MAIN_QUEUES[@]}"; do total=$(( total + $(q_ready "$q") + $(q_unacked "$q") )); done
    now=$(date +%s); elapsed=$(( now - start ))
    if [[ "$total" -le 0 ]]; then stable=$(( stable + 1 )); else stable=0; fi
    printf "\r  t=%3ds  main(ready+unacked)=%-6s stable=%d/%d" "$elapsed" "$total" "$stable" "$STABLE_NEED"
    if [[ "$stable" -ge "$STABLE_NEED" ]]; then echo; echo "[lag] ✅ 회복 완료: ${elapsed}s (main 큐 드레인 안정화)"; exit 0; fi
    if [[ "$elapsed" -ge "$TIMEOUT" ]]; then echo; echo "[lag] ⏱️  timeout(${TIMEOUT}s) 도달, 잔량=$total"; exit 1; fi
    sleep 1
  done
  ;;

snapshot)
  LABEL="${2:-snap}"
  OUT="/tmp/w3-${LABEL}.txt"
  {
    echo "# W3 snapshot label=$LABEL ts=$(date '+%F %T')"
    echo "## queue messages_ready"
    for q in "${MAIN_QUEUES[@]}" "${DLQ_QUEUES[@]}"; do echo "$q=$(q_ready "$q")"; done
    echo "## consumer processed counters (prometheus)"
    curl -sS "$PROM_URL" 2>/dev/null | grep '^mq_consumer_processed_total' || echo "(prometheus 미접근)"
  } | tee "$OUT"
  echo "→ 저장: $OUT"
  ;;

compute)
  SUMMARY="${2:-}"
  echo "════════════════════════════════════════════════════════════"
  echo "  W3 정합성/지표 계산  $(date '+%F %T')"
  echo "════════════════════════════════════════════════════════════"

  # ── (C) consumed_events 집계: 한 번의 SQL로 모든 수치 ──
  ROW=$(psql_q "
    WITH per AS (
      SELECT order_id, event_type, MIN(received_at) AS first_recv
      FROM consumed_events GROUP BY order_id, event_type
    ),
    ord AS (
      SELECT order_id,
        MAX(first_recv) FILTER (WHERE event_type='ORDER_CREATED')   AS c,
        MAX(first_recv) FILTER (WHERE event_type='ORDER_PAID')      AS p,
        MAX(first_recv) FILTER (WHERE event_type='ORDER_CANCELLED') AS x
      FROM per GROUP BY order_id
    )
    SELECT
      (SELECT COUNT(*) FROM consumed_events),
      (SELECT COUNT(DISTINCT event_id) FROM consumed_events),
      (SELECT COUNT(*) FROM consumed_events WHERE redelivered),
      (SELECT COUNT(DISTINCT event_id) FROM consumed_events WHERE event_type='ORDER_CREATED'),
      (SELECT COUNT(DISTINCT event_id) FROM consumed_events WHERE event_type='ORDER_PAID'),
      (SELECT COUNT(DISTINCT event_id) FROM consumed_events WHERE event_type='ORDER_CANCELLED'),
      (SELECT COUNT(*) FROM ord WHERE (p IS NOT NULL AND c IS NOT NULL AND p < c)
                                   OR (x IS NOT NULL AND p IS NOT NULL AND x < p)),
      (SELECT COUNT(*) FROM ord WHERE c IS NOT NULL),
      COALESCE((SELECT ROUND(percentile_cont(0.99) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM (received_at - event_timestamp))*1000)::numeric, 1)
        FROM consumed_events WHERE event_timestamp IS NOT NULL), 0);
  " | head -1)

  IFS='|' read -r total distinct redel arr_c arr_p arr_x ord_viol ord_obs e2e_p99 <<< "$ROW"
  total=${total:-0}; distinct=${distinct:-0}; redel=${redel:-0}
  arr_c=${arr_c:-0}; arr_p=${arr_p:-0}; arr_x=${arr_x:-0}
  ord_viol=${ord_viol:-0}; ord_obs=${ord_obs:-0}; e2e_p99=${e2e_p99:-0}
  dup=$(( total - distinct ))

  # ── 큐 잔량(residual) ──
  res_c=$(( $(q_ready order.created.queue)   + $(q_ready order.created.dlq) ))
  res_p=$(( $(q_ready order.paid.queue)      + $(q_ready order.paid.dlq) ))
  res_x=$(( $(q_ready order.cancelled.queue) + $(q_ready order.cancelled.dlq) ))

  echo "  [consumer 도착(C)]  total_rows=$total  distinct=$distinct  redelivered=$redel"
  echo "  [큐 잔량(residual)] created=$res_c  paid=$res_p  cancelled=$res_x"
  echo "────────────────────────────────────────────────────────────"

  if [[ -n "$SUMMARY" && -f "$SUMMARY" ]]; then
    exp_c=$(k6_count "$SUMMARY" w3_expected_created)
    exp_p=$(k6_count "$SUMMARY" w3_expected_paid)
    exp_x=$(k6_count "$SUMMARY" w3_expected_cancelled)
    exp_c=${exp_c%.*}; exp_p=${exp_p%.*}; exp_x=${exp_x%.*}

    lost_c=$(( exp_c - arr_c - res_c )); (( lost_c < 0 )) && lost_c=0
    lost_p=$(( exp_p - arr_p - res_p )); (( lost_p < 0 )) && lost_p=0
    lost_x=$(( exp_x - arr_x - res_x )); (( lost_x < 0 )) && lost_x=0
    exp_total=$(( exp_c + exp_p + exp_x ))
    lost_total=$(( lost_c + lost_p + lost_x ))
    loss_pct=0; (( exp_total > 0 )) && loss_pct=$(( lost_total * 1000 / exp_total ))

    printf "  %-12s %8s %8s %8s %8s\n" "event" "expected" "arrived" "residual" "LOST"
    printf "  %-12s %8d %8d %8d %8d\n" "created"   "$exp_c" "$arr_c" "$res_c" "$lost_c"
    printf "  %-12s %8d %8d %8d %8d\n" "paid"      "$exp_p" "$arr_p" "$res_p" "$lost_p"
    printf "  %-12s %8d %8d %8d %8d\n" "cancelled" "$exp_x" "$arr_x" "$res_x" "$lost_x"
    echo "────────────────────────────────────────────────────────────"
    echo "  🚨 메시지 유실:    $lost_total / $exp_total  ($(pct_str "$loss_pct"))"
  else
    echo "  (summary.json 미지정 → 유실률 생략. arrived/dup/순서/E2E만 표시)"
  fi

  echo "  🔁 중복 처리:      dup=$dup (redelivered=$redel)"
  ord_pct=0; (( ord_obs > 0 )) && ord_pct=$(( ord_viol * 1000 / ord_obs ))
  echo "  🔀 순서 꼬임:      $ord_viol / $ord_obs orders  ($(pct_str "$ord_pct"))"
  echo "  ⏱️  E2E p99:        ${e2e_p99} ms  (received_at − event_timestamp)"
  echo "════════════════════════════════════════════════════════════"
  ;;

*)
  echo "사용법: $0 [reset|compute [summary.json]|lag [timeout]|snapshot <label>]" >&2
  exit 1
  ;;
esac
