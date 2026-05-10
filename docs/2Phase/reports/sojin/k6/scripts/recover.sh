#!/bin/bash
# ============================================================
# 시나리오 사이 회복 절차
# ----------------------------------------------------------
# 1. 앱/DB 컨테이너 재시작 (HikariCP 풀, 트랜잭션 흔적 초기화)
# 2. 안정화 대기
# 3. 시드 재실행 (DB 데이터 원복)
#
# 사용:
#   ./recover.sh
# ============================================================

set -e

PG_CONTAINER="${PG_CONTAINER:-phase2-postgres-1}"
PG_USER="${PG_USER:-pms}"
PG_DB="${PG_DB:-pms_order}"
SEED_FILE="${SEED_FILE:-tema-a/docs/2Phase/reports/sojin/data/data-attack.sql}"
APP_DIR="${APP_DIR:-pms-order}"

echo "[1/3] 컨테이너 재시작..."
(cd "$APP_DIR" && docker compose restart)

echo "[2/3] 컨테이너 안정화 대기 (5초)..."
sleep 5

echo "[3/3] 시드 재실행..."
docker exec -i "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" < "$SEED_FILE"

echo "[완료] 다음 시나리오 가능"
