import { check, sleep } from "k6";
import http from "k6/http";
import { Counter, Rate, Trend } from "k6/metrics";
import { BASE_URL, baseThresholds } from "../../../config/env.js";
import { getHealth } from "../../../lib/http.js";

// ============================================================
// ATK-A05 · 락 획득 순서 교차 데드락
// ----------------------------------------------------------
// 가설: 두 트랜잭션이 같은 두 상품(P1, P2)을 *반대 순서*로 잡으려 하면
//       wait-for cycle 형성 → PostgreSQL이 SQLSTATE=40P01 로 한 쪽 강제 롤백.
// 시드: data-attack.sql (PAID 주문 1~400, 각 주문에 P1+P2 OrderItem 보유)
//   - orderId N의 OrderItemId: P1=N, P2=N+400 (시드 INSERT 규칙)
//   - memberId = ((orderId - 1) % 1000) + 1
// 실행 예: k6 run a05-cancel-deadlock.js
// ============================================================

const SLEEP_SECONDS = parseFloat(__ENV.SLEEP || '1');
const HEALTH_SLEEP_SECONDS = parseFloat(__ENV.HEALTH_SLEEP || '1');
const DURATION = __ENV.DURATION || '30s'; // 시드 PAID 주문이 400건이라 짧게 운영

const cancelLatency = new Trend('cancel_latency_ms', true);
const cancelFailed = new Rate('cancel_failed_rate');
const cancel5xx = new Counter('cancel_5xx_total');
// 5xx 응답을 데드락 의심 카운트로 추적 (정확한 데드락은 pg_stat_database.deadlocks 로 검증)
const deadlockSuspected = new Counter('deadlock_suspected_total');
const healthLatency = new Trend('health_latency_during_attack', true);

// PAID 주문 ID 두 그룹으로 분리 — 같은 그룹 내 동시 cancel 충돌 방지
function pickPaidOrderXY() {
    return Math.floor(Math.random() * 200) + 1;     // 1~200
}
function pickPaidOrderYX() {
    return Math.floor(Math.random() * 200) + 201;   // 201~400
}

// cancelOrder 헬퍼 (lib/http.js에 cancelOrder 추가되면 import로 변경)
function cancelOrder(memberId, orderId, items) {
    return http.post(
        `${BASE_URL}/api/v1/orders/${orderId}/cancel`,
        JSON.stringify({ items }),
        {
            headers: {
                'Content-Type': 'application/json',
                'X-Member-Id': String(memberId),
            },
            tags: { name: 'cancelOrder' },
        },
    );
}

export const options = {
    scenarios: {
        // 그룹 XY: P1 → P2 순서 (락 P1 먼저, P2 다음)
        group_xy: {
            executor: 'constant-arrival-rate',
            rate: 5,
            timeUnit: '1s',
            duration: DURATION,
            preAllocatedVUs: 10,
            maxVUs: 50,
            exec: 'cancelInOrderXY',
            tags: { scenario: 'ATK-A05', group: 'XY' },
        },
        // 그룹 YX: P2 → P1 순서 (반대) — 데드락 유발
        group_yx: {
            executor: 'constant-arrival-rate',
            rate: 5,
            timeUnit: '1s',
            duration: DURATION,
            preAllocatedVUs: 10,
            maxVUs: 50,
            exec: 'cancelInOrderYX',
            tags: { scenario: 'ATK-A05', group: 'YX' },
        },
        // 공격 중 health 영향 측정
        health_probe: {
            executor: 'constant-vus',
            vus: 1,
            duration: DURATION,
            exec: 'checkHealth',
            tags: { scenario: 'ATK-A05', probe: 'health' },
        },
    },
    thresholds: {
        ...baseThresholds,
        cancel_failed_rate: ['rate<1.00'],
        // 데드락 발생 자체가 가설 입증이라 임계는 느슨하게 (count 기록 목적)
        deadlock_suspected_total: ['count<10000'],
    },
};

// 그룹 XY: items=[P1, P2] 순서로 cancel
export function cancelInOrderXY() {
    const orderId = pickPaidOrderXY();
    const memberId = ((orderId - 1) % 1000) + 1;
    const items = [
        { orderItemId: orderId, quantity: 1 },         // P1 먼저
        { orderItemId: orderId + 400, quantity: 1 },   // P2 다음
    ];
    doCancel(memberId, orderId, items);
}

// 그룹 YX: items=[P2, P1] 순서로 cancel (반대)
export function cancelInOrderYX() {
    const orderId = pickPaidOrderYX();
    const memberId = ((orderId - 1) % 1000) + 1;
    const items = [
        { orderItemId: orderId + 400, quantity: 1 },   // P2 먼저
        { orderItemId: orderId, quantity: 1 },         // P1 다음
    ];
    doCancel(memberId, orderId, items);
}

function doCancel(memberId, orderId, items) {
    const res = cancelOrder(memberId, orderId, items);

    cancelLatency.add(res.timings.duration);
    cancelFailed.add(res.status >= 400);

    if (res.status >= 500) {
        cancel5xx.add(1);
        deadlockSuspected.add(1); // 5xx 응답 = 데드락 의심 (정확한 카운트는 DB 메트릭으로)
    }

    // 4xx (이미 취소된 주문 등)는 정상 흐름이므로 5xx만 검증
    check(res, {
        'cancel no 5xx': (r) => r.status < 500,
    });

    sleep(SLEEP_SECONDS);
}

export function checkHealth() {
    const res = getHealth();
    healthLatency.add(res.timings.duration);

    check(res, {
        'health 200': (r) => r.status === 200,
    });

    sleep(HEALTH_SLEEP_SECONDS);
}
