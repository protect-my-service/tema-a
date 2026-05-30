import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import {
  readThresholds,
  TARGET_PRODUCT,
  READ_RATE,
  READ_DURATION,
  COLD_RATIO,
} from '../../config/env.js';
import { getProduct, getHealth } from '../../lib/http.js';
import { pickColdProduct } from '../../lib/data.js';

// ============================================================
// ATK-A02(Week2) · 단일 핫상품 조회 폭주 (캐시 핫스팟 읽기)
// ----------------------------------------------------------
// [핵심] 같은 TARGET_PRODUCT 조회에 읽기 트래픽을 집중시켜
//   - 캐시 OFF(적용 전): DB가 매 요청을 직접 읽어 조회 p99/RPS가 어떻게 되는지
//   - 캐시 ON(적용 후): 같은 조건에서 p99가 얼마나 내려가고 RPS가 얼마나 오르는지
// 를 "동일 스크립트 / 동일 강도(RATE·DURATION)"로 돌려 Before/After를 비교한다.
//   ※ 이 스크립트는 캐시 전략(로컬 Caffeine / Redis / 다층 등)과 무관한 범용 부하다.
//     캐시 히트율/DB QPS는 k6가 직접 못 잡으므로 Actuator+Prometheus로 수집한다
//     (docs/week2-cache-guide.md 참고). k6는 조회 p99 / RPS / health 지연만 측정한다.
//
// [현실적 히트율 유발]
//   매 iteration에서 확률 COLD_RATIO(기본 0.1)로 롱테일 콜드 키(pickColdProduct())를,
//   나머지는 핫상품(TARGET_PRODUCT)을 조회한다.
//   → 핫상품은 캐시 히트, 롱테일은 캐시 미스를 일으켜 현실적인 히트율을 만든다.
//
// [정확성 게이트 — 항상 적용]
//   조회가 충분히 성공하지 못하면(잘못된 BASE_URL→status 0, 시드 누락→404, 4xx/5xx) 그 측정은
//   "캐시 성능"이 아니라 "에러"를 벤치마킹한 것이다. 그래서 read_failed_rate(비-2xx 비율) 게이트를
//   p99 합격선과 무관하게 항상 켜서, 실패율이 READ_FAIL_MAX(기본 5%)를 넘으면 run을 fail 처리한다.
//   → BEFORE/AFTER 둘 다 --no-thresholds 로 돌리지 않는다(러너 스크립트가 preflight smoke + 정확성 게이트 유지).
//   ※ stampede처럼 과부하로 실패가 정상인 모드는 READ_FAIL_MAX 를 올려 의도적으로 완화한다.
//
// [실행 예 / Before·After 비교] — 보통은 러너 스크립트를 쓴다(preflight 포함).
//   # 캐시 OFF(적용 전): 정확성 게이트만 적용, p99 합격선은 미적용(느린 게 정상).
//   RATE=200 DURATION=1m k6 run \
//     --summary-export=results/read-before-summary.json \
//     tests/attack/a02-product-hotspot-read.js
//   # 캐시 ON(적용 후) p99 합격선까지 판정: USE_THRESHOLDS=1 로 JUDGE 모드.
//   RATE=200 DURATION=1m k6 run -e USE_THRESHOLDS=1 \
//     --summary-export=results/read-after-summary.json \
//     tests/attack/a02-product-hotspot-read.js
//
// [MODE=stampede] Cache Stampede 관측 모드.
//   ramping-arrival-rate 버스트로 콜드 키에 동시 진입시켜
//   (캐시 미스 → DB 동시 적재) 현상을 관측한다. COLD_RATIO를 1.0 근처로 올려 사용.
//   과부하 실패가 관측 대상이면 READ_FAIL_MAX 를 올린다(예: READ_FAIL_MAX=0.5).
// ============================================================

// 강도/대상은 절대 하드코딩하지 않고 __ENV로 연다(config/env.js 경유).
const PRE_ALLOCATED_VUS = parseInt(__ENV.PRE_ALLOCATED_VUS || '50', 10);
const MAX_VUS = parseInt(__ENV.MAX_VUS || String(PRE_ALLOCATED_VUS * 4), 10);
const MODE = __ENV.MODE || 'steady'; // steady | stampede

// 캐시 ON(AFTER) p99 합격선 판정 모드.
// run-read-after.sh 가 USE_THRESHOLDS=1 일 때 -e USE_THRESHOLDS=1 로 넘겨준다.
// 이때만 readThresholds(조회 전용 p99/실패율)를 options.thresholds에 합쳐 p99 합격선까지 강제한다.
// (JUDGE가 아니어도 아래 정확성 게이트는 항상 적용된다.)
const JUDGE = __ENV.USE_THRESHOLDS === '1';

// 정확성 게이트 실패 상한. 조회 비-2xx 비율이 이 값을 넘으면 측정 무효(run fail).
// 기본 5%. stampede 등 실패가 정상인 모드에서는 __ENV로 올린다.
const READ_FAIL_MAX = parseFloat(__ENV.READ_FAIL_MAX || '0.05');

// 부하 유효성 게이트(steady 벤치마크에만 적용).
// constant-arrival-rate는 VU가 고갈되면 요청을 "발사하지 않고" dropped_iterations로 센다.
// 이 경우 발사된 요청만 read_latency_ms/read_failed_rate에 들어가 p99가 좋아 보여도
// 실제로는 요청한 RATE보다 적은 부하를 측정한 것 → 측정 무효로 본다.
//   DROPPED_MAX: 허용 드롭 수(기본 0). THROUGHPUT_RATIO: 실제 처리량이 RATE의 몇 배 이상이어야 유효(기본 0.95).
const DROPPED_MAX = parseInt(__ENV.DROPPED_MAX || '0', 10);
const THROUGHPUT_RATIO = parseFloat(__ENV.THROUGHPUT_RATIO || '0.95');

// health probe는 read 부하와 "같은 길이"로만 돈다.
// 그렇지 않으면 read 시나리오가 끝난 뒤 health 요청만 남는 구간이 생겨
// http_reqs 기반 RPS가 실제 조회 처리량보다 낮게 계산된다(리포트는 read_reqs를 RPS로 쓴다).
const PROBE_DURATION = __ENV.PROBE_DURATION || READ_DURATION;

// 조회 요청만 따로 보기 위한 커스텀 메트릭.
// 기본 http_req_* 에는 health 요청도 섞이므로 조회 가설 검증용으로 분리한다.
const readLatency = new Trend('read_latency_ms', true);
const read5xx = new Counter('read_5xx_total');
const readFailed = new Rate('read_failed_rate');
const healthLatency = new Trend('health_latency_during_attack', true);
// 조회 전용 처리량 카운터. summary의 read_reqs rate(=count/sec)가 곧 동시 처리 RPS다.
// http_reqs는 health 요청까지 포함하므로 RPS 비교에는 이 read 전용 카운터를 쓴다.
const readReqs = new Counter('read_reqs');

// steady 모드: 도착률을 고정해 동일 강도에서 Before/After를 비교한다.
const steadyScenario = {
  executor: 'constant-arrival-rate',
  rate: READ_RATE, // 초당 요청 수(RATE)
  timeUnit: '1s',
  duration: READ_DURATION,
  preAllocatedVUs: PRE_ALLOCATED_VUS,
  maxVUs: MAX_VUS,
};

// stampede 모드: 짧은 시간에 도착률을 폭증시켜 콜드 키 동시 진입을 만든다.
// 캐시 미스가 동시에 터지며 DB로 동시에 적재 요청이 몰리는 Cache Stampede를 관측한다.
const stampedeScenario = {
  executor: 'ramping-arrival-rate',
  startRate: 0,
  timeUnit: '1s',
  preAllocatedVUs: PRE_ALLOCATED_VUS,
  maxVUs: MAX_VUS,
  stages: [
    { target: READ_RATE * 5, duration: __ENV.BURST_RAMP || '2s' }, // 순간 버스트로 동시 미스 유발
    { target: READ_RATE * 5, duration: READ_DURATION }, // 고도착률 유지
    { target: 0, duration: '3s' },
  ],
};

export const options = {
  scenarios: {
    // 단일 핫상품에 읽기 폭주(+ 롱테일 콜드 키 일부 섞음).
    hotspot_read: MODE === 'stampede' ? stampedeScenario : steadyScenario,
    // 공격 중 actuator health가 정상 응답하는지 별도 VU로 관찰한다.
    health_probe: {
      executor: 'constant-vus',
      vus: 1,
      duration: PROBE_DURATION, // read 부하와 동일 길이(기본 READ_DURATION)
      exec: 'checkHealth',
    },
  },

  // [정확성 게이트 — BEFORE/AFTER, steady/stampede 모든 모드에서 항상 적용]
  // 조회가 대부분 성공해야 "유효한 측정"이다. 비-2xx 비율이 READ_FAIL_MAX(기본 5%)를 넘으면
  // 잘못된 BASE_URL/시드 누락/4xx 등 "에러 벤치마킹"이므로 run을 실패로 표시해 산출물을 못 믿게 한다.
  // [부하 유효성 게이트 — steady 벤치마크에만] 드롭된 부하(dropped_iterations)와 처리량 미달(read_reqs)을
  //   잡아, "요청한 RATE를 실제로 발사한" 측정만 유효로 인정한다. (stampede는 과부하 관측 모드라 제외.)
  // [p99 합격선] JUDGE(USE_THRESHOLDS=1)일 때만 readThresholds(read_latency_ms p99, read_failed_rate<1%)를 추가.
  thresholds: {
    read_failed_rate: [`rate<${READ_FAIL_MAX}`], // 항상 적용되는 정확성 게이트
    read_5xx_total: ['count<1000'], // 5xx가 과도하면 캐시/DB 계층 오류 노출로 판단한다.
    ...(MODE !== 'stampede'
      ? {
          // VU 고갈로 요청을 발사조차 못한 경우 → 측정 무효.
          dropped_iterations: [`count<=${DROPPED_MAX}`],
          // 실제 처리량(read_reqs rate)이 RATE의 THROUGHPUT_RATIO(기본 0.95) 미만이면 → 측정 무효.
          read_reqs: [`rate>=${READ_RATE * THROUGHPUT_RATIO}`],
        }
      : {}),
    ...(JUDGE ? readThresholds : {}), // JUDGE 시 read_failed_rate를 rate<0.01로 더 엄격히 덮어씀
  },
};

export default function () {
  // 확률 COLD_RATIO로 롱테일 콜드 키(캐시 미스 유도), 나머지는 핫상품(캐시 히트 유도).
  const useCold = Math.random() < COLD_RATIO;
  const productId = useCold ? pickColdProduct() : TARGET_PRODUCT;

  const res = getProduct(productId);

  // 조회 요청의 지연/실패/5xx/처리량을 커스텀 메트릭으로 기록한다.
  readReqs.add(1); // 조회 전용 처리량(=RPS 산출 기준)
  readLatency.add(res.timings.duration);
  // 비-2xx는 모두 실패로 집계한다. status 0(연결 실패/잘못된 BASE_URL)도 실패로 잡아야
  // 정확성 게이트가 "에러 벤치마킹"을 걸러낸다.
  readFailed.add(!(res.status >= 200 && res.status < 300));
  if (res.status >= 500) read5xx.add(1);

  // 2xx는 조회 성공률, no 5xx는 서버 내부 오류 노출 여부를 보는 신호다.
  check(res, {
    'read 2xx': (r) => r.status >= 200 && r.status < 300,
    'read no 5xx': (r) => r.status < 500,
  });
}

export function checkHealth() {
  // 별도 VU가 health endpoint를 계속 호출해 조회 폭주 중 정상 API 영향도를 본다.
  const res = getHealth();
  healthLatency.add(res.timings.duration);

  check(res, {
    'health 200': (r) => r.status === 200,
  });

  // health check도 간격을 둬야 전체 HTTP 지표가 health 요청으로 덮이지 않는다.
  sleep(parseFloat(__ENV.HEALTH_SLEEP || '1'));
}
