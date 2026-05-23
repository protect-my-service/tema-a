import { check, sleep } from "k6";
import http from "k6/http";
import { Counter, Rate, Trend } from "k6/metrics";
import { BASE_URL, baseThresholds } from "../../config/env.js";
import { getHealth } from "../../lib/http.js";

// ============================================================
// ATK-A05 · 락 획득 순서 교차 데드락
// ----------------------------------------------------------
// 가설: 두 트랜잭션이 같은 두 상품(P1, P2)을 *반대 순서*로 잡으려 하면
//       wait-for cycle 형성 → PostgreSQL이 SQLSTATE=40P01 로 한 쪽 강제 롤백.
// 시드: data-attack.sql (PAID 주문 1~400, 각 주문에 P1+P2 OrderItem 보유)
//   - orderId N의 OrderItemId: P1=N, P2=N+400 (시드 INSERT 규칙)
//   - memberId = ((orderId - 1) % 1000) + 1
// 실행 예: k6 run tests/attack/a05-cancel-deadlock.js
// ============================================================

const SLEEP_SECONDS = parseFloat(__ENV.SLEEP || '1');
const HEALTH_SLEEP_SECONDS = parseFloat(__ENV.HEALTH_SLEEP || '1');
const DURATION = __ENV.DURATION || '30s';

const cancelLatency = new Trend('cancel_latency_ms', true);
const cancelFailed = new Rate('cancel_failed_rate');
const cancel5xx = new Counter('cancel_5xx_total');
const deadlockSuspected = new Counter('deadlock_suspected_total');
const healthLatency = new Trend('health_latency_during_attack', true);

function pickPaidOrderXY() {
    return Math.floor(Math.random() * 200) + 1;     // 1~200
}
function pickPaidOrderYX() {
    return Math.floor(Math.random() * 200) + 201;   // 201~400
}

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
        deadlock_suspected_total: ['count<10000'],
    },
};

export function cancelInOrderXY() {
    const orderId = pickPaidOrderXY();
    const memberId = ((orderId - 1) % 1000) + 1;
    const items = [
        { orderItemId: orderId, quantity: 1 },         // P1 먼저
        { orderItemId: orderId + 400, quantity: 1 },   // P2 다음
    ];
    doCancel(memberId, orderId, items);
}

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
        deadlockSuspected.add(1);
    }

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
