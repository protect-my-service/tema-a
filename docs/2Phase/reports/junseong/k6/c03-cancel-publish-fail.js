// ─────────────────────────────────────────────────────────────────────
// ATK-C03 · 취소 이벤트 발행 실패 — K6 공격 스크립트
// ─────────────────────────────────────────────────────────────────────
// 의도:
//   - "정확히 50건"의 취소 요청을 빠르게 발사한다.
//   - 부하의 강도가 아니라 "RabbitMQ 가 차단된 5초 동안 발생한 모든 요청"
//     의 메시지가 유실되는지를 확인하는 게 목적.
//
// 왜 per-vu-iterations executor 인가:
//   - constant-arrival-rate 는 정확히 N개를 보장하지 않음 (rate*duration 근사값).
//   - 우리는 "정확히 50건 발사 후 종료" 가 필요해서 vus=10, iterations=5 사용.
//
// 왜 idempotencyKey 가 없나:
//   - 이 시나리오는 idempotency 가설이 아니라 "유실" 가설.
//   - idempotency 미설정이라는 사실 자체는 B02(중복결제) 시나리오 영역.
//
// 사용:
//   k6 run k6/c03-cancel-publish-fail.js
//
// 환경변수 (선택):
//   BASE_URL    : 기본 http://localhost:8080
//   ORDER_PREFIX: 기본 'C03-' (seed-c03.sql 에서 생성한 prefix)
// ─────────────────────────────────────────────────────────────────────

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';

// ─── 옵션 ──────────────────────────────────────────────────────────
export const options = {
    scenarios: {
        c03_cancel_publish_fail: {
            executor: 'per-vu-iterations',
            vus: 10,                  // 10명이 동시에
            iterations: 5,            // 각자 5번씩 = 50건
            maxDuration: '30s',       // 안전 한계 (정상이면 5~6초 내 종료)
            tags: { scenario: 'ATK-C03', stage: 'attack' },
        },
    },
    thresholds: {
        // 가설은 "DB 커밋은 모두 성공해야 함" → 5xx 가 거의 없어야 한다
        'http_req_failed{scenario:ATK-C03}':   ['rate < 0.05'],
        // 응답시간은 부수적이지만 비정상 값은 잡아둠
        'http_req_duration{scenario:ATK-C03}': ['p(99) < 5000'],
    },
};

// ─── 커스텀 메트릭 ──────────────────────────────────────────────────
const cancelSuccess = new Counter('c03_cancel_success_count');
const cancelFail    = new Counter('c03_cancel_fail_count');
const cancelLatency = new Trend('c03_cancel_latency_ms');

// ─── 설정 ──────────────────────────────────────────────────────────
const BASE_URL     = __ENV.BASE_URL     || 'http://localhost:8080';
const ORDER_PREFIX = __ENV.ORDER_PREFIX || 'C03-';

// ─── setup: orderNumber → orderId 매핑 사전 조회 ────────────────────
// K6 는 DB 직접 접근이 어려우므로, 앱의 주문 조회 API 를 통해 orderId 를 미리 얻어둔다.
// setup 의 리턴값은 default 함수와 teardown 의 첫 번째 인자로 전달된다.
export function setup() {
    console.log('[C03] setup: looking up orderIds for C03-0001..C03-0050');
    const ids = [];
    for (let i = 1; i <= 50; i++) {
        const memberId = i;                              // seed-c03.sql 에서 1:1 매핑
        const res = http.get(`${BASE_URL}/api/v1/orders?page=0&size=20`, {
            headers: { 'X-Member-Id': String(memberId) },
            timeout: '5s',
        });
        if (res.status !== 200) {
            console.error(`[C03] setup failed for member=${i} status=${res.status}`);
            ids.push(null);
            continue;
        }
        try {
            const body = JSON.parse(res.body);
            const target = (body.content || []).find(o =>
                o.orderNumber && o.orderNumber.startsWith(ORDER_PREFIX));
            if (target) {
                ids.push(target.orderId);
            } else {
                console.error(`[C03] setup: no ${ORDER_PREFIX} order for member=${i}`);
                ids.push(null);
            }
        } catch (e) {
            console.error(`[C03] setup parse error for member=${i}: ${e}`);
            ids.push(null);
        }
    }
    const validCount = ids.filter(x => x !== null).length;
    console.log(`[C03] setup: resolved ${validCount}/50 orderIds`);
    if (validCount < 50) {
        throw new Error(`[C03] setup: only ${validCount}/50 orders. Did you run seed-c03.sql?`);
    }
    return { orderIds: ids };
}

// ─── 시나리오 본체 ──────────────────────────────────────────────────
// data 는 setup 의 리턴값. 여기에 orderIds 배열이 담겨 있다.
export default function (data) {
    // VU 번호 + iteration 번호로 1~50 의 인덱스를 결정적으로 매핑
    // (__VU 는 1부터, __ITER 는 0부터 시작)
    const sequence = (__VU - 1) * 5 + __ITER + 1;       // 1..50
    const idx = sequence - 1;
    const orderId = data.orderIds[idx];
    const memberId = sequence;

    if (!orderId) {
        console.error(`[C03] missing orderId for sequence=${sequence}`);
        cancelFail.add(1);
        return;
    }

    const url = `${BASE_URL}/api/v1/orders/${orderId}/cancel`;
    const params = {
        headers: {
            'X-Member-Id': String(memberId),
            'Content-Type': 'application/json',
        },
        tags: { scenario: 'ATK-C03', stage: 'attack' },
        timeout: '10s',
    };

    // body 는 reason 만 포함 (전체 취소)
    const payload = JSON.stringify({ reason: 'C03 attack — publish failure test' });

    const start = Date.now();
    const res = http.post(url, payload, params);
    const elapsed = Date.now() - start;

    cancelLatency.add(elapsed);

    const ok = check(res, {
        'status is 200': (r) => r.status === 200,
        'has CANCELLED status': (r) => r.body && r.body.includes('CANCELLED'),
    });

    if (ok) {
        cancelSuccess.add(1);
    } else {
        cancelFail.add(1);
        console.warn(`[C03] cancel failed: seq=${sequence} orderId=${orderId} status=${res.status} body=${res.body?.substring(0, 200)}`);
    }

    // 50건이 5초 내에 자연스럽게 분포되도록 약간의 think time
    sleep(0.1 + Math.random() * 0.2);
}

// ─── teardown: 결과 안내 ───────────────────────────────────────────
export function teardown(data) {
    console.log('[C03] teardown done');
    console.log('[C03] 다음 단계: ./scripts/verify-loss.sh check 실행');
}
