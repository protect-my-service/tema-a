// W3 비동기 순서 보장 실습 전용 설정.
//
// ⚠ 공유 config/env.js의 기본값은 절대 건드리지 않는다(1주차/Week2 회귀 방지).
//   여기 값들은 W3 스크립트(tests/{smoke,attack,measure}/w3-*, scripts/run-w3-*)에서만 import한다.
//   기존 시드(회원 100 / 상품 50)와 호환되도록 MEMBERS/PRODUCTS는 env.js 기본값을 그대로 쓴다.

import { BASE_URL, MEMBERS, PRODUCTS } from './env.js';

export { BASE_URL, MEMBERS, PRODUCTS };

// ─── RabbitMQ Management API (verify/measure에서 큐 깊이 조회) ───────────
// 형식: http://user:pass@host:port  (기본 guest/guest, 로컬 docker compose)
export const RABBIT_MGMT = __ENV.RABBIT_MGMT || 'http://guest:guest@localhost:15672';
export const RABBIT_VHOST = __ENV.RABBIT_VHOST || '%2F'; // 기본 vhost "/"

// 측정 대상 큐(메인 3 + DLQ 3). 앱 RabbitMQConfig 상수와 1:1.
export const MAIN_QUEUES = ['order.created.queue', 'order.paid.queue', 'order.cancelled.queue'];
export const DLQ_QUEUES = ['order.created.dlq', 'order.paid.dlq', 'order.cancelled.dlq'];

// ─── lifecycle 부하 강도/페이싱 ─────────────────────────────────────────
// 재고 고갈 방지를 위해 기본 강도는 보수적으로. 강하게 돌리려면 -e VUS/DURATION으로 연다.
export const VUS = parseInt(__ENV.VUS || '20', 10);
export const DURATION = __ENV.DURATION || '60s';
export const RAMP = __ENV.RAMP || '5s';
export const THINK = parseFloat(__ENV.THINK || '0.3'); // iteration 간 think time(초)
export const QTY = parseInt(__ENV.QTY || '1', 10);     // 주문 수량(소량 고정)

// ─── consumer-lag measure 폴링 주기/지속 ────────────────────────────────
export const LAG_POLL_SECONDS = parseFloat(__ENV.LAG_POLL || '1');
export const LAG_DURATION = __ENV.LAG_DURATION || '180s';

// ─── 공통 threshold ────────────────────────────────────────────────────
// 공격/장애 주입 런이므로 느슨하게. 정확성은 verify-w3.sh가 별도로 판정한다.
export const w3Thresholds = {
  // HTTP 발행단(주문/결제/취소)이 5xx로 무너지지 않는지만 본다.
  // (메시지 유실은 HTTP가 200이어도 발생하므로 여기서 잡지 않는다 — verify가 잡는다.)
  http_req_failed: ['rate<0.95'],
};
