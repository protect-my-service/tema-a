#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# ATK-C03 · 공격 실행 스크립트
# ─────────────────────────────────────────────────────────────────────
# 동작:
#   T= 0s : sudo systemctl stop rabbitmq-server (RabbitMQ EC2)
#   T= 1s : k6 시작
#   T= 6s : k6 종료까지 대기
#   T= 8s : sudo systemctl start rabbitmq-server (RabbitMQ EC2)
#
# 환경변수 (필수):
#   RABBITMQ_HOST     : RabbitMQ EC2 IP 또는 hostname
#   RABBITMQ_SSH_KEY  : SSH 키 경로 (기본 ~/.ssh/a-team-key-pair.pem)
#   RABBITMQ_SSH_USER : SSH 접속 유저 (기본 ec2-user)
#   BASE_URL          : 앱 ALB endpoint (기본 http://pms-order-alb-1379619291.us-east-1.elb.amazonaws.com)
#
# 환경변수 (선택):
#   PAUSE_DURATION_SEC : 기본 6  (stop 유지 시간)
#   K6_SCRIPT          : 기본 k6/c03-cancel-publish-fail.js
# ─────────────────────────────────────────────────────────────────────

set -euo pipefail

RABBITMQ_HOST="${RABBITMQ_HOST:-}"
RABBITMQ_SSH_USER="${RABBITMQ_SSH_USER:-ec2-user}"
RABBITMQ_SSH_KEY="${RABBITMQ_SSH_KEY:-~/.ssh/a-team-key-pair.pem}"
BASE_URL="${BASE_URL:-http://pms-order-alb-1379619291.us-east-1.elb.amazonaws.com}"
PAUSE_DURATION_SEC="${PAUSE_DURATION_SEC:-6}"
K6_SCRIPT="${K6_SCRIPT:-k6/c03-cancel-publish-fail.js}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SCRIPT_DIR"

# ─── 0) 사전 체크 ──────────────────────────────────────────────────
echo "════════════════════════════════════════"
echo "  ATK-C03 공격 시작"
echo "════════════════════════════════════════"

if [[ -z "$RABBITMQ_HOST" ]]; then
    echo "[ERROR] RABBITMQ_HOST 환경변수가 필요합니다." >&2
    echo "        export RABBITMQ_HOST=<rabbitmq-ec2-ip>" >&2
    exit 1
fi

if ! command -v k6 >/dev/null 2>&1; then
    echo "[WARN] k6 가 설치되어 있지 않습니다. docker 로 실행합니다." >&2
    K6_CMD="docker run --rm -i --network host -v $SCRIPT_DIR:/app -w /app grafana/k6 run"
else
    K6_CMD="k6 run"
fi

# SSH 연결 사전 확인
if ! ssh -i "$RABBITMQ_SSH_KEY" -o ConnectTimeout=5 -o BatchMode=yes \
       "$RABBITMQ_SSH_USER@$RABBITMQ_HOST" "echo ok" >/dev/null 2>&1; then
    echo "[ERROR] RabbitMQ EC2 SSH 접속 실패: $RABBITMQ_SSH_USER@$RABBITMQ_HOST" >&2
    echo "        SSH 키 경로: $RABBITMQ_SSH_KEY" >&2
    exit 1
fi

if [[ ! -f "$K6_SCRIPT" ]]; then
    echo "[ERROR] K6 스크립트가 없습니다: $K6_SCRIPT" >&2
    exit 1
fi

# ─── 안전장치: 종료/실패 시 무조건 unpause ───────────────────────────
cleanup() {
    local exit_code=$?
    echo ""
    echo "[CLEANUP] RabbitMQ 재시작 시도..."
    ssh -i "$RABBITMQ_SSH_KEY" "$RABBITMQ_SSH_USER@$RABBITMQ_HOST" \
      "sudo systemctl start rabbitmq-server" 2>/dev/null || true
    echo "[CLEANUP] systemctl start rabbitmq-server → done"
    exit $exit_code
}
trap cleanup EXIT INT TERM

# ─── 1) pause ──────────────────────────────────────────────────────
echo ""
T0=$(date +%H:%M:%S)
echo "[$T0] [C03] [TRIGGER] RabbitMQ 중단 ($RABBITMQ_HOST)"
ssh -i "$RABBITMQ_SSH_KEY" "$RABBITMQ_SSH_USER@$RABBITMQ_HOST" \
  "sudo systemctl stop rabbitmq-server"
sleep 1

# ─── 2) K6 실행 ────────────────────────────────────────────────────
T1=$(date +%H:%M:%S)
echo "[$T1] [C03] [START]   K6 발사 (per-vu-iterations vus=10 iter=5 → 총 50건)"
echo "─────────────────────────────────────────────────────────────────"
set +e
$K6_CMD "$K6_SCRIPT" -e BASE_URL="$BASE_URL"
K6_EXIT=$?
set -e
echo "─────────────────────────────────────────────────────────────────"
T2=$(date +%H:%M:%S)
echo "[$T2] [C03] [SIGNAL]  K6 종료 (exit=$K6_EXIT)"

# pause 시간이 K6 끝난 시점보다 짧으면 K6는 이미 끝났을 수 있음 → 그래도 추가 대기
ELAPSED=$(( $(date +%s) - $(date -d "$T0" +%s 2>/dev/null || echo 0) ))
if [[ $ELAPSED -lt $PAUSE_DURATION_SEC ]]; then
    REMAIN=$((PAUSE_DURATION_SEC - ELAPSED))
    echo "[INFO] pause 유지 추가 ${REMAIN}s..."
    sleep "$REMAIN"
fi

# ─── 3) unpause ────────────────────────────────────────────────────
T3=$(date +%H:%M:%S)
echo "[$T3] [C03] [RECOVER] RabbitMQ 재시작 ($RABBITMQ_HOST)"
ssh -i "$RABBITMQ_SSH_KEY" "$RABBITMQ_SSH_USER@$RABBITMQ_HOST" \
  "sudo systemctl start rabbitmq-server"
sleep 3
ssh -i "$RABBITMQ_SSH_KEY" "$RABBITMQ_SSH_USER@$RABBITMQ_HOST" \
  "sudo systemctl status rabbitmq-server --no-pager | head -5"

# trap 가 cleanup을 다시 호출해도 unpause는 idempotent
trap - EXIT INT TERM

echo ""
echo "════════════════════════════════════════"
echo "  공격 종료 — 다음 단계:"
echo "    ./scripts/verify-loss.sh check"
echo "════════════════════════════════════════"
