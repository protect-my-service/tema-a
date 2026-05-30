# Week2 캐싱 조회 성능 리포트 (Before / After)

> 캐시 적용 전(off) / 후(on)을 동일 조건에서 비교한다.
> k6는 조회 p99 / RPS / 무효화 지연만 직접 측정한다.
> 캐시 히트율 / DB QPS는 k6가 못 잡으므로 Actuator + Prometheus에서 수집한다
> (PromQL은 `docs/week2-cache-guide.md` 참고).

## 1. 측정 환경 (Before / After 동일해야 비교 성립)

| 항목 | 내용 |
|---|---|
| 대상 서버 커밋 (Before) |  |
| 대상 서버 커밋 (After) |  |
| Spring 프로파일 |  |
| 캐시 전략 (Caffeine / Redis / 다층 등) |  |
| 캐시 설정 (TTL / max size / 무효화 방식) |  |
| k6 버전 |  |
| 시드 (`data-cache.sql` 적용 여부 / 규모) |  |
| `BASE_URL` |  |
| `TARGET_PRODUCT` |  |
| `RATE` (도착률) |  |
| `DURATION` |  |
| `COLD_RATIO` |  |
| `MODE` (steady / stampede) |  |
| 측정 시각 (Before) |  |
| 측정 시각 (After) |  |

실행 명령:

```bash
# BEFORE (캐시 off)
RATE=200 DURATION=1m TARGET_PRODUCT=1 COLD_RATIO=0.1 ./scripts/run-read-before.sh

# AFTER (캐시 on, 동일 RATE/DURATION)
RATE=200 DURATION=1m TARGET_PRODUCT=1 COLD_RATIO=0.1 ./scripts/run-read-after.sh

# 무효화 지연
ITERATIONS=200 ./scripts/run-invalidation.sh
```

## 2. 합격 기준표

| 지표 | 측정 출처 | 합격선 | Before | After | 개선율 |
|---|---|---|---|---|---|
| 조회 API p99 | k6 `read_latency_ms` p(99) (조회 전용) | p99 < 200ms |  |  |  |
| 캐시 히트율 | Prometheus `cache_gets_total{result="hit"}` 비율 | ≥ 90% |  |  |  |
| DB QPS | Prometheus `pg_stat_database_xact_commit` rate (또는 pg_stat_statements) | Before 대비 ↓ |  |  |  |
| 무효화 지연 (장바구니 캐시) | k6 `cart_invalidation_lag_ms` p95 | < 1s |  |  |  |
| 동시 처리 RPS | k6 `read_reqs` rate (조회 전용 카운터) | Before 대비 ↑ |  |  |  |

> 개선율 = (Before - After) / Before × 100 (지연/QPS는 감소가 개선, RPS·히트율은 증가가 개선).
> 캐시 히트율과 DB QPS는 k6 출력에 없다. 반드시 Prometheus 값을 적는다.
> ⚠ **무효화 지연의 범위**: `cart_invalidation_lag_ms`는 **장바구니 캐시** 무효화 지연이다.
> 읽기 벤치마크가 캐싱하는 **상품 상세(GET /products/{id}) 캐시의 무효화 합격 근거로 쓰지 말 것**
> (주문 서비스에 상품 변경 엔드포인트가 없어 product-cache 무효화는 이 하니스로 측정 불가).
> 상품 캐시 무효화를 봐야 하면 "상품 변경 쓰기 → getProduct 폴링" 경로를 별도로 만들어 측정한다.
> RPS는 `http_reqs`(health probe 요청까지 섞임)가 아니라 조회 전용 `read_reqs` rate를 쓴다.
> AFTER 합격선(p99) 판정은 `USE_THRESHOLDS=1 ./scripts/run-read-after.sh`로 실행해야 실제로 강제된다
> (조회 전용 `read_latency_ms` p99·`read_failed_rate`에 건다). 기본 실행은 수치 비교만 한다.

> **측정 유효성 게이트(아래 메트릭이 fail이면 그 측정은 신뢰하지 말 것)**:
> 조회 부하는 `dropped_iterations`(요청 미발사)와 `read_reqs` rate(처리량이 RATE의 95% 미만)를
> steady 모드에서 강제한다 — VU 고갈로 부하가 덜 발사되면 p99가 좋아 보여도 무효다.
> `preAllocatedVUs`/`maxVUs`를 늘리거나 `RATE`를 낮춰 통과시킨 뒤 비교한다.
> 무효화는 `cart_read_failed_rate`(폴링 읽기 깨짐)와 `cart_invalidation_timeout_total`(미반영)을 게이트로 둔다.

### 보조 메트릭 (k6)

| 메트릭 | Before | After | 비고 |
|---|---|---|---|
| `read_reqs` rate |  |  | 조회 전용 처리량(=동시 처리 RPS 출처). steady에서 RATE의 95%+ 강제 |
| `dropped_iterations` |  |  | VU 고갈로 발사 못한 요청 수(0이어야 유효) |
| `read_latency_ms` p95/p99 |  |  | 조회만 분리한 지연(합격선 판정 대상) |
| `read_5xx_total` |  |  | 캐시/DB 계층 오류 노출 |
| `read_failed_rate` |  |  | 조회 실패율(합격선 판정 대상) |
| `health_latency_during_attack` p99 |  |  | 조회 폭주 중 사이트 전체 영향 |
| `stale_reads_total` |  |  | 무효화 전 옛 값 응답 횟수(정상 2xx 한정) |
| `cart_write_failed_rate` |  |  | 무효화 측정용 쓰기 실패율 |
| `cart_read_failed_rate` |  |  | 무효화 폴링 조회 깨짐 비율(0에 가까워야 유효) |
| `cart_invalidation_preclean_failed_rate` |  |  | 쓰기 전 baseline(absent) 미확보 비율 |
| `cart_invalidation_samples_total` |  |  | 실제 lag 남긴 성공 샘플 수(계획 대비 95%↑ 게이트 — 거짓 통과 방지) |
| `cart_invalidation_timeout_total` |  |  | 상한 내 미반영 횟수(정상 측정이면 0) |

## 3. 발표 필수 답변 4종

### ① 무효화 시점: 동기 / 비동기와 일관성

```text
- 무효화를 언제 수행하는가? (쓰기 트랜잭션 커밋 직후 동기 / 이벤트 기반 비동기 / TTL 만료)
- 동기 무효화의 일관성 vs 지연 트레이드오프:
- 비동기 무효화의 지연 창(stale window) 크기와 허용 근거:
- 측정값(cart_invalidation_lag_ms p95)으로 본 실제 지연(장바구니 캐시 범위):
```

### ② Cache Stampede(캐시 스탬피드) 대응

```text
- 핫키 동시 만료/콜드 키 동시 진입 시 DB로 요청이 몰리는 현상을 어떻게 막는가?
  (mutex/single-flight, 분산 락, 확률적 조기 갱신(probabilistic early expiration), 캐시 워밍 등)
- MODE=stampede 측정에서 관측된 현상(read p99 스파이크 / DB QPS 스파이크):
- 대응 적용 전/후 차이:
```

### ③ 캐시-DB 불일치: 진실의 원천(source of truth) + 복구

```text
- 진실의 원천은 DB임을 어떻게 보장하는가?
- 캐시와 DB가 어긋났을 때 감지 방법:
- 복구 절차(캐시 무효화/전체 flush/TTL로 자연 회복):
- 잘못된 캐시가 전파되는 최악 시간(= 최대 stale window):
```

### ④ 무효화 누락(이벤트 유실/장애) 강건성

```text
- 무효화 이벤트가 유실되면 어떻게 되는가?
- TTL을 안전망(backstop)으로 두는가? TTL 값과 근거:
- 무효화 누락을 감지/복구하는 수단:
- 캐시 장애(다운/네트워크 단절) 시 폴백(캐시 우회 → DB 직접) 동작:
```

## 4. 결론

| 항목 | 내용 |
|---|---|
| 판단 (캐시 효과 입증 여부) |  |
| 핵심 근거 (p99 / 히트율 / DB QPS 비교) |  |
| 남은 리스크 (stampede / 무효화 누락 등) |  |
| 후속 조치 |  |
