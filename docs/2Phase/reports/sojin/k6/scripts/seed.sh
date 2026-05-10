#!/bin/bash
# ============================================================
# 김소진 시드 데이터 실행
# ----------------------------------------------------------
# 사용:
#   ./seed.sh
# 환경변수로 컨테이너/DB 변경 가능:
#   PG_CONTAINER=다른컨테이너 ./seed.sh
# ============================================================

set -e  # 에러 발생 시 즉시 종료

PG_CONTAINER="${PG_CONTAINER:-pms-order-bteam-postgres-1}"
PG_USER="${PG_USER:-pms}"
PG_DB="${PG_DB:-pms_order}"
SEED_FILE="${SEED_FILE:-tema-a/docs/2Phase/reports/sojin/data/data-attack.sql}"

echo "[시드] $SEED_FILE 실행 중..."
docker exec -i "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" < "$SEED_FILE"
echo "[시드] 완료 (회원 1000 / 핫상품 P1·P2 / PAID 주문 400)"
