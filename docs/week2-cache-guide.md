# Week2 캐싱 조회 성능 측정 가이드

캐시 적용 전(off) / 후(on)을 **동일 조건**에서 비교 측정하기 위한 실행 절차와 관측 연동 안내.

- k6가 직접 측정: **조회 API p99 / 동시 처리 RPS / 무효화 지연**
- k6가 못 잡는 것: **캐시 히트율 / DB QPS** → Actuator + Prometheus에서 수집 (아래 4장)

대상 서버: `~/Projects/study/pms-order-bteam`
측정 엔드포인트:

| 메서드 | 경로 | 응답 | 용도 |
|---|---|---|---|
| GET | `/api/v1/products/{productId}` | `ProductDetailResponse` | 핫스팟 조회 주 대상 |
| GET | `/api/v1/products?categoryId=&page=&size=` | `Page<ProductListResponse>` | 목록 조회 |
| GET | `/api/v1/orders/{orderId}` (헤더 `X-Member-Id`) | `OrderResponse` | 회원 격리 조회 |
| GET | `/api/v1/cart` (헤더 `X-Member-Id`) | `CartResponse` | 무효화 측정 매개 |
| GET | `/api/v1/categories` | 정적 | 정적 데이터 |

---

## 1. 사전 준비

```bash
# k6 설치 (macOS)
brew install k6 && k6 version

# 대상 서버 기동
cd ~/Projects/study/pms-order-bteam
docker compose up -d
./gradlew bootRun

# 헬스 체크
curl http://localhost:8080/actuator/health   # {"status":"UP"}
```

## 2. 시드 적용

`loadtests/k6/data-cache.sql`은 대규모 시드(회원 10,000 / 상품 50,000 / 핫상품 id=1 / PAID 주문 200,000)다.
캐시가 전체를 못 담게 충분히 커서 히트(핫상품)/미스(롱테일) 구분이 생긴다.

```bash
cd ~/Projects/study/tema-a/loadtests/k6
./scripts/seed.sh
# 또는 직접:
# docker exec -i pms-order-bteam-postgres-1 psql -U pms -d pms_order < data-cache.sql
```

> 주의: `TRUNCATE ... CASCADE`로 기존 데이터가 삭제되고, 대규모라 적용에 수십 초~수 분 걸린다.

## 3. 측정 실행

> 러너 스크립트(`run-read-before/after`, `run-invalidation`)는 본 측정 전에 **preflight smoke**를
> 자동 실행한다. BASE_URL/시드/엔드포인트가 잘못되면 벤치마크를 돌리지 않고 중단해
> "에러를 벤치마킹한" 잘못된 결과 파일이 생기지 않게 한다. 또한 조회 실패율(`read_failed_rate`)이
> `READ_FAIL_MAX`(기본 5%)를 넘으면 측정 자체가 fail 처리된다(p99 합격선과 무관하게 항상 적용).
>
> 시드 ID 범위: `config/env.js` 기본값은 기존 소형 시드(회원 100/상품 50)에 맞춰져 있고(1주차 테스트와 공유),
> Week2 러너 스크립트가 대규모 시드용 `MEMBER_MAX=10000 PRODUCT_MAX=50000`을 자동 전달한다.
> k6를 직접(러너 없이) 돌릴 때는 이 두 값을 `-e`로 직접 넘겨야 콜드 키/회원이 50,000/10,000 범위를 쓴다.

```bash
cd ~/Projects/study/tema-a/loadtests/k6

# 0) 스모크: 엔드포인트/시드 확인 (러너가 preflight로 자동 실행하지만 수동 확인도 가능)
k6 run tests/smoke/product-read.smoke.js

# 1) BEFORE (캐시 off) — p99 합격선 없이 기준선 수집(정확성 게이트 + preflight는 적용)
RATE=200 DURATION=1m TARGET_PRODUCT=1 COLD_RATIO=0.1 ./scripts/run-read-before.sh

# 2) (여기서 캐시 ON 빌드/프로파일로 서버 재기동)

# 3) AFTER (캐시 on) — BEFORE와 동일 RATE/DURATION
RATE=200 DURATION=1m TARGET_PRODUCT=1 COLD_RATIO=0.1 ./scripts/run-read-after.sh

# 합격선까지 판정하려면 (p99<200 기본):
USE_THRESHOLDS=1 READ_P99_MS=200 RATE=200 DURATION=1m ./scripts/run-read-after.sh

# 4) 무효화 지연
ITERATIONS=200 POLL_INTERVAL_MS=20 ./scripts/run-invalidation.sh

# 5) Cache Stampede 관측 (콜드 키 동시 진입)
MODE=stampede COLD_RATIO=0.9 RATE=200 DURATION=30s ./scripts/run-read-after.sh
```

결과 JSON / summary는 `results/`에 `read-before-*`, `read-after-*`, `invalidation-*` 형태로 저장된다.
리포트는 `loadtests/k6/reports/week2-cache.template.md`를 복사해 채운다.

> **Before/After 비교 원칙**: `RATE`/`DURATION`/`TARGET_PRODUCT`/`COLD_RATIO`/시드를 동일하게 둔다.
> 달라지면 p99·RPS 비교가 무의미하다.

---

## 4. 관측 연동 (캐시 히트율 / DB QPS는 여기서 본다)

### 4-1. 앱 측 선행조건 — 히트율 지표 노출

히트율 지표(`cache_gets_total`)는 **`@Cacheable` + statistics를 켠 CacheManager**가 있어야 Micrometer가 노출한다.
(Prometheus 엔드포인트 자체는 이미 노출됨: `/actuator/prometheus`.)

- **Caffeine**: 캐시 빌더에 `recordStats()`를 켜야 한다.
  ```java
  Caffeine.newBuilder().recordStats().maximumSize(10_000).expireAfterWrite(Duration.ofMinutes(5));
  ```
- **Redis(`RedisCacheManager`)**: `enableStatistics()`(`RedisCacheManagerBuilder.enableStatistics()`)를 켜야
  `cache_gets_total{result="hit|miss"}`가 나온다.
- 공통: `MeterRegistry`에 캐시가 바인딩되어야 한다(Spring Boot `@Cacheable` 캐시는 보통 자동 바인딩).
- 확인:
  ```bash
  curl -s http://localhost:8080/actuator/prometheus | grep cache_gets_total
  ```
  값이 안 나오면 statistics 미설정 또는 캐시 미바인딩이다.

### 4-2. PromQL 스니펫

```promql
# 캐시 히트율 (1분 윈도우)
sum(rate(cache_gets_total{result="hit"}[1m]))
  / sum(rate(cache_gets_total[1m]))

# DB QPS — 1순위: 커밋 트랜잭션 레이트
rate(pg_stat_database_xact_commit{datname="pms_order"}[1m])
# 더 정밀하게 보고 싶으면 pg_stat_statements (calls 증가량) 사용.
# postgres_exporter / pg_stat_statements 가 없으면 앱 측 fallback:
rate(hibernate_query_executions_total[1m])

# 조회 API p99 (핫스팟 엔드포인트)
histogram_quantile(0.99,
  rate(http_server_requests_seconds_bucket{uri="/api/v1/products/{productId}"}[1m]))
```

> `http_server_requests_*`는 서버 측 Micrometer 지표다(앱 `/actuator/prometheus`).
> k6의 `http_req_duration` p99(클라이언트 측)와 함께 보면 네트워크/큐잉 영향을 분리할 수 있다.

### 4-3. docker-compose 추가 안내 (스니펫만 — 실제 배선은 구현 PR)

캐시 전략 A/B/C 비교를 위해 Redis, DB QPS 정밀 측정을 위해 exporter를 붙일 수 있다.
아래는 **참고 스니펫**이며 실제 네트워크/스크레이프 배선은 별도 구현 PR에서 한다.

```yaml
# (참고) Redis — 전략 A/B/C(로컬/원격/다층) 비교용
redis:
  image: redis:7-alpine
  ports:
    - "6379:6379"

# (선택) postgres_exporter — DB QPS / 트랜잭션 지표
postgres_exporter:
  image: prometheuscommunity/postgres-exporter:latest
  environment:
    DATA_SOURCE_NAME: "postgresql://pms:pms@postgres:5432/pms_order?sslmode=disable"
  ports:
    - "9187:9187"

# (선택) redis_exporter — 캐시 적중/메모리 지표
redis_exporter:
  image: oliver006/redis_exporter:latest
  environment:
    REDIS_ADDR: "redis://redis:6379"
  ports:
    - "9121:9121"
```

Prometheus가 위 exporter들을 스크레이프하도록 `observability/prometheus/prometheus.yml`에
`scrape_configs` job을 추가해야 한다(구현 PR에서 배선).

---

## 5. 측정 지표 ↔ 출처 정리

| 지표 | 출처 | 비고 |
|---|---|---|
| 조회 API p99 | **k6** `read_latency_ms` p(99) | 조회 전용(health 제외). AFTER 합격선도 이 값에 건다 |
| 동시 처리 RPS | **k6** `read_reqs` rate | 조회 전용 카운터. `http_reqs`는 health probe가 섞여 부적합 |
| 무효화 지연 (장바구니 캐시) | **k6** `cart_invalidation_lag_ms` | 쓰기 ACK ~ getCart 반영 경과. ⚠ 상품 상세 캐시 무효화 아님(범위 주의) |
| 캐시 히트율 | **Prometheus** `cache_gets_total` | k6로는 측정 불가 |
| DB QPS | **Prometheus** `pg_stat_database_xact_commit` / `pg_stat_statements` | k6로는 측정 불가 |

> **핵심**: 캐시 히트율과 DB QPS는 k6가 절대 직접 내지 못한다. 반드시 Prometheus 값을 리포트에 적는다.
