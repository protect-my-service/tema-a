#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# W3 · RabbitMQ 장애 주입 (강제 중단 → 재기동)
# ─────────────────────────────────────────────────────────────────────
# 부하 시작 후 고정 시점에 RabbitMQ를 1회 내렸다 올린다. 재현성을 위해
# "언제(OUTAGE_AT)" "얼마나(OUTAGE_SECONDS)" "어떻게(MODE)"를 환경변수로 고정한다.
#
# 사용:
#   ./inject-rabbitmq-outage.sh            # OUTAGE_AT초 대기 후 stop, OUTAGE_SECONDS 뒤 start
#   MODE=pause OUTAGE_AT=20 OUTAGE_SECONDS=10 ./inject-rabbitmq-outage.sh
#
# 환경변수:
#   MODE            : stop(기본, 강제 중단) | pause (프로세스 일시정지)
#   OUTAGE_AT       : 부하 시작 후 주입까지 대기(초). 기본 20
#   OUTAGE_SECONDS  : 중단 지속(초). 기본 10
#   COMPOSE_PROJECT : docker compose 프로젝트명. 기본 pms-order-bteam
#   RABBIT_SERVICE  : compose 서비스명. 기본 rabbitmq
#   RABBIT_CONTAINER: 컨테이너명 직접 지정(자동탐지 실패 시). 기본 pms-order-bteam-rabbitmq-1
# ─────────────────────────────────────────────────────────────────────

set -euo pipefail

MODE="${MODE:-stop}"
OUTAGE_AT="${OUTAGE_AT:-20}"
OUTAGE_SECONDS="${OUTAGE_SECONDS:-10}"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-pms-order-bteam}"
RABBIT_SERVICE="${RABBIT_SERVICE:-rabbitmq}"
RABBIT_CONTAINER="${RABBIT_CONTAINER:-pms-order-bteam-rabbitmq-1}"

# ─── 컨테이너 자동탐지 ──────────────────────────────────────────────
resolve_container() {
  # 1) compose 프로젝트에서 서비스로 조회
  local cid
  cid=$(docker compose -p "$COMPOSE_PROJECT" ps -q "$RABBIT_SERVICE" 2>/dev/null || true)
  if [[ -n "$cid" ]]; then echo "$cid"; return; fi
  # 2) 지정 이름이 존재하면 사용
  if docker inspect "$RABBIT_CONTAINER" >/dev/null 2>&1; then echo "$RABBIT_CONTAINER"; return; fi
  # 3) 이름에 rabbitmq 포함된 실행중 컨테이너
  cid=$(docker ps --filter "name=rabbitmq" --format '{{.ID}}' | head -1 || true)
  if [[ -n "$cid" ]]; then echo "$cid"; return; fi
  echo "";
}

CID="$(resolve_container)"
if [[ -z "$CID" ]]; then
  echo "[ERROR] RabbitMQ 컨테이너를 찾지 못했습니다. RABBIT_CONTAINER로 직접 지정하세요." >&2
  exit 1
fi

down_cmd() { [[ "$MODE" == "pause" ]] && docker pause "$CID" || docker stop "$CID"; }
up_cmd()   { [[ "$MODE" == "pause" ]] && docker unpause "$CID" || docker start "$CID"; }

ts() { date '+%H:%M:%S'; }

echo "[$(ts)] 장애 주입 예약: ${OUTAGE_AT}s 후 MODE=$MODE ${OUTAGE_SECONDS}s 동안 (container=$CID)"
sleep "$OUTAGE_AT"

echo "[$(ts)] ⛔ RabbitMQ $MODE — 발행/소비 단절 시작"
down_cmd >/dev/null
sleep "$OUTAGE_SECONDS"

echo "[$(ts)] ▶️  RabbitMQ 재기동 — 복구 시작 (consumer lag 회복 관찰)"
up_cmd >/dev/null

echo "[$(ts)] 장애 주입 완료. consumed_events / 큐 깊이로 정합성 확인하세요."
