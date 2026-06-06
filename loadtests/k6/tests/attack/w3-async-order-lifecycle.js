// ─────────────────────────────────────────────────────────────────────
// W3 · 비동기 주문 lifecycle 부하 (방어 비종속 베이스라인)
// ─────────────────────────────────────────────────────────────────────
// 한 iteration = 한 주문(aggregate)의 cart→order→pay→cancel 전체.
// 한 주문이 created→paid→cancelled 3 이벤트를 "순서대로" 방출하므로,
// 동시성 + RabbitMQ 장애 주입 하에서 유실·중복·순서 꼬임이 동시에 드러난다.
//
// 이 스크립트는 부하만 만든다. 수치(유실/중복/순서/lag/e2e)는 verify-w3.sh가
//   (P) producer 진실 = 아래 커스텀 카운터(--summary-export로 내보냄)
//   (C) consumer 진실 = 앱 consumed_events 테이블
//   + RabbitMQ 큐 깊이
// 를 대조해 계산한다.
//
// producer 진실 카운터(= "발행됐어야 할 이벤트 수" — 커밋되어 실제 발행되는 것만 센다):
//   - 주문 생성 201            → w3_expected_created +1
//   - 결제 성공 200            → w3_expected_paid +1
//   - 수동 취소 200            → w3_expected_cancelled +1
//   ※ 결제 실패(~5%)는 세지 않는다: PaymentService가 같은 @Transactional 안에서 재throw 하므로
//     트랜잭션이 롤백되고(AFTER_COMMIT 미발생) cancelled 이벤트가 발행되지 않으며, 주문은
//     PENDING에 잔류한다. 발행되지 않은 이벤트를 expected로 세면 "가짜 유실"이 잡힌다.
//   ※ HTTP가 200이어도 AFTER_COMMIT 발행이 (장애 중) 조용히 실패하면 메시지는 유실된다.
//     그건 커밋은 됐으나 발행만 실패한 경우라 expected에 포함된다 → verify가 유실로 잡아낸다.
//
// 사용:
//   k6 run tests/attack/w3-async-order-lifecycle.js
//   VUS=40 DURATION=90s THINK=0.2 k6 run --summary-export results/w3-before-summary.json \
//       tests/attack/w3-async-order-lifecycle.js
// ─────────────────────────────────────────────────────────────────────

import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { VUS, DURATION, RAMP, THINK, QTY, w3Thresholds } from '../../config/w3.js';
import { postCartItem, postOrder, postPayment, postOrderCancel } from '../../lib/http.js';
import { pickMember, pickProduct } from '../../lib/data.js';

// ─── producer 진실 카운터 ──────────────────────────────────────────────
const expectedCreated   = new Counter('w3_expected_created');
const expectedPaid      = new Counter('w3_expected_paid');
const expectedCancelled = new Counter('w3_expected_cancelled');

// ─── 보조 카운터/지연 ──────────────────────────────────────────────────
const lifecycleFull   = new Counter('w3_lifecycle_full');     // create→pay→cancel 완주
const paymentFailed   = new Counter('w3_payment_failed');     // 결제 실패(자동취소) 분기
const stepError       = new Counter('w3_step_error');         // 예기치 못한 단계 실패
const createMs = new Trend('w3_create_ms', true);
const payMs    = new Trend('w3_pay_ms', true);
const cancelMs = new Trend('w3_cancel_ms', true);

export const options = {
  scenarios: {
    w3_lifecycle: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: RAMP, target: VUS },
        { duration: DURATION, target: VUS },
        { duration: RAMP, target: 0 },
      ],
      tags: { scenario: 'W3', stage: 'attack' },
    },
  },
  thresholds: { ...w3Thresholds },
};

export default function () {
  const memberId = pickMember();
  const productId = pickProduct();

  // 1) cart add
  const cartRes = postCartItem(memberId, { productId, quantity: QTY });
  if (cartRes.status !== 200 && cartRes.status !== 201) {
    stepError.add(1);
    sleep(THINK);
    return;
  }
  let cartItemId;
  try {
    cartItemId = JSON.parse(cartRes.body).cartItemId;
  } catch (e) {
    stepError.add(1);
    sleep(THINK);
    return;
  }

  // 2) order create (201)
  const t0 = Date.now();
  const orderRes = postOrder(memberId, { cartItemIds: [cartItemId] });
  createMs.add(Date.now() - t0);
  const created = check(orderRes, { 'order 201': (r) => r.status === 201 });
  if (!created) {
    stepError.add(1);
    sleep(THINK);
    return;
  }
  expectedCreated.add(1); // OrderCreatedEvent 발행 기대
  const orderId = JSON.parse(orderRes.body).orderId;

  // 3) payment (성공 200 → paid 이벤트 / 실패 ~5% → 앱이 자동취소 + cancelled 이벤트)
  const t1 = Date.now();
  const payRes = postPayment(memberId, orderId);
  payMs.add(Date.now() - t1);
  if (payRes.status === 200) {
    expectedPaid.add(1); // OrderPaidEvent 발행 기대

    // 4) manual cancel (PAID → CANCELLED)
    const t2 = Date.now();
    const cancelRes = postOrderCancel(memberId, orderId, { reason: 'W3 lifecycle' });
    cancelMs.add(Date.now() - t2);
    const cancelled = check(cancelRes, { 'cancel 200': (r) => r.status === 200 });
    if (cancelled) {
      expectedCancelled.add(1); // OrderCancelledEvent 발행 기대
      lifecycleFull.add(1);
    } else {
      stepError.add(1);
    }
  } else {
    // 결제 실패(~5%) = 정상 시나리오의 일부. 단, 앱의 자동취소는 같은 트랜잭션에서
    // 롤백되어 cancelled 이벤트가 "발행되지 않는다"(주문은 PENDING 잔류). expected에 더하지 않는다.
    paymentFailed.add(1);
  }

  sleep(THINK);
}
