#!/bin/bash
# ============================================================
# Week2 캐시 측정 시드 적용 (data-cache.sql)
# ----------------------------------------------------------
# 사용:
#   FORCE=1 ./scripts/seed.sh                 # 비대화형(스크립트/CI)에서 파괴적 시드 허용
#   ./scripts/seed.sh                         # 대화형: TRUNCATE 확인 프롬프트
# 환경변수로 컨테이너/DB/시드파일 변경 가능:
#   PG_CONTAINER=다른컨테이너 ./scripts/seed.sh
#   SEED_FILE=loadtests/k6/data.sql ./scripts/seed.sh   # 소규모 시드로 교체
#
# 안전장치:
#   - data-cache.sql 은 핵심 테이블을 TRUNCATE 하는 "파괴적" 시드다.
#   - psql 을 ON_ERROR_STOP=1 + --single-transaction 으로 실행한다 →
#     중간에 한 줄이라도 오류면 "전체 롤백"(TRUNCATE 포함)되어 DB가 빈/부분 상태로 남지 않는다.
#   - 성공(psql exit 0)일 때만 완료 메시지를 찍고 카운트를 검증한다. 실패면 non-zero로 종료한다.
#   - 파괴적 실행은 FORCE=1 또는 대화형 y 확인이 있어야만 진행한다.
# ============================================================

set -euo pipefail

# 스크립트 위치 기준으로 k6 디렉토리(상위)를 잡는다 → 어디서 실행해도 경로가 맞는다.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
K6_DIR="$(dirname "$SCRIPT_DIR")"

PG_CONTAINER="${PG_CONTAINER:-pms-order-bteam-postgres-1}"
PG_USER="${PG_USER:-pms}"
PG_DB="${PG_DB:-pms_order}"
SEED_FILE="${SEED_FILE:-$K6_DIR/data-cache.sql}"

# 0) 시드 파일 존재 확인.
if [ ! -f "$SEED_FILE" ]; then
    echo "[시드][중단] 시드 파일을 찾을 수 없습니다: $SEED_FILE" >&2
    exit 1
fi

# 1) 파괴적 실행 가드(핵심 테이블 TRUNCATE). FORCE=1 이면 건너뛴다.
if [ "${FORCE:-0}" != "1" ]; then
    if [ -t 0 ]; then
        read -r -p "[경고] $PG_DB 의 핵심 테이블을 TRUNCATE 후 재시드합니다. 계속? [y/N] " ans
        case "$ans" in
            [yY] | [yY][eE][sS]) ;;
            *) echo "[시드] 취소됨"; exit 1 ;;
        esac
    else
        echo "[시드][중단] 비대화형 실행입니다. 파괴적 시드를 허용하려면 FORCE=1 을 설정하세요." >&2
        echo "            예: FORCE=1 ./scripts/seed.sh" >&2
        exit 1
    fi
fi

# 2) 적용: ON_ERROR_STOP=1 + --single-transaction → 오류 시 전체 롤백(DB 변경 없음).
echo "[시드] $SEED_FILE 적용 중... (대규모 시드는 수십 초~수 분 소요)"
if docker exec -i "$PG_CONTAINER" \
        psql -U "$PG_USER" -d "$PG_DB" -v ON_ERROR_STOP=1 --single-transaction -q < "$SEED_FILE"; then
    echo "[시드] 적용 성공. 카운트 검증:"
    docker exec -i "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -t -A -F' | ' -c \
        "SELECT 'members', count(*) FROM member
         UNION ALL SELECT 'products', count(*) FROM product
         UNION ALL SELECT 'orders', count(*) FROM orders;"
else
    echo "[시드][실패] psql 오류로 시드가 적용되지 않았습니다." >&2
    echo "            --single-transaction 으로 전체 롤백되어 DB는 이전 상태 그대로입니다(빈/부분 시드 아님)." >&2
    echo "            스키마 불일치(컬럼/제약) 등을 확인하세요." >&2
    exit 1
fi
