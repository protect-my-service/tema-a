# tema-a / loadtests / k6

A팀 공격팀의 `pms-order` 외부 공격/부하 시나리오를 k6로 작성하고 실행하는 워크스페이스입니다.

대상 서버는 `~/Desktop/protectMyService/phase2`이고, 이 문서는 팀원이 정리된 공격 시나리오를 k6 스크립트로 옮길 때 필요한 설치, 구조, 문법, 구현 절차를 설명합니다.

## 1. 사전 준비

### 1-1. k6 설치

macOS 기준:

```bash
brew install k6
k6 version
```

이 프로젝트는 k6 `1.7+` 기준으로 작성합니다.

### 1-2. 타겟 시스템 실행

다른 터미널에서 `phase2` 서버를 먼저 띄웁니다.

```bash
cd ~/Desktop/protectMyService/phase2

docker compose up -d
./gradlew bootRun
```

헬스 체크:

```bash
curl http://localhost:8080/actuator/health
```

정상이라면 다음과 비슷한 응답이 나옵니다.

```json
{"status":"UP"}
```

### 1-3. 테스트 시드 데이터 초기화

`data.sql`은 k6 테스트용 시드 데이터입니다. 회원 100명, 카테고리, 상품 50개, 회원별 장바구니를 다시 생성합니다.

주의: `TRUNCATE ... CASCADE`를 사용하므로 기존 주문/장바구니/상품 관련 데이터가 함께 삭제될 수 있습니다. 테스트 DB를 초기화해야 할 때만 실행합니다.

```bash
cd ~/Desktop/protectMyService/tema-a/loadtests/k6
docker exec -i phase2-postgres-1 psql -U pms -d pms_order < data.sql
```

### 1-4. k6 워크스페이스 이동

```bash
cd ~/Desktop/protectMyService/tema-a/loadtests/k6
```

## 2. 현재 디렉토리 구조

```text
loadtests/k6/
├── README.md
├── data.sql
├── config/
│   └── env.js
├── lib/
│   ├── data.js
│   └── http.js
├── observability/
│   └── README.md
├── reports/
│   └── template.md
├── tests/
│   ├── smoke/
│   │   └── order-create.smoke.js
│   └── attack/
│       └── a02-order-hot-row-lock.js
└── results/
```

역할은 다음처럼 나눕니다.

| 경로 | 역할 |
|---|---|
| `data.sql` | k6 테스트용 DB 시드. 회원/상품/장바구니 데이터를 초기화할 때 사용 |
| `config/env.js` | `BASE_URL`, member/product ID 범위, 공통 threshold 같은 환경 설정 |
| `lib/http.js` | API 호출 헬퍼. 시나리오 파일에서 직접 URL을 조립하지 않고 여기 함수를 import |
| `lib/data.js` | 랜덤/라운드로빈 데이터 선택 헬퍼 |
| `observability/` | k6 결과를 Prometheus/Grafana로 보기 위한 로컬 관측 구성 |
| `reports/` | 테스트별 Grafana 관측 결과와 결론을 정리하는 리포트 템플릿 |
| `tests/smoke/` | 공격 전 엔드포인트, 헤더, 시드 데이터가 맞는지 확인하는 짧은 테스트 |
| `tests/attack/` | 공격 시나리오를 k6로 구현한 실제 공격/부하 테스트 |
| `results/` | k6 raw 결과 JSON 저장 위치 |

새 시나리오를 추가할 때는 아래 원칙을 따릅니다.

| 작업 | 위치 |
|---|---|
| 새 API 호출 추가 | `lib/http.js` |
| 새 데이터 선택 방식 추가 | `lib/data.js` |
| 환경 변수 기본값 추가 | `config/env.js` |
| 정상 동작 검증 | `tests/smoke/{대상}.smoke.js` |
| 공격 구현 | `tests/attack/{atk-id}-{대상}-{포커스}.js` |

## 3. k6 기본 용어

| 용어 | 의미 | 예시 |
|---|---|---|
| VU | Virtual User. 동시에 움직이는 가상 사용자 수 | `vus: 10`이면 가상 사용자 10명이 반복 요청 |
| Iteration | VU가 테스트 본문을 한 번 실행한 횟수 | `default function` 1회 실행 = iteration 1회 |
| Duration | 테스트를 유지하는 시간 | `duration: '30s'`, `DURATION=1m` |
| Scenario | 어떤 패턴으로 부하를 줄지 정의한 실행 단위 | `ramping-vus`로 0명에서 500명까지 증가 |
| Executor | scenario의 실행 방식 | `shared-iterations`, `constant-vus`, `ramping-vus` |
| Stage | ramping 계열 executor에서 VU 증감 구간 | `10s 동안 500 VU까지 증가` |
| Check | 응답이 기대 조건을 만족하는지 기록하는 검증 | `status === 200` |
| Threshold | 테스트 성공/실패를 판단하는 기준 | `http_req_failed: ['rate<0.05']` |
| Metric | k6가 수집하는 측정값 | `http_req_duration`, `http_req_failed` |
| Custom Metric | 직접 정의한 측정값 | `order_5xx_total`, `health_latency_during_attack` |
| Setup | 테스트 시작 전 1회 실행되는 준비 단계 | 공격 전 장바구니에 상품 적재 |
| Teardown | 테스트 종료 후 1회 실행되는 정리/확인 단계 | 최종 장바구니 상태 출력 |

처음 볼 때는 `VU`, `Iteration`, `Duration`만 구분해도 충분합니다. 예를 들어 `vus: 10`, `duration: '30s'`는 10명의 가상 사용자가 30초 동안 `default function`을 반복 실행한다는 뜻입니다.

공격 시나리오에서는 `Check`가 실패하더라도 테스트 자체는 계속 진행됩니다. 반면 `Threshold`는 전체 테스트가 끝났을 때 기준을 넘었는지 판단해서 성공/실패 종료 코드를 결정합니다.

## 4. k6 기본 문법

### 4-1. 최소 스크립트 구조

```javascript
import { check, sleep } from 'k6';
import http from 'k6/http';

export const options = {
  vus: 10,
  duration: '30s',
};

export default function () {
  const res = http.get('http://localhost:8080/actuator/health');

  check(res, {
    'health 200': (r) => r.status === 200,
  });

  sleep(1);
}
```

핵심은 `options`와 `default function`입니다.

| 요소 | 의미 |
|---|---|
| `options` | VU 수, 실행 시간, 시나리오, threshold를 정의 |
| `default` | 각 VU가 반복 실행하는 본문 |
| `check` | 응답 검증. 실패해도 테스트는 계속 진행 |
| `sleep` | 요청 사이 간격 조절 |

### 4-2. 라이프사이클

```javascript
export function setup() {
  return { targetProduct: 3 };
}

export default function (data) {
  // VU가 반복 실행
}

export function teardown(data) {
  // 테스트 종료 후 1회 실행
}
```

| 함수 | 실행 시점 | 사용 예 |
|---|---|---|
| `setup` | 테스트 시작 전 1회 | 토큰 발급, 사전 데이터 생성 |
| `default` | 각 VU의 반복 실행 | 실제 부하 요청 |
| `teardown` | 테스트 종료 후 1회 | 최종 상태 조회, 로그 출력 |

### 4-3. 환경 변수

k6에서는 `__ENV`로 외부 값을 받습니다.

```javascript
const VUS = parseInt(__ENV.VUS || '100', 10);
const DURATION = __ENV.DURATION || '1m';
const TARGET_PRODUCT = parseInt(__ENV.TARGET_PRODUCT || '3', 10);
```

실행 시:

```bash
VUS=500 DURATION=30s TARGET_PRODUCT=3 k6 run tests/attack/example.js
```

시나리오 파일에 값을 박아두지 말고, 공격 강도와 대상 ID는 가능한 환경 변수로 열어둡니다.

### 4-4. 시나리오 executor

`options.scenarios`를 쓰면 부하 패턴을 명확하게 표현할 수 있습니다.

```javascript
export const options = {
  scenarios: {
    attack: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '10s', target: 500 },
        { duration: '30s', target: 500 },
        { duration: '5s', target: 0 },
      ],
    },
  },
};
```

자주 쓰는 executor:

| executor | 용도 |
|---|---|
| `shared-iterations` | 총 반복 횟수를 정해 빠르게 검증 |
| `constant-vus` | 일정한 VU로 지속 부하 |
| `ramping-vus` | VU를 올렸다 내리는 load/stress/spike 패턴 |
| `constant-arrival-rate` | 초당 요청 수를 고정 |

공격 시나리오는 보통 `ramping-vus`로 순간 증가를 만들거나, `shared-iterations`로 특정 취약 입력을 반복 주입합니다.

### 4-5. Threshold와 커스텀 메트릭

threshold는 테스트 통과/실패 기준입니다.

```javascript
export const options = {
  thresholds: {
    http_req_failed: ['rate<0.05'],
    http_req_duration: ['p(95)<500'],
  },
};
```

공격 테스트는 의도적으로 실패를 유도하므로 일반 성능 테스트보다 threshold를 느슨하게 둡니다. 대신 가설을 검증할 커스텀 메트릭을 추가합니다.

```javascript
import { Counter, Trend, Rate } from 'k6/metrics';

const order5xx = new Counter('order_5xx_total');
const orderLatency = new Trend('order_latency_ms', true);
const lockFailed = new Rate('lock_failed_rate');
```

예를 들어 락 경합 시나리오라면 단순히 `http_req_failed`만 보지 말고, p95/p99 지연, 5xx 수, timeout 비율, 헬스 체크 지연을 같이 봅니다.

## 5. 공통 모듈 작성 방식

### 5-1. `config/env.js`

현재 프로젝트는 `BASE_URL`, member/product ID 범위, 공통 threshold를 여기서 관리합니다.

```javascript
export const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';

export const MEMBERS = {
  min: parseInt(__ENV.MEMBER_MIN || '1', 10),
  max: parseInt(__ENV.MEMBER_MAX || '100', 10),
};

export const PRODUCTS = {
  min: parseInt(__ENV.PRODUCT_MIN || '1', 10),
  max: parseInt(__ENV.PRODUCT_MAX || '50', 10),
};

export const baseThresholds = {
  http_req_failed: ['rate<0.95'],
  http_req_duration: ['p(95)<60000'],
};
```

### 5-2. `lib/http.js`

API 호출은 시나리오 파일 안에 직접 쓰지 않고 헬퍼로 뺍니다.

현재 장바구니 API는 다음 형태입니다.

```javascript
import http from 'k6/http';
import { BASE_URL } from '../config/env.js';

export function headers(memberId) {
  return {
    'Content-Type': 'application/json',
    'X-Member-Id': String(memberId),
  };
}

export function postCartItem(memberId, body, params = {}) {
  return http.post(
    `${BASE_URL}/api/v1/cart/items`,
    JSON.stringify(body),
    { headers: headers(memberId), ...params },
  );
}
```

주문 생성 시나리오를 추가한다면 같은 파일에 아래처럼 확장합니다.

```javascript
export function postOrder(memberId, body, params = {}) {
  return http.post(
    `${BASE_URL}/api/v1/orders`,
    JSON.stringify(body),
    { headers: headers(memberId), ...params },
  );
}
```

이렇게 해두면 시나리오 파일은 공격 로직만 표현하고, HTTP 세부 구현은 공통 모듈에 모입니다.

### 5-3. `lib/data.js`

대상 ID를 고르는 로직도 공통화합니다.

```javascript
import { MEMBERS, PRODUCTS } from '../config/env.js';

const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

export const pickMember = () => randInt(MEMBERS.min, MEMBERS.max);
export const pickProduct = () => randInt(PRODUCTS.min, PRODUCTS.max);
```

핫 로우 공격처럼 특정 상품에 몰아야 할 때는 랜덤 대신 `TARGET_PRODUCT`를 씁니다. 반대로 row 증식처럼 상품을 분산해야 할 때는 라운드로빈 선택을 씁니다.

## 6. 예시: ATK-A02 동일 상품 집중 주문 락 경합

아래 공격 시나리오를 예시로 잡습니다.

| 항목 | 내용 |
|---|---|
| 구분 | `[기능 A] 주문 생성` |
| ID | `ATK-A02` |
| 시나리오명 | 동일 상품 집중 주문 락 경합 |
| 키워드 | `락경합`, `핫로우` |
| 목표 가설 | 특정 상품에 주문이 몰릴 때 비관적 락 대기로 인해 요청이 직렬화되고 타임아웃이 발생한다. |
| 가설 근거 | `findByIdWithLock()`, `lock.timeout: 3000` |
| 예상 문제점 | 응답 지연 증가 및 일부 주문 실패 |

### 6-1. 구현 전략

이 시나리오는 모든 VU가 같은 `TARGET_PRODUCT`로 주문을 생성하게 만들어 상품 row 하나에 락 경합을 집중시킵니다.

검증할 신호:

| 신호 | 의미 |
|---|---|
| `http_req_duration` p95/p99 | 락 대기 때문에 응답 시간이 증가하는지 |
| `http_req_failed` | timeout/5xx 비율이 증가하는지 |
| `order_latency_ms` | 주문 요청만 따로 본 지연 시간 |
| `order_5xx_total` | 서버 오류 누적 수 |
| 헬스 체크 지연 | 공격 중 정상 API까지 영향을 받는지 |

### 6-2. 필요한 HTTP 헬퍼

`lib/http.js`에 주문 생성 헬퍼가 없다면 추가합니다.

```javascript
export function postOrder(memberId, body, params = {}) {
  return http.post(
    `${BASE_URL}/api/v1/orders`,
    JSON.stringify(body),
    { headers: headers(memberId), ...params },
  );
}
```

### 6-3. 스모크 테스트 예시

파일명 예시:

```text
tests/smoke/order-create.smoke.js
```

```javascript
import { check } from 'k6';
import { pickMember } from '../../lib/data.js';
import { postCartItem, postOrder } from '../../lib/http.js';

const TARGET_PRODUCT_ID = parseInt(__ENV.TARGET_PRODUCT || '1', 10);

export const options = {
  vus: 1,
  iterations: 5,
  thresholds: {
    http_req_failed: ['rate<0.05'],
    http_req_duration: ['p(95)<1000'],
  },
};

export default function () {
  const memberId = pickMember();

  const cartRes = postCartItem(memberId, {
    productId: TARGET_PRODUCT_ID,
    quantity: 1,
  });

  check(cartRes, {
    'cart add 2xx': (r) => r.status >= 200 && r.status < 300,
  });

  if (cartRes.status < 200 || cartRes.status >= 300) {
    return;
  }

  const cartBody = JSON.parse(cartRes.body);
  const cartItemId = cartBody.cartItemId;

  const orderRes = postOrder(memberId, {
    cartItemIds: [cartItemId],
  });

  check(orderRes, {
    'order create 2xx': (r) => r.status >= 200 && r.status < 300,
  });
}
```

스모크는 공격이 아니라 환경 확인입니다. 여기서 전부 실패하면 공격 시나리오를 실행하지 말고 `BASE_URL`, `X-Member-Id`, 시드 ID 범위, 요청 body를 먼저 확인합니다.

### 6-4. 공격 테스트 예시

파일명 예시:

```text
tests/attack/a02-order-hot-row-lock.js
```

```javascript
import { check } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import { baseThresholds } from '../../config/env.js';
import { postCartItem, postOrder, getHealth } from '../../lib/http.js';
import { pickMember } from '../../lib/data.js';

const DURATION = __ENV.DURATION || '5s';
const TARGET_PRODUCT_ID = parseInt(__ENV.TARGET_PRODUCT || '9', 10);
const VUS = parseInt(__ENV.VUS || '20', 10);
const SLEEP_SECONDS = parseFloat(__ENV.SLEEP || '1');
const HEALTH_SLEEP_SECONDS = parseFloat(__ENV.HEALTH_SLEEP || '1');

const orderLatency = new Trend('order_latency_ms', true);
const order5xx = new Counter('order_5xx_total');
const order4xx = new Counter('order_4xx_total');
const orderFailed = new Rate('order_failed_rate');
const healthLatency = new Trend('health_latency_during_attack', true);

export const options = {
  scenarios: {
    // 모든 VU가 같은 TARGET_PRODUCT로 주문을 시도해 product row 락 경합을 만든다.
    hot_row_order: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: __ENV.RAMP_UP || '2s', target: VUS },
        { duration: DURATION, target: VUS },
        { duration: '5s', target: 0 },
      ],
    },
    health_probe: {
      executor: 'constant-vus',
      vus: 1,
      duration: __ENV.PROBE_DURATION || '60s',
      exec: 'checkHealth',
    },
  },
  thresholds: {
    ...baseThresholds,
    order_failed_rate: ['rate<1.00'],
    order_5xx_total: ['count<100'],
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
```

실행 명령은 아래 `7. 현재 구현된 시나리오 실행`에서 한 번만 관리합니다.

## 7. 현재 구현된 시나리오 실행

### 7-1. smoke 테스트 실행

```bash
# smoke 실행 전 k6 테스트용 시드 상태로 초기화
docker exec -i phase2-postgres-1 psql -U pms -d pms_order < data.sql

# 주문 생성 smoke: smoke 실행 결과 체크리스트 참고
k6 run tests/smoke/order-create.smoke.js

# TARGET_PRODUCT로 smoke에 사용할 상품 ID를 지정
TARGET_PRODUCT=1 k6 run tests/smoke/order-create.smoke.js

# smoke raw JSON 저장
k6 run --out json=results/order-create-smoke.json \
  tests/smoke/order-create.smoke.js
```

### smoke 실행 결과 체크리스트

| 섹션 | 결과 항목 | 통과 기준 | 의미 |
|---|---|---|---|
| `THRESHOLDS` | `http_req_duration` | `✓ 'p(95)<1000'` | 요청 95%가 1초 안에 끝났는지 확인 |
| `THRESHOLDS` | `http_req_failed` | `✓ 'rate<0.05'` | HTTP 요청 실패율이 5% 미만인지 확인 |
| `TOTAL RESULTS` | `checks_succeeded` | `100.00%` | 코드에서 정의한 `check()`가 모두 통과했는지 확인 |
| `TOTAL RESULTS` | `cart add 2xx` / `order create 2xx` | 둘 다 `✓` | 장바구니 추가와 주문 생성이 정상 응답했는지 확인 |
| `HTTP` | `http_req_failed` | `0.00%`에 가까울수록 좋음 | 실제 HTTP 요청 실패 비율 |
| `HTTP` | `http_reqs` | `10` | iteration 5회마다 장바구니 추가 1회 + 주문 생성 1회가 실행됐는지 확인 |
| `EXECUTION` | `iterations` | `5` | 설정한 반복 횟수가 모두 끝났는지 확인 |

### 7-2. 공격 시나리오 실행
```bash
# 공격 시나리오 실행 전 k6 테스트용 시드 상태로 초기화
docker exec -i phase2-postgres-1 psql -U pms -d pms_order < data.sql

# ATK-A02: 동일 상품 집중 주문 락 경합
k6 run tests/attack/a02-order-hot-row-lock.js

# 공격 강도를 바꿔 실행
TARGET_PRODUCT=9 VUS=50 DURATION=10s k6 run tests/attack/a02-order-hot-row-lock.js

# ATK-A02 raw JSON과 summary JSON 저장
k6 run \
  --out json=results/a02-vus20-target9.json \
  --summary-export=results/a02-vus20-target9-summary.json \
  tests/attack/a02-order-hot-row-lock.js
```

## 8. ATK-A02 결과 해석

이 섹션은 `ATK-A02 동일 상품 집중 주문 락 경합`에 한정한 해석 기준입니다. 다른 공격 시나리오는 각 가설에 맞는 메트릭과 DB 상태를 별도로 정의합니다.

ATK-A02는 성공 요청 수만 보는 시나리오가 아닙니다. 아래 현상이 같이 보이면 가설 재현으로 판단할 수 있습니다.

| 관측값 | 해석 |
|---|---|
| `http_req_duration` p95/p99 증가 | 락 대기 또는 커넥션 대기가 누적됨 |
| `order_failed_rate` 증가 | timeout, 4xx, 5xx 등 주문 실패 증가 |
| `order_5xx_total` 증가 | 서버 내부 예외 또는 락 timeout이 사용자 오류로 노출될 가능성 |
| `health_latency_during_attack` 증가 | 공격 트래픽이 정상 API까지 영향을 줌 |

결과를 정리할 때는 최소한 아래 항목을 남깁니다.

```text
ATK ID:
실행 명령:
TARGET_PRODUCT:
VUS / DURATION:
http_req_duration p95/p99:
http_req_failed:
커스텀 메트릭:
서버 로그 주요 에러:
가설 검증 결과:
```

Grafana로 시간 흐름을 확인해야 한다면 [observability/README.md](./observability/README.md)를 참고합니다.
