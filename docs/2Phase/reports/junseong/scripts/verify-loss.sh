#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# ATK-C03 · 유실 검증 스크립트
# ─────────────────────────────────────────────────────────────────────
# 사용:
#   ./scripts/verify-loss.sh baseline   ← 공격 전 기준값 캡처
#   ./scripts/verify-loss.sh check      ← 공격 후 차이 비교
#
# 기준값은 /tmp/c03-baseline.json 에 저장됨.
#
# 측정 항목:
#   - DB:  C03-NNNN 주문 중 status='CANCELLED' 인 개수
#   - MQ:  order.cancelled.queue 의 message_stats.publish 누적값
#                                  (RabbitMQ Mgmt HTTP API 사용)
#
# 환경변수 (선택):
#   PG_HOST     : 기본 localhost
#   PG_USER     : 기본 pms
#   PG_DB       : 기본 pms_order
#   PG_PASSWORD : 기본 pms1234
#   RABBIT_HOST : 기본 localhost
#   RABBIT_PORT : 기본 15672
#   RABBIT_USER : 기본 guest
#   RABBIT_PASS : 기본 guest
# ─────────────────────────────────────────────────────────────────────

set -euo pipefail

MODE="${1:-check}"

PG_HOST="${PG_HOST:-localhost}"
PG_USER="${PG_USER:-pms}"
PG_DB="${PG_DB:-pms_order}"
PG_PASSWORD="${PG_PASSWORD:-pms1234}"

RABBIT_HOST="${RABBIT_HOST:-localhost}"  # RabbitMQ EC2 IP 로 변경 필요
RABBIT_PORT="${RABBIT_PORT:-15672}"
RABBIT_USER="${RABBIT_USER:-guest}"
RABBIT_PASS="${RABBIT_PASS:-guest}"

BASELINE_FILE="/tmp/c03-baseline.json"

# ─── 사전 체크 ─────────────────────────────────────────────────────
if ! command -v psql >/dev/null 2>&1; then
    echo "[ERROR] psql 이 설치되어 있지 않습니다." >&2
    exit 1
fi
if ! command -v curl >/dev/null 2>&1; then
    echo "[ERROR] curl 이 설치되어 있지 않습니다." >&2
    exit 1
fi

# ─── DB 측정 함수 ──────────────────────────────────────────────────
db_cancelled_count() {
    PGPASSWORD="$PG_PASSWORD" psql -tAh "$PG_HOST" -U "$PG_USER" -d "$PG_DB" -c \
        "SELECT COUNT(*) FROM orders
         WHERE order_number LIKE 'C03-%' AND status='CANCELLED';"
}

# ─── MQ 측정 함수 ──────────────────────────────────────────────────
# RabbitMQ Mgmt HTTP API 의 큐 상세 조회
#   GET /api/queues/%2F/order.cancelled.queue
# 응답 JSON 의 message_stats.publish 가 누적 발행 카운터.
# 큐가 막 생성됐거나 publish 가 0건이면 message_stats 자체가 없을 수 있다.
mq_published_total() {
    local resp
    resp=$(curl -sS -u "$RABBIT_USER:$RABBIT_PASS" \
        "http://$RABBIT_HOST:$RABBIT_PORT/api/queues/%2F/order.cancelled.queue" \
        || echo '{}')
    # jq 없이도 동작하도록 grep 폴백 포함
    if command -v jq >/dev/null 2>&1; then
        echo "$resp" | jq -r '.message_stats.publish // 0'
    else
        echo "$resp" | grep -o '"publish":[0-9]*' | head -1 | cut -d: -f2 || echo 0
    fi
}

mq_dlq_count() {
    local resp
    resp=$(curl -sS -u "$RABBIT_USER:$RABBIT_PASS" \
        "http://$RABBIT_HOST:$RABBIT_PORT/api/queues/%2F/order.cancelled.dlq" \
        || echo '{}')
    if command -v jq >/dev/null 2>&1; then
        echo "$resp" | jq -r '.messages // 0'
    else
        echo "$resp" | grep -o '"messages":[0-9]*' | head -1 | cut -d: -f2 || echo 0
    fi
}

# ─── BASELINE 모드 ──────────────────────────────────────────────────
if [[ "$MODE" == "baseline" ]]; then
    db_count=$(db_cancelled_count)
    mq_pub=$(mq_published_total)
    mq_dlq=$(mq_dlq_count)
    timestamp=$(date '+%Y-%m-%d %H:%M:%S')

    cat > "$BASELINE_FILE" <<EOF
{
  "timestamp":          "$timestamp",
  "db_cancelled_count": $db_count,
  "mq_published_total": $mq_pub,
  "mq_dlq_count":       $mq_dlq
}
EOF

    echo "════════════════════════════════════════"
    echo "  [BASELINE] $timestamp"
    echo "  DB   cancelled (C03-%) : $db_count"
    echo "  MQ   published_total   : $mq_pub"
    echo "  DLQ  message count     : $mq_dlq"
    echo "  → 저장: $BASELINE_FILE"
    echo "════════════════════════════════════════"
    exit 0
fi

# ─── CHECK 모드 ─────────────────────────────────────────────────────
if [[ "$MODE" == "check" ]]; then
    if [[ ! -f "$BASELINE_FILE" ]]; then
        echo "[ERROR] baseline 파일이 없습니다. 먼저 'baseline' 모드로 실행하세요." >&2
        exit 1
    fi

    base_db=$(grep -o '"db_cancelled_count":[ ]*[0-9]*' "$BASELINE_FILE" | tr -dc '0-9')
    base_mq=$(grep -o '"mq_published_total":[ ]*[0-9]*' "$BASELINE_FILE" | tr -dc '0-9')
    base_dlq=$(grep -o '"mq_dlq_count":[ ]*[0-9]*' "$BASELINE_FILE" | tr -dc '0-9')

    cur_db=$(db_cancelled_count)
    cur_mq=$(mq_published_total)
    cur_dlq=$(mq_dlq_count)

    delta_db=$((cur_db  - base_db))
    delta_mq=$((cur_mq  - base_mq))
    delta_dlq=$((cur_dlq - base_dlq))

    loss=$((delta_db - delta_mq))
    if [[ $delta_db -gt 0 ]]; then
        loss_pct=$(( (loss * 100) / delta_db ))
    else
        loss_pct=0
    fi

    echo "════════════════════════════════════════════"
    echo "  [CHECK] $(date '+%Y-%m-%d %H:%M:%S')"
    echo "════════════════════════════════════════════"
    printf "  %-26s %8s %8s %8s\n" "" "BASE" "NOW" "DELTA"
    printf "  %-26s %8d %8d %+8d\n" "DB cancelled (C03-%)"  "$base_db"  "$cur_db"  "$delta_db"
    printf "  %-26s %8d %8d %+8d\n" "MQ published_total"    "$base_mq"  "$cur_mq"  "$delta_mq"
    printf "  %-26s %8d %8d %+8d\n" "DLQ message count"     "$base_dlq" "$cur_dlq" "$delta_dlq"
    echo "────────────────────────────────────────────"
    if [[ $loss -gt 0 ]]; then
        echo "  🚨 메시지 유실 건수: $loss 건 ($loss_pct%)"
        echo "  ✅ 가설 입증: DB 커밋 ≫ MQ 발행"
    elif [[ $loss -eq 0 && $delta_db -gt 0 ]]; then
        echo "  ⚠️  유실 0건. 가설 미입증. 가능한 원인:"
        echo "     - rabbitmq pause 시점이 늦었거나 너무 짧음"
        echo "     - 어딘가에 retry 로직이 있음 (application.yml retry.enabled 확인)"
    else
        echo "  ❌ DB 변경 자체가 없음. seed-c03.sql 와 K6 setup 확인 필요"
    fi
    echo "════════════════════════════════════════════"
    exit 0
fi

echo "사용법: $0 [baseline|check]" >&2
exit 1
