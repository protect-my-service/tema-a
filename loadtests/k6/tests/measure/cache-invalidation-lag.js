import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import exec from 'k6/execution';
import { baseThresholds, MEMBERS, PRODUCTS } from '../../config/env.js';
import { getCart, postCartItem, deleteCartItem } from '../../lib/http.js';

// ============================================================
// Week2 · 캐시 무효화 지연(Invalidation Lag) 측정 — ★ 측정 범위: "장바구니(cart) 캐시" ★
// ----------------------------------------------------------
// ┌─ 측정 범위 경고 (반드시 읽을 것) ────────────────────────────────┐
// │ 이 스크립트는 "쓰기(장바구니 담기) → 장바구니 조회(GET /cart) 반영"까지의 지연을 잰다.       │
// │ 즉 메트릭 cart_invalidation_lag_ms 는 "장바구니 캐시" 무효화 지연이다.                       │
// │ ⚠ 이 값을 "상품 상세(GET /products/{id}) 캐시"의 무효화 합격 근거로 쓰면 안 된다.            │
// │   읽기 부하 벤치마크(a02-product-hotspot-read)는 상품 상세를 캐싱하는데,                     │
// │   주문 서비스에는 상품을 변경하는 공개 엔드포인트가 없어 product-cache 무효화는 여기서 못 잰다.  │
// │   상품 캐시 무효화를 재려면 "상품 표현을 바꾸는 쓰기 → getProduct 폴링" 경로가 따로 필요하다.    │
// └──────────────────────────────────────────────────────────────────┘
//
// [측정 대상] "쓰기로 데이터가 바뀐 시점"부터 "조회(읽기)에 그 변경이 반영된 첫 응답"까지의
//   경과(ms). 캐시 전략(write-through / TTL / 이벤트 무효화 등)과 무관한 범용 패턴이다.
//   캐시가 무효화/갱신되기 전까지 옛 값을 돌려주는 구간이 곧 "무효화 지연"이다.
//
// [현재 구현 — 장바구니 경로]
//   회원 단위로 격리되는 장바구니를 측정 매개로 쓴다(쓰기/조회/삭제 엔드포인트가 모두 존재).
//     1) postCartItem 으로 "내가 고른 productId"를 담고 ACK(응답) 시각을 기록한다.
//     2) getCart를 짧은 간격으로 폴링하여, "바로 그 productId"가 보이는 첫 응답까지의 경과(ms)를 기록한다.
//   캐시가 없으면 지연이 거의 0에 수렴하고, 조회 캐시가 끼면 무효화 지연만큼 늦게 반영된다.
//
// ★ [경쟁 조건 주의 — 측정 정확도의 핵심]
//   - member/product는 "전 VU를 통틀어 유일한" 인덱스(exec.scenario.iterationInTest)로 결정론 할당한다.
//     → VUS>1 이어도 두 iteration이 같은 장바구니를 동시에 건드리지 않는다. 다른 VU의 쓰기를
//       내 반영으로 오인하지 않는다.
//   - 반영 확인은 "item 개수 증가"가 아니라 "내가 쓴 productId가 items에 존재"로 판정한다.
//     → 시드/이전 실행으로 카트에 다른 item이 있어도 오판하지 않는다.
//   - 쓰기 실패(중복/타임아웃 등)는 그냥 버리지 않고 cart_write_failed_rate 로 집계해 분포에서 드러낸다.
//
// ★ [idempotent — 재실행 안전]
//   addItem은 같은 상품을 "수량 병합"하므로, 이전 run이 남긴 cart item이 있으면 내 쓰기가 즉시 보여
//   lag가 0으로 왜곡된다. 그래서 매 iteration은:
//     (pre-clean) 쓰기 전 같은 product의 leftover가 있으면 DELETE 로 지워 깨끗한 상태에서 시작하고,
//     (self-clean) 측정 후 내가 담은 cart item을 DELETE 로 지워 baseline으로 되돌린다.
//   → 재시드 없이 여러 번 돌려도 항상 "absent → present" 가시성을 측정한다.
//
// ★ 상품 캐시(GET /products/{id}) 무효화를 측정하려면: "상품 표현을 바꾸는 쓰기 엔드포인트"가 생긴 뒤
//   "폴링 대상만 getCart → getProduct 로, classifyCart 판정만 바뀐 필드 비교로" 교체한다. 그 전까지
//   이 스크립트의 결과는 "장바구니 캐시" 범위로만 보고한다(메트릭 이름에 cart_ 접두사로 못박음).
//
// [메트릭] (모두 cart_ 접두사 = 장바구니 캐시 범위임을 출력에서 명시)
//   cart_invalidation_lag_ms      (Trend)  : 쓰기 ACK ~ 내 productId가 getCart 에 반영된 첫 응답까지 경과(ms)
//   cart_invalidation_samples_total (Counter): 실제 lag를 남긴 성공 샘플 수 — 계획 대비 95%↑ 게이트(거짓 통과 방지)
//   stale_reads_total       (Counter): 내 쓰기 반영 전 옛 값을 돌려준 폴링 응답(정상 2xx 한정)
//   cart_write_failed_rate  (Rate)   : 측정용 쓰기(postCartItem) 실패율
//   cart_read_failed_rate   (Rate)   : 폴링/사전 조회(getCart)의 비-2xx/파싱불가 비율 — 깨진 읽기를 stale로 둔갑시키지 않음
//   cart_cleanup_failed_rate(Rate)   : self-clean(DELETE) 실패율 — 정리 누락은 다음 run을 오염시키므로 게이트(기본 1%)
//   cart_invalidation_preclean_failed_rate (Rate): 쓰기 전 baseline(absent) 미확보 비율 — 확보 못하면 그 iteration은 skip
//   cart_invalidation_timeout_total (Counter): 상한(POLL_TIMEOUT_MS) 안에 반영 못 본 횟수(정상 측정이면 0)
//
// [실행 예]
//   ITERATIONS=200 POLL_INTERVAL_MS=20 POLL_TIMEOUT_MS=3000 \
//   MEMBER_MAX=10000 PRODUCT_MAX=50000 \
//     k6 run --summary-export=results/invalidation-summary.json \
//     tests/measure/cache-invalidation-lag.js
//   ※ 러너 run-invalidation.sh 는 MEMBER_MAX/PRODUCT_MAX(대규모 시드)를 자동 전달한다.
//   ※ 동시성/재사용 가드: VUS×ITERATIONS 가 회원 수(MEMBER_SPAN)를 넘으면 회원/카트가 재사용되어
//     서로 다른 iteration이 같은 카트를 건드린다. 문서 경고가 아니라 init에서 하드 차단한다(아래 가드).
// ============================================================

const ITERATIONS = parseInt(__ENV.ITERATIONS || '100', 10);
const VUS = parseInt(__ENV.VUS || '1', 10);
const POLL_INTERVAL_MS = parseInt(__ENV.POLL_INTERVAL_MS || '20', 10); // 폴링 간격(ms)
const POLL_TIMEOUT_MS = parseInt(__ENV.POLL_TIMEOUT_MS || '3000', 10); // 반영 대기 상한(ms)
// 계획한 iteration 중 "실제 lag 샘플을 남긴" 비율의 하한.
// skip(baseline 미확보)/쓰기실패/timeout 으로 샘플이 안 남으면 이 비율 미만이 되어 run이 fail한다.
const SAMPLE_MIN_RATIO = parseFloat(__ENV.SAMPLE_MIN_RATIO || '0.95');
// self-clean(DELETE) 재시도. DELETE 는 cartItemId→DB 직접이라 캐시와 무관하게 확실히 지운다.
const CLEANUP_RETRIES = parseInt(__ENV.CLEANUP_RETRIES || '3', 10);
const CLEANUP_RETRY_MS = parseInt(__ENV.CLEANUP_RETRY_MS || '50', 10);

const invalidationLag = new Trend('cart_invalidation_lag_ms', true);
const lagSamples = new Counter('cart_invalidation_samples_total'); // 실제 lag를 기록한 성공 샘플 수
const staleReads = new Counter('stale_reads_total');
const writeFailed = new Rate('cart_write_failed_rate');
const readFailed = new Rate('cart_read_failed_rate'); // 폴링/사전 조회 자체가 깨졌는지(비-2xx/파싱불가)
const cleanupFailed = new Rate('cart_cleanup_failed_rate'); // self-clean(DELETE) 실패율
const precleanFailed = new Rate('cart_invalidation_preclean_failed_rate'); // baseline(absent) 미확보 비율
const notReflected = new Counter('cart_invalidation_timeout_total');

const MEMBER_SPAN = MEMBERS.max - MEMBERS.min + 1;
const PRODUCT_SPAN = PRODUCTS.max - PRODUCTS.min + 1;

// [동시성/재사용 하드 가드] iterationInTest 는 0..(VUS*ITERATIONS-1) 의 유일 인덱스다.
// 이 총량이 회원 수(MEMBER_SPAN)를 넘으면 idx가 wrap 되어 서로 다른 iteration이 같은 회원/카트를
// 공유한다(동시 실행이면 한쪽 쓰기/정리가 다른 쪽 폴링을 만족·삭제해 lag/timeout이 오염됨).
// 문서 경고로 두지 않고 init 단계에서 즉시 중단한다 → MEMBER_MAX↑ 또는 VUS/ITERATIONS↓.
const TOTAL_ITERS = VUS * ITERATIONS;
if (TOTAL_ITERS > MEMBER_SPAN) {
  throw new Error(
    `[invalidation] VUS*ITERATIONS(${TOTAL_ITERS}) > 회원 수(${MEMBER_SPAN}). ` +
      `회원/카트 재사용으로 측정이 오염된다. MEMBER_MAX를 늘리거나 VUS/ITERATIONS를 줄여라.`,
  );
}

// 성공 샘플 수 하한. 계획한 iteration(TOTAL_ITERS) 대비 SAMPLE_MIN_RATIO 이상이 실제 lag를 남겨야 한다.
// 이게 없으면 대부분 skip/실패해도 소수 생존 샘플로 p95가 좋게 나와 "무효화가 빠르다"는 거짓 결론이 가능.
const MIN_SAMPLES = Math.ceil(TOTAL_ITERS * SAMPLE_MIN_RATIO);

export const options = {
  scenarios: {
    invalidation: {
      executor: 'per-vu-iterations',
      vus: VUS,
      iterations: ITERATIONS,
      maxDuration: __ENV.MAX_DURATION || '5m',
    },
  },
  thresholds: {
    ...baseThresholds,
    // 정확성 게이트: 측정용 쓰기가 대부분 실패하면(잘못된 BASE_URL→status 0, 시드/카트 누락)
    // 무효화 지연 측정 자체가 무의미하므로 run을 실패로 표시한다.
    cart_write_failed_rate: [`rate<${parseFloat(__ENV.WRITE_FAIL_MAX || '0.05')}`],
    // 폴링 조회가 깨지면(비-2xx/파싱불가) 그 응답을 "아직 반영 안 됨(stale)"으로 오인해
    // 가짜 무효화 지연을 기록하게 된다. 폴링 읽기 실패율도 게이트로 막는다.
    cart_read_failed_rate: [`rate<${parseFloat(__ENV.READ_FAIL_MAX || '0.05')}`],
    // 상한 안에 반영을 한 번도 못 본 경우(timeout)는 "측정된 지연"이 아니라 "측정 실패"다.
    // 정상 측정이면 0이어야 하며, 의도적으로 허용하려면 TIMEOUT_MAX를 올린다.
    cart_invalidation_timeout_total: [`count<=${parseInt(__ENV.TIMEOUT_MAX || '0', 10)}`],
    // 쓰기 전 baseline(absent)을 확보 못한 iteration이 많으면(leftover 정리 실패 등) lag 측정이
    // 의미를 잃는다. baseline 미확보 비율도 게이트로 막는다.
    cart_invalidation_preclean_failed_rate: [`rate<${parseFloat(__ENV.PRECLEAN_FAIL_MAX || '0.05')}`],
    // ★ 성공 샘플 수 게이트: 실제 lag를 남긴 iteration이 계획 대비 SAMPLE_MIN_RATIO(기본 95%) 이상이어야 한다.
    //   실패율 게이트만으로는 "대부분 skip/실패 + 소수 생존 샘플의 좋은 p95"가 통과할 수 있으므로,
    //   샘플 수를 기대 iteration 수에 직접 묶어 거짓 통과를 막는다.
    cart_invalidation_samples_total: [`count>=${MIN_SAMPLES}`],
    // ★ self-clean 실패 게이트: 정리가 누락되면 leftover가 다음 run의 카트를 오염시킨다.
    //   엄격히 막아(기본 1%) 초과 시 run을 fail시킨다 → 결과 신뢰 불가, DB 재시드 후 재실행하라는 신호.
    cart_cleanup_failed_rate: [`rate<${parseFloat(__ENV.CLEANUP_FAIL_MAX || '0.01')}`],
  },
};

// 폴링 응답을 3가지로 분류한다.
//   'reflected' : 2xx 이고 내 productId가 items에 존재 → 반영됨
//   'stale'     : 2xx 이고 정상 파싱되지만 아직 내 productId가 없음 → 진짜 stale(반영 전)
//   'broken'    : 비-2xx 또는 파싱 불가/형식 이상 → 읽기 경로가 깨진 것(stale로 오인하면 안 됨)
function classifyCart(res, productId) {
  if (res.status < 200 || res.status >= 300) return 'broken';
  try {
    const body = JSON.parse(res.body);
    if (!Array.isArray(body.items)) return 'broken';
    // CartItemResponse.product.id 가 담긴 상품 id (CartProductResponse.id).
    const found = body.items.some(
      (it) => it && it.product && Number(it.product.id) === productId,
    );
    return found ? 'reflected' : 'stale';
  } catch (e) {
    return 'broken';
  }
}

// getCart 응답에서 해당 productId를 담은 cart item의 cartItemId를 찾는다(정리용). 없으면 null.
function findCartItemId(res, productId) {
  if (res.status < 200 || res.status >= 300) return null;
  try {
    const body = JSON.parse(res.body);
    if (!Array.isArray(body.items)) return null;
    const item = body.items.find(
      (it) => it && it.product && Number(it.product.id) === productId,
    );
    return item ? item.cartItemId : null;
  } catch (e) {
    return null;
  }
}

export default function () {
  // 전 VU를 통틀어 유일한 0-based 인덱스 → 동시 실행 중인 어떤 두 iteration도
  // 같은 member/cart를 건드리지 않도록 결정론적으로 배정한다.
  const idx = exec.scenario.iterationInTest;
  const memberId = MEMBERS.min + (idx % MEMBER_SPAN);
  // member가 (재사용 전까지) 유일하므로 어떤 product를 골라도 UNIQUE(cart_id, product_id) 충돌이 없다.
  // 인덱스로 결정론 선택해 재현성을 둔다.
  const productId = PRODUCTS.min + (idx % PRODUCT_SPAN);

  // 0) pre-clean + baseline 확정: 이전 run이 남긴(크래시 등) leftover를 지우고, 쓰기 전에 product가
  //    "실제로 absent" 인지 재확인한다. addItem 은 수량 병합이라 leftover가 남아 있으면 내 쓰기가
  //    즉시 보여 lag가 0으로 왜곡되므로, absent(=깨끗한 baseline)를 확인하지 못하면 이 iteration은 건너뛴다.
  let preRes = getCart(memberId);
  readFailed.add(classifyCart(preRes, productId) === 'broken');
  const leftoverId = findCartItemId(preRes, productId);
  if (leftoverId !== null) {
    const delRes = deleteCartItem(memberId, leftoverId);
    cleanupFailed.add(delRes.status < 200 || delRes.status >= 300); // DELETE 결과도 집계
    preRes = getCart(memberId); // 삭제 반영 재확인
    readFailed.add(classifyCart(preRes, productId) === 'broken');
  }
  // baseline 확정: 'stale'(=정상 2xx인데 product 없음 = absent)이어야 측정 가능.
  // 'reflected'(아직 남아있음) 또는 'broken'(읽기 깨짐)이면 absent→present를 만들 수 없으므로 skip.
  const baselineClean = classifyCart(preRes, productId) === 'stale';
  precleanFailed.add(!baselineClean);
  if (!baselineClean) {
    return; // absent 미확보 → lag 샘플을 남기지 않는다(0-lag 오염 방지).
  }

  // 1) 쓰기: 내 productId를 장바구니에 담고 ACK 시각과 cartItemId(정리용)를 확보한다.
  const writeRes = postCartItem(memberId, { productId, quantity: 1 });
  const writeOk = writeRes.status >= 200 && writeRes.status < 300;
  writeFailed.add(!writeOk); // 실패도 집계 — 버리지 않는다(분포에서 사라지지 않게).
  if (!writeOk) {
    return; // 쓰기 실패 시 지연 측정은 불가하지만 cart_write_failed_rate 에는 남는다.
  }
  const ackAt = Date.now(); // 쓰기 ACK 시각(무효화 지연 측정 기준점)
  let myCartItemId = null;
  try {
    myCartItemId = JSON.parse(writeRes.body).cartItemId;
  } catch (e) {
    myCartItemId = null;
  }

  // 2) 폴링: 내 productId가 반영된 첫 getCart 응답까지의 경과(ms)를 측정한다.
  let reflected = false;
  while (Date.now() - ackAt < POLL_TIMEOUT_MS) {
    const pollRes = getCart(memberId);
    const kind = classifyCart(pollRes, productId);

    // 폴링 읽기가 깨졌는지(비-2xx/파싱불가)를 항상 집계한다. 깨진 응답은 stale로 세지 않는다.
    readFailed.add(kind === 'broken');

    if (kind === 'reflected') {
      // 반영됨: 쓰기 ACK ~ 내 productId가 보인 첫 응답까지 경과를 기록한다.
      invalidationLag.add(Date.now() - ackAt);
      lagSamples.add(1); // 성공 샘플 1건(샘플 수 게이트의 분자)
      reflected = true;
      break;
    }

    // 'stale'(정상 2xx인데 아직 내 쓰기가 안 보임)만 진짜 stale로 집계한다.
    // 'broken'은 cart_read_failed_rate 로만 잡고 stale_reads_total 을 오염시키지 않는다.
    if (kind === 'stale') staleReads.add(1);
    sleep(POLL_INTERVAL_MS / 1000);
  }

  // 타임아웃 안에 반영을 못 본 경우: "측정 실패"로 카운트한다.
  // 옛 구현처럼 POLL_TIMEOUT_MS를 cart_invalidation_lag_ms 샘플로 넣으면 지연 분포가 합성값으로 오염되므로
  // lag Trend에는 넣지 않고 cart_invalidation_timeout_total 게이트로만 드러낸다.
  check(null, { 'invalidation reflected within timeout': () => reflected });
  if (!reflected) {
    notReflected.add(1);
  }

  // 3) self-clean: 측정에 쓴 cart item을 지워 baseline(absent)으로 되돌린다 → 재실행 idempotent.
  //    ★ 정리는 "쓰기 응답의 cartItemId"로만 한다 — 캐시된 getCart 로 다시 찾지 않는다.
  //      DELETE 는 cartItemId→DB 직접 동작이라 read-cache staleness/timeout 과 무관하게 확실히 지운다.
  //      (timeout 으로 폴링이 반영을 못 봤더라도 write 는 성공했으므로 cartItemId 는 유효하다.
  //       옛 구현은 myCartItemId 가 null 일 때 stale 한 getCart 로 fallback → null → 정리 누락 → 다음 run 오염.)
  if (myCartItemId !== null) {
    // 일시적 실패는 재시도한다. 204(삭제) 또는 404(이미 없음)면 baseline(absent) 확보로 본다.
    let cleaned = false;
    for (let attempt = 0; attempt < CLEANUP_RETRIES && !cleaned; attempt++) {
      const delRes = deleteCartItem(memberId, myCartItemId);
      cleaned =
        (delRes.status >= 200 && delRes.status < 300) || delRes.status === 404;
      if (!cleaned) sleep(CLEANUP_RETRY_MS / 1000);
    }
    cleanupFailed.add(!cleaned);
  } else {
    // 2xx 쓰기인데 응답에서 cartItemId 를 못 얻음(응답 계약 위반) → 확실한 정리 불가.
    cleanupFailed.add(true);
  }
}
