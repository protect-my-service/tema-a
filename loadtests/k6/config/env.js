// k6 공통 환경 설정.
//
// 모든 테스트는 이 파일을 import해서 타겟 URL, 시드 ID 범위,
// 공통 threshold를 공유한다. 필요하면 실행 시 환경변수로 덮어쓴다.

export const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';

// 기본 시드 범위 — 기존 소형 시드(loadtests/k6/data.sql: 회원 100 / 상품 50)에 맞춘 값.
// ⚠ 이 기본값은 기존 1주차 테스트(a02-order-hot-row-lock, order-create.smoke 등)와 "공유"된다.
//   Week2 대규모 시드(data-cache.sql: 회원 10,000 / 상품 50,000)에 맞춘다고 여기서 기본값을 올리면
//   기존 테스트가 시드에 없는 ID를 생성해 404/4xx가 나는 회귀가 생긴다.
//   → Week2는 기본값을 건드리지 않고, 러너 스크립트(run-read-*/run-invalidation)가
//     MEMBER_MAX=10000 PRODUCT_MAX=50000 을 __ENV로 명시 전달한다. (수동 실행 시에도 동일하게 전달)
export const MEMBERS = {
  min: parseInt(__ENV.MEMBER_MIN || '1', 10),
  max: parseInt(__ENV.MEMBER_MAX || '100', 10),
};

export const PRODUCTS = {
  min: parseInt(__ENV.PRODUCT_MIN || '1', 10),
  max: parseInt(__ENV.PRODUCT_MAX || '50', 10),
};

// 캐시 핫스팟 측정의 주 대상 상품 ID.
// data-cache.sql에서 이 ID의 상품을 단일 핫상품(재고 매우 큼)으로 시드한다.
export const TARGET_PRODUCT = parseInt(__ENV.TARGET_PRODUCT || '1', 10);

// 읽기 부하의 기본 도착률(RATE, 초당 요청 수)과 지속 시간(DURATION).
// constant-arrival-rate executor에 그대로 전달된다. 실행 시 __ENV로 강도를 연다.
export const READ_RATE = parseInt(__ENV.RATE || '200', 10);
export const READ_DURATION = __ENV.DURATION || '1m';

// 롱테일 콜드 키 비율.
// 매 iteration에서 이 확률(기본 0.1)로 핫상품 대신 롱테일(콜드 키)을 읽어
// 현실적인 캐시 히트율과 미스를 동시에 만든다.
export const COLD_RATIO = parseFloat(__ENV.COLD_RATIO || '0.1');

// 공격 테스트는 실패를 유도할 수 있으므로 기본 threshold를 느슨하게 둔다.
// 개별 테스트에서 spread 후 필요한 기준만 추가하거나 덮어쓴다.
export const baseThresholds = {
  http_req_failed: ['rate<0.95'],
  http_req_duration: ['p(95)<60000'],
};

// 캐시 ON(적용 후) 합격선 검증용 threshold.
// 조회 API p99가 충분히 낮은지(캐시 효과)를 통과/실패로 판정할 때 사용한다.
// 캐시 OFF(적용 전) 측정에서는 보통 미달이 정상이므로 --no-thresholds로 돌리거나
// READ_P99_MS를 크게 열어 비교만 한다. 예: READ_P99_MS=200 k6 run ...
//
// 주의: 아래 read_latency_ms / read_failed_rate 는
//   tests/attack/a02-product-hotspot-read.js 가 정의하는 "조회 전용" 커스텀 메트릭이다.
//   health 요청이 섞이는 http_req_* 대신 조회 전용 메트릭에 합격선을 걸어야
//   캐시 효과(p99)와 조회 실패율을 정확히 판정할 수 있다.
//   → 이 readThresholds 는 해당 테스트에서만 spread 한다(다른 테스트에서 쓰면 메트릭 미정의 오류).
export const READ_P99_MS = parseInt(__ENV.READ_P99_MS || '200', 10);
export const readThresholds = {
  read_latency_ms: [`p(99)<${READ_P99_MS}`],
  read_failed_rate: ['rate<0.01'],
};
