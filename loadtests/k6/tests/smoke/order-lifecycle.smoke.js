// ─────────────────────────────────────────────────────────────────────
// W3 · 주문 lifecycle 스모크 (preflight)
// ─────────────────────────────────────────────────────────────────────
// 목적: 본 측정(run-w3-*) 전에 cart→order→pay→cancel 전체 흐름과
//       RabbitMQ Management API 접근이 살아있는지 1회로 확인한다.
//       실패하면 러너가 벤치마크를 돌리지 않게 해(에러 벤치마킹 방지).
//
// 한 lifecycle = 이벤트 3종(created→paid→cancelled)을 한 주문(aggregate)에서
// 순서대로 방출한다. 단, 결제는 ~5% 확률로 실패할 수 있고, 그 경우 앱이
// 주문을 자동 취소(CANCELLED) + cancelled 이벤트를 발행하므로 별도 cancel은 생략한다.
//
// 사용:
//   k6 run tests/smoke/order-lifecycle.smoke.js
//   -e VUS=.. 등은 무시(스모크는 1회만 실행). 강도 조절은 attack 스크립트에서.
// ─────────────────────────────────────────────────────────────────────

import http from 'k6/http';
import { check, fail } from 'k6';
import { BASE_URL, QTY, RABBIT_MGMT, RABBIT_VHOST, MAIN_QUEUES } from '../../config/w3.js';
import { postCartItem, postOrder, postPayment, postOrderCancel } from '../../lib/http.js';
import { pickMember, pickProduct } from '../../lib/data.js';

export const options = {
  scenarios: {
    lifecycle_smoke: {
      executor: 'per-vu-iterations',
      vus: 1,
      iterations: 1,
      maxDuration: '30s',
    },
  },
  thresholds: {
    // 스모크는 전 단계가 통과해야 한다(결제 실패 분기 자체는 정상이므로 별도 처리).
    checks: ['rate==1.00'],
  },
};

export default function () {
  const memberId = pickMember();
  const productId = pickProduct();

  // 1) 장바구니 담기 → cartItemId 확보
  const cartRes = postCartItem(memberId, { productId, quantity: QTY });
  const cartOk = check(cartRes, {
    'cart add 2xx': (r) => r.status === 200 || r.status === 201,
  });
  if (!cartOk) {
    fail(`[smoke] cart add 실패 member=${memberId} product=${productId} status=${cartRes.status} body=${cartRes.body?.substring(0, 200)} — BASE_URL/시드 확인`);
  }
  const cartItemId = JSON.parse(cartRes.body).cartItemId;

  // 2) 주문 생성 → orderId 확보 (POST /orders는 201 Created)
  const orderRes = postOrder(memberId, { cartItemIds: [cartItemId] });
  check(orderRes, { 'order create 201': (r) => r.status === 201 });
  if (orderRes.status !== 201) {
    fail(`[smoke] order create 실패 status=${orderRes.status} body=${orderRes.body?.substring(0, 200)}`);
  }
  const orderId = JSON.parse(orderRes.body).orderId;

  // 3) 결제 (성공 200 → PAID, 실패 ~5% → 앱이 자동 취소)
  const payRes = postPayment(memberId, orderId);
  const paid = payRes.status === 200;
  check(payRes, {
    // 200(승인) 또는 4xx/5xx(결제 실패→자동취소) 둘 다 "예상된" 결과다.
    'payment resolved': (r) => r.status === 200 || (r.status >= 400 && r.status < 600),
  });

  // 4) 결제 성공분만 취소 (실패분은 이미 CANCELLED)
  if (paid) {
    const cancelRes = postOrderCancel(memberId, orderId, { reason: 'W3 smoke' });
    check(cancelRes, {
      'cancel 200 + CANCELLED': (r) => r.status === 200 && r.body && r.body.includes('CANCELLED'),
    });
  }

  // 5) RabbitMQ Management API 접근 확인 (verify/measure 사전 점검)
  const q = encodeURIComponent(MAIN_QUEUES[0]);
  const mgmtRes = http.get(`${RABBIT_MGMT}/api/queues/${RABBIT_VHOST}/${q}`);
  check(mgmtRes, {
    'rabbitmq mgmt api 200': (r) => r.status === 200,
  });
  if (mgmtRes.status !== 200) {
    fail(`[smoke] RabbitMQ Management API 접근 실패 status=${mgmtRes.status} (RABBIT_MGMT=${RABBIT_MGMT}). docker compose의 rabbitmq:3-management와 :15672 확인.`);
  }

  console.log(`[smoke] OK member=${memberId} order=${orderId} paid=${paid}`);
}
