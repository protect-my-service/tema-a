import { check, sleep } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";
import { baseThresholds } from "../../../config/env.js";
import { postCartItem, postOrder, getHealth } from "../../../lib/http.js";
import { pickMember } from "../../../lib/data.js";

// ============================================================
// ATK-A02 · 동일 상품 집중 주문 락 경합
// ----------------------------------------------------------
// 가설: 인기 상품 1개에 주문이 몰리면 SELECT FOR UPDATE 직렬화로
//       p99 응답 시간이 폭증한다.
// 시드: data-attack.sql (회원 1~1000, 핫 상품 P1=id 1, 재고 99800)
// 실행 예: TARGET_PRODUCT=1 RATE=100 DURATION=3m k6 run a02-hot-row-lock.js
// ============================================================

// 공격 강도는 환경변수로 조절. 코드 수정 X.
const RATE = parseInt(__ENV.RATE || '100', 10);                    // 초당 100건
const DURATION = __ENV.DURATION || '3m';
const TARGET_PRODUCT_ID = parseInt(__ENV.TARGET_PRODUCT || '1', 10); // P1 (data-attack.sql)
const SLEEP_SECONDS = parseFloat(__ENV.SLEEP || '1');
const HEALTH_SLEEP_SECONDS = parseFloat(__ENV.HEALTH_SLEEP || '1');

// 주문 요청만 따로 보기 위한 커스텀 메트릭
const orderLatency = new Trend('order_latency_ms', true);
const order5xx = new Counter('order_5xx_total');
const order4xx = new Counter('order_4xx_total');
const orderFailed = new Rate('order_failed_rate');
const healthLatency = new Trend('health_latency_during_attack', true);

export const options = {
    scenarios: {
        // 모든 VU가 같은 TARGET_PRODUCT로 주문을 시도해 product row 락 경합을 만든다.
        // executor: constant-arrival-rate — RPS 고정 (PDF 슬라이드 24 권장).
        hot_row_order: {
            executor: 'constant-arrival-rate',
            rate: RATE,
            timeUnit: '1s',
            duration: DURATION,
            preAllocatedVUs: 50,
            maxVUs: 200,
            tags: { scenario: 'ATK-A02' },
        },
        // 공격 중 actuator health가 정상 응답하는지 별도 VU로 관찰.
        health_probe: {
            executor: 'constant-vus',
            vus: 1,
            duration: __ENV.PROBE_DURATION || '4m',
            exec: 'checkHealth',
            tags: { scenario: 'ATK-A02', probe: 'health' },
        },
    },
    thresholds: {
        ...baseThresholds,
        order_failed_rate: ['rate<1.00'],
        order_5xx_total: ['count<100'],
        // p99 5초 미만이 가설 입증 임계 (lock.timeout=3000ms 초과 시 5xx)
        'http_req_duration{scenario:ATK-A02}': ['p(99)<5000'],
    },
};

export default function () {
    // 회원은 분산 (1~1000), 상품은 고정 → 같은 product row에 주문 몰림
    const memberId = pickMember();

    // 주문 생성 API는 cartItemId를 받으므로 먼저 카트에 담는다.
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

    // 같은 TARGET_PRODUCT에 대한 주문 → 락 경합 유도
    const res = postOrder(memberId, {
        cartItemIds: [cartItemId],
    });

    orderLatency.add(res.timings.duration);
    orderFailed.add(res.status >= 400);
    if (res.status >= 400 && res.status < 500) order4xx.add(1);
    if (res.status >= 500) order5xx.add(1);

    check(res, {
        'order 2xx': (r) => r.status >= 200 && r.status < 300,
        'order no 5xx': (r) => r.status < 500,
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
