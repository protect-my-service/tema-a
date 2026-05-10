import { check, sleep } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";
import { baseThresholds } from "../../../config/env.js";
import { postCartItem, postOrder, getHealth } from "../../../lib/http.js";
import { pickMember } from "../../../lib/data.js";

// ============================================================
// ATK-A03 · 락 대기 누적 → 커넥션 풀 고갈
// ----------------------------------------------------------
// 가설: A02 락 경합이 강해지면 트랜잭션이 커넥션을 오래 점유,
//       HikariCP pool=10 이 모두 점유되어 신규 요청은 timeout(30초).
//       결과: 사이트 전체 응답 불가.
// 시드: data-attack.sql (A02와 동일 — P1)
// 실행 예: TARGET_PRODUCT=1 k6 run a03-pool-exhaustion.js
// 의도: ramping-arrival-rate 로 RPS 단계 상승 → 풀 고갈 임계점 발견
// ============================================================

const TARGET_PRODUCT_ID = parseInt(__ENV.TARGET_PRODUCT || '1', 10);
const SLEEP_SECONDS = parseFloat(__ENV.SLEEP || '1');
const HEALTH_SLEEP_SECONDS = parseFloat(__ENV.HEALTH_SLEEP || '1');

const orderLatency = new Trend('order_latency_ms', true);
const order5xx = new Counter('order_5xx_total');
const order4xx = new Counter('order_4xx_total');
const orderFailed = new Rate('order_failed_rate');
// 30초 이상 응답 = HikariCP connection-timeout(30000ms) 발동 추정
const poolTimeoutEstimated = new Counter('pool_timeout_estimated');
const healthLatency = new Trend('health_latency_during_attack', true);

export const options = {
    scenarios: {
        // RPS 단계 상승 → 어느 시점에 풀이 터지나 임계점 찾기
        pool_exhaustion: {
            executor: 'ramping-arrival-rate',
            startRate: 50,
            timeUnit: '1s',
            preAllocatedVUs: 100,
            maxVUs: 400,
            stages: [
                { duration: '1m', target: 100 },   // 50 → 100 RPS (1분에 걸쳐)
                { duration: '1m', target: 150 },   // 100 → 150 RPS
                { duration: '1m', target: 200 },   // 150 → 200 RPS (임계점 추정)
                { duration: '30s', target: 0 },    // ramp down
            ],
            tags: { scenario: 'ATK-A03' },
        },
        // 공격 중 health endpoint 응답 시간 추적 (사이트 전체 영향 측정)
        health_probe: {
            executor: 'constant-vus',
            vus: 1,
            duration: __ENV.PROBE_DURATION || '4m',
            exec: 'checkHealth',
            tags: { scenario: 'ATK-A03', probe: 'health' },
        },
    },
    thresholds: {
        ...baseThresholds,
        order_failed_rate: ['rate<1.00'],
        // 풀 타임아웃 추정치 (정확한 카운트는 hikaricp_connections_timeout_total 확인)
        pool_timeout_estimated: ['count<200'],
        order_5xx_total: ['count<500'],
        // p99 30초 = connection-timeout 까지 대기한 요청 분포
        'http_req_duration{scenario:ATK-A03}': ['p(99)<30000'],
    },
};

export default function () {
    const memberId = pickMember();

    const cartRes = postCartItem(memberId, {
        productId: TARGET_PRODUCT_ID,
        quantity: 1,
    });

    if (cartRes.status < 200 || cartRes.status >= 300) {
        orderFailed.add(1);
        sleep(SLEEP_SECONDS);
        return;
    }

    const cartItemId = JSON.parse(cartRes.body).cartItemId;

    const res = postOrder(memberId, {
        cartItemIds: [cartItemId],
    });

    orderLatency.add(res.timings.duration);
    orderFailed.add(res.status >= 400);
    if (res.status >= 400 && res.status < 500) order4xx.add(1);
    if (res.status >= 500) order5xx.add(1);
    // 30초 이상 = HikariCP connection-timeout 발동 추정
    if (res.timings.duration >= 30000) poolTimeoutEstimated.add(1);

    check(res, {
        'order 2xx': (r) => r.status >= 200 && r.status < 300,
        'order no pool timeout': (r) => r.timings.duration < 30000,
    });

    sleep(SLEEP_SECONDS);
}

export function checkHealth() {
    const res = getHealth();
    healthLatency.add(res.timings.duration);

    // health도 같은 풀을 쓰므로 풀 고갈 시 health도 느려진다 → A03 가설 입증
    check(res, {
        'health 200': (r) => r.status === 200,
        'health under 1s': (r) => r.timings.duration < 1000,
    });

    sleep(HEALTH_SLEEP_SECONDS);
}
