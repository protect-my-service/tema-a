#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# ATK-C03 · 데이터 정리 스크립트
# ─────────────────────────────────────────────────────────────────────
# 사용:
#   ./scripts/reset-data.sh
#
# 동작:
#   1) C03 시드 데이터 (orders, order_item, payment) 삭제
#   2) order.cancelled.queue 와 order.cancelled.dlq 비우기 (Mgmt API)
#   3) /tmp/c03-baseline.json 삭제 (다음 시나리오 baseline 충돌 방지)
#
# 환경변수:
#   PG_HOST     : 기본 localhost
#   PG_USER     : 기본 pms
#   PG_DB       : 기본 pms_order
#   PG_PASSWORD : 기본 pms1234
#   RABBIT_HOST : RabbitMQ EC2 IP (기본 localhost)
#   RABBIT_PORT : 기본 15672
#   RABBIT_USER : 기본 guest
#   RABBIT_PASS : 기본 guest
# ─────────────────────────────────────────────────────────────────────

set -euo pipefail

PG_HOST="${PG_HOST:-localhost}"
PG_USER="${PG_USER:-pms}"
PG_DB="${PG_DB:-pms_order}"
PG_PASSWORD="${PG_PASSWORD:-pms1234}"

RABBIT_HOST="${RABBIT_HOST:-localhost}"
RABBIT_PORT="${RABBIT_PORT:-15672}"
RABBIT_USER="${RABBIT_USER:-guest}"
RABBIT_PASS="${RABBIT_PASS:-guest}"

echo "════════════════════════════════════════"
echo "  ATK-C03 데이터 정리"
echo "════════════════════════════════════════"

# 1) DB 정리
echo "[1/3] DB C03-% 데이터 삭제..."
PGPASSWORD="$PG_PASSWORD" psql -h "$PG_HOST" -U "$PG_USER" -d "$PG_DB" <<'SQL'
BEGIN;
DELETE FROM payment WHERE payment_key LIKE 'C03-PAY-%';
DELETE FROM order_item WHERE order_id IN (
    SELECT id FROM orders WHERE order_number LIKE 'C03-%'
);
DELETE FROM orders WHERE order_number LIKE 'C03-%';
COMMIT;
SQL
echo "      → done"

# 2) RabbitMQ 큐 비우기 (Mgmt HTTP API)
echo "[2/3] RabbitMQ 큐 비우기 ($RABBIT_HOST:$RABBIT_PORT)..."
for queue in "order.cancelled.queue" "order.cancelled.dlq"; do
    encoded=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$queue', safe=''))" 2>/dev/null || echo "$queue")
    http_code=$(curl -sS -o /dev/null -w "%{http_code}" \
        -X DELETE \
        -u "$RABBIT_USER:$RABBIT_PASS" \
        "http://$RABBIT_HOST:$RABBIT_PORT/api/queues/%2F/$encoded/contents" 2>/dev/null || echo "000")
    if [[ "$http_code" == "204" || "$http_code" == "200" ]]; then
        echo "      → $queue 비움 완료"
    else
        echo "      → $queue 비우기 실패 (HTTP $http_code) — 수동 확인 필요"
    fi
done

# 3) baseline 파일 삭제
echo "[3/3] baseline 파일 삭제..."
rm -f /tmp/c03-baseline.json
echo "      → done"

echo ""
echo "✅ 정리 완료. 다음 시나리오 진행 가능."
