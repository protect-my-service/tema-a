import {check, sleep} from "k6";
import {Counter, Rate, Trend} from "k6/metrics";
import {baseThresholds} from "../../config/env.js";
import {postCartItem, postOrder, getHealth} from "../../lib/http.js";
import {pickMember} from "../../lib/data.js";

// 공격 강도는 실행 시 환경변수로 조절한다.
// 예: VUS=100 DURATION=20s TARGET_PRODUCT=9 k6 run tests/attack/a02-order-hot-row-lock.js
const DURATION = __ENV.DURATION || '5s';
const TARGET_PRODUCT_ID = parseInt(__ENV.TARGET_PRODUCT || '9', 10);
const VUS = parseInt(__ENV.VUS || '20', 10);
const SLEEP_SECONDS = parseFloat(__ENV.SLEEP || '1');
const HEALTH_SLEEP_SECONDS = parseFloat(__ENV.HEALTH_SLEEP || '1');

// 주문 요청만 따로 보기 위한 커스텀 메트릭.
// 기본 http_req_* 메트릭에는 health check 요청도 섞이므로 주문 가설 검증용으로 분리한다.
const orderLatency = new Trend('order_latency_ms', true);
const order5xx = new Counter('order_5xx_total');
const order4xx = new Counter('order_4xx_total');
const orderFailed = new Rate('order_failed_rate');
const healthLatency = new Trend('health_latency_during_attack', true);

export const options = {
    // 어떤 부하 패턴으로 선택할지 시나리오 정의
    scenarios: {
        // 모든 VU가 같은 TARGET_PRODUCT로 주문을 시도해 product row 락 경합을 만든다.
        hot_row_order: {
            executor: 'ramping-vus', // 실행방식: ramping-vus(VU 수를 단계적으로 올리고 내리는 방식)
            startVUs: 0, // 시작 VU 수
            stages: [ // 시간별 목표 VU 수
                {duration: __ENV.RAMP_UP || '2s', target: VUS}, // 짧은 시간에 VU를 끌어올려 spike 형태의 진입 트래픽을 만든다.
                {duration: DURATION, target: VUS}, // 목표 VU를 유지하며 락 대기, timeout, 실패율을 관찰한다.
                {duration: '5s', target: 0}, // 테스트 종료 시 VU를 빠르게 내린다.

            ]
        },
        // 공격 중 actuator health가 정상 응답하는지 별도 VU로 관찰한다.
        health_probe: {
            executor: 'constant-vus',
            vus: 1,
            duration: __ENV.PROBE_DURATION || '60s',
            exec: 'checkHealth',
        },
    },

    // 테스트 성공/실패 기준
    thresholds: {
        ...baseThresholds,
        // 공격 테스트는 실패를 유도하므로 threshold를 느슨하게 둔다.
        // 실제 판단은 실패율, 5xx 수, 주문 지연, health 지연을 함께 본다.
        order_failed_rate: ['rate<1.00'], // 공격 시나리오는 실패 자체가 관찰 대상이므로 전체 실패만 막는다.
        order_5xx_total: ['count<100'], // 5xx가 과도하면 애플리케이션 오류 노출로 판단한다.
    }
}

export default function () {
    // 회원은 분산시키고 상품은 고정해, 같은 상품 row에 주문이 몰리도록 한다.
    const memberId = pickMember();

    // phase2 주문 생성 API는 productId가 아니라 cartItemId 목록을 받는다.
    // 따라서 주문 전에 장바구니에 대상 상품을 담아 cartItemId를 확보한다.
    const cartRes = postCartItem(memberId, {
        productId: TARGET_PRODUCT_ID,
        quantity: 1,
    });

    // 장바구니 추가가 실패하면 주문 생성에 필요한 cartItemId가 없으므로 중단한다.
    if (cartRes.status < 200 || cartRes.status >= 300) {
        orderFailed.add(1);
        sleep(SLEEP_SECONDS);
        return;
    }

    // AddCartItemResponse에서 주문 생성에 필요한 cartItemId를 추출한다.
    const cartBody = JSON.parse(cartRes.body);
    const cartItemId = cartBody.cartItemId;

    // 같은 TARGET_PRODUCT에 대한 주문을 몰아 product lock 경합을 유도한다.
    const res = postOrder(memberId, {
        cartItemIds: [cartItemId],
    });

    // 주문 요청의 지연, 실패, 5xx를 커스텀 메트릭으로 기록한다.
    orderLatency.add(res.timings.duration);
    orderFailed.add(res.status >= 400);
    if (res.status >= 400 && res.status < 500) order4xx.add(1);
    if (res.status >= 500) order5xx.add(1);

    // 2xx는 실제 주문 성공률, no 5xx는 서버 내부 오류 노출 여부를 보는 신호다.
    check(res, {
        'order 2xx': (response) => response.status >= 200 && response.status < 300,
        'order no 5xx': (response) => response.status < 500,
    });

    // sleep이 없으면 VU가 tight loop로 수만 건을 발생시켜 락 경합보다 재고 소진이 먼저 지배한다.
    sleep(SLEEP_SECONDS);
};

export function checkHealth() {
    // 별도 VU가 health endpoint를 계속 호출해 공격 중 정상 API 영향도를 본다.
    const res = getHealth();
    healthLatency.add(res.timings.duration);

    check(res, {
        'health 200': (response) => response.status === 200,
    });

    // health check도 간격을 둬야 전체 HTTP 지표가 health 요청으로 덮이지 않는다.
    sleep(HEALTH_SLEEP_SECONDS);
}
