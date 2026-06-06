# Week3 비동기 아키텍처 순서 보장 실습 가이드

RabbitMQ 비동기 처리의 세 함정(**순서·중복·유실**)을 직접 만들고, 방어 적용 **전/후**를 동일 조건에서 정량 비교한다. 1차 공방전 **ATK-C03(메시지 유실 심화 — RabbitMQ 강제 중단)**을 베이스라인으로 재현한다.

- k6가 만드는 것: **주문 lifecycle 부하**(cart→order→pay→cancel) + **RabbitMQ 장애 주입**
- 수치를 만드는 것: 앱의 **관찰 싱크 `consumed_events`** + **DB** + **RabbitMQ 큐 잔량** + k6 summary → `verify-w3.sh`가 계산

대상 서버: `~/Projects/study/pms-order-bteam`

> ⚠ **이 하니스는 "방어"를 제공하지 않는다.** 앱에 추가하는 것은 **측정 전용 관찰 싱크**(`consumed_events`)뿐이다.
> 방어(Outbox/Saga/파티션키/Confirms+DLQ/CDC)는 **각자 구현**한다(참고 구현 미제공).

---

## 0. 측정 모델 (왜 이렇게 재나)

기존 `mq_consumer_processed_total` 카운터만으로는 유실·중복·순서를 **분리 측정할 수 없다**(처리 "시도" 수만 주고 event-id/브로커 도달 수가 없어 미지수 2개·식 1개). 그래서 진실 원천 2개를 대조한다.

| 진실 | 출처 | 무엇 |
|---|---|---|
| **(P) 발행 기대** | k6 `w3_expected_created/paid/cancelled` (`--summary-export`) | HTTP 결과로 본 "발행됐어야 할" 이벤트 수 |
| **(C) 실제 도착** | 앱 `consumed_events` 테이블 (event_id·redelivered·event_timestamp·received_at) | 컨슈머에 실제 도착한 모든 delivery |

산출:
- **유실** = `expected(P) − distinct_arrived(C) − 큐 잔량(main+dlq)`. 장애 중 `AFTER_COMMIT` 발행이 조용히 실패하면 HTTP는 200인데 C에 없음 → 유실로 포착.
- **중복** = `total_rows(C) − distinct(event_id)` 또는 `redelivered=true` 행 수(브로커 재기동 재전달).
- **순서 꼬임** = 주문별 `received_at`이 created<paid<cancelled를 위반한 비율(3큐+동시성으로 구조적 미보장).
- **E2E p99** = `received_at − event_timestamp`(producer 발생 시각) 분포의 p99 → 진짜 wall-clock 지연.
- **lag 회복** = 재기동 후 `messages_ready`가 0으로 빠지는 시간.

---

## 1. 사전 준비

```bash
# k6 + jq (macOS). jq는 verify-w3.sh의 큐/요약 JSON 파싱에 쓴다(없으면 grep 폴백으로 동작하나 권장).
brew install k6 jq && k6 version

# 대상 서버 + 인프라
cd ~/Projects/study/pms-order-bteam
docker compose up -d              # postgres:5432, rabbitmq:5672 + mgmt:15672
./gradlew bootRun

# 헬스/계측/Mgmt 확인
curl http://localhost:8080/actuator/health                       # {"status":"UP"}
curl -s http://localhost:8080/actuator/prometheus | grep mq_consumer_processed  # 카운터 존재
curl -s http://guest:guest@localhost:15672/api/queues/%2F/order.created.queue | head -c 80  # mgmt OK
```

### 1-1. 측정 계측 적용 (관찰 싱크) — **필수**

`pms-order-bteam`에 다음이 포함돼 있어야 한다(측정 전용, 방어 아님):
- Flyway `V2__consumed_events.sql` (테이블)
- `infra/observability/Consumed*` (엔티티/리포지토리/Recorder)
- `RabbitMQEventConsumer`가 도착 시 `consumed_events`에 기록

```bash
# 앱 기동 후 테이블 존재 확인
docker exec -i pms-order-bteam-postgres-1 psql -U pms -d pms_order -c '\d consumed_events'
```

### 1-2. 교란요인 차단 (깨끗한 베이스라인) — 권장

`ConsumerSimulator`의 랜덤 실패(0.5%)가 DLQ로 새어 유실/중복 신호를 오염시킨다. **실패율 0**으로 두고, 지연(랜덤 처리시간, lag 형성)은 유지한다.

```bash
# bootRun 시 환경변수로(코드 수정 아님)
CONSUMER_SIMULATION_FAILURE_RATE=0 ./gradlew bootRun
# 또는 application-local.yml 에 consumer.simulation.failure-rate: 0
```

> 결제 랜덤 실패(~5%)는 `ExternalPaymentClient`에 하드코딩돼 있어 끄지 않는다. k6는 이를 `w3_payment_failed`로
> 관측만 하고 **expected에는 더하지 않는다**: `PaymentService`가 같은 `@Transactional` 안에서 재throw 하므로
> 자동취소가 롤백되어 **cancelled 이벤트가 발행되지 않고**(AFTER_COMMIT 미발생) 주문은 PENDING에 잔류한다.
> (이 "결제 실패 시 자동취소가 같은 트랜잭션 롤백으로 무위가 되는" 동작 자체도 관찰할 만한 정합성 포인트다.)

## 2. 시드

기존 소형 시드(`data.sql`, 회원 100/상품 50)를 재사용한다. lifecycle이 매 iteration `cart add → order`로 자기완결하므로 별도 시드가 필요 없다.

```bash
docker exec -i pms-order-bteam-postgres-1 psql -U pms -d pms_order < ~/Projects/study/pms-order-bteam/data.sql
```

> 재고 고갈 주의: 강하게(높은 VUS·긴 DURATION) 돌리면 상품 재고가 소진돼 주문 생성이 4xx가 날 수 있다.
> 기본 강도(`VUS=20`, `QTY=1`)에서 시작하고, 늘릴 때는 `run-w3-steady.sh`로 4xx가 안 나는지 먼저 확인한다.

## 3. 측정 실행

러너는 본 측정 전 **preflight smoke**(`order-lifecycle.smoke.js`)로 흐름·Mgmt 접근을 확인하고, 실패 시 벤치마크를 돌리지 않는다.

```bash
cd ~/Projects/study/tema-a/loadtests/k6

# (0) 정상 기준선 — 무장애. 유실 0 / 중복 0 이어야 한다.
#     단, 순서 꼬임은 0이 아닐 수 있다(아래 주의 참고 — 구조적).
VUS=30 DURATION=60s ./scripts/run-w3-steady.sh

# (1) BEFORE — 방어 없음 + 장애 주입(ATK-C03 재현)
VUS=30 DURATION=60s OUTAGE_AT=20 OUTAGE_SECONDS=10 ./scripts/run-w3-chaos.sh before
```

`run-w3-chaos.sh`가 하는 일: smoke → `consumed_events` reset → (백그라운드) lag 곡선 측정 + 장애 주입 → 포그라운드 lifecycle 부하 → 재기동 후 lag 회복 측정 → `verify-w3.sh compute`로 유실/중복/순서/E2E 출력.

### 단독 검증 명령

```bash
./scripts/verify-w3.sh reset                                  # 측정 윈도우 초기화
./scripts/verify-w3.sh compute results/w3-before-*-summary.json  # 정밀 지표
./scripts/verify-w3.sh lag 180                                 # 큐 드레인 회복 시간(초)
./scripts/verify-w3.sh snapshot before                        # 큐 깊이+컨슈머 카운터 스냅샷
```

## 4. 방어 적용 (본인 선택 1개)

베이스라인(Before)을 확인했으면 **본인 옵션**을 `pms-order-bteam`에 구현하고 재빌드한다. 하니스/측정은 그대로 둔다.

| 옵션 | 핵심 | 움직여야 할 지표 |
|---|---|---|
| **A. Transactional Outbox** | DB 트랜잭션 내 outbox 기록 → 폴링 발행. `AFTER_COMMIT` 직접 발행의 유실 창 제거 | **유실률 ↓↓** |
| **B. Saga (Choreography/Orchestration)** | 보상 트랜잭션으로 부분 실패 정합성 복구 | 정합성 위반 ↓ (유실/순서) |
| **C. Kafka 파티션 키** | aggregateId(orderId) 키 → 단일 파티션 직렬화 | **순서 꼬임 ↓↓** |
| **D. RabbitMQ Publisher Confirms + DLQ** | 발행 확정(ack/nack)으로 유실 감지·재발행, 실패 격리/리드라이브 | **유실률 ↓**, DLQ 활용 |
| **E. CDC (Debezium)** | DB WAL을 진실 원천으로 이벤트 추출(발행 누락 제거) | **유실률 ↓↓** |

> at-least-once를 택하면 **중복은 사라지지 않는다**(redelivered>0은 정상). 대신 **컨슈머 멱등성**으로
> 중복의 "부작용"을 0으로 만든다.멱등 키는 `event_id` 또는 `(orderId,eventType)`이 자연스럽다.

## 5. After 측정 → 리포트 → ADR

```bash
# 방어 적용·재빌드·재기동 후, BEFORE와 "동일 강도·타이밍"으로
VUS=30 DURATION=60s OUTAGE_AT=20 OUTAGE_SECONDS=10 ./scripts/run-w3-chaos.sh after
```

1. `reports/week3-async-ordering.template.md`를 복사해 Before/After 5개 지표·장애 주입 결과·토론 4종을 채운다(발표 1p = Before/After 표).
2. ADR을 누적한다: `docs/adr/NNNN-{slug}.md` (`docs/adr/0000-template.md` 복사). 본 주차로 ADR 3건 누적 목표.

## 6. 한계 / 주의

- **순서 꼬임은 무장애에도 발생한다(중요)**: created/paid/cancelled는 **3개의 분리된 큐**에서 동시(`concurrency 2~8`) 소비되고 시뮬 지연(50~300ms)이 제각각이라, 같은 주문 안에서도 paid가 cancelled보다 늦게 처리될 수 있다. 그래서 정상 기준선에서도 순서 위반율이 0이 아니다 — 이게 "비동기는 순서를 공짜로 보장하지 않는다"의 실증이다. 방어(C 파티션키 등) 적용 시 이 수치가 떨어져야 한다. 반면 **유실·중복은 무장애에선 0**이어야 하고, 장애 주입 후에만 올라간다.
- **공정성**: Before/After는 `VUS·DURATION·THINK·QTY`와 `MODE·OUTAGE_AT·OUTAGE_SECONDS`를 **동일**하게 고정해야 비교가 성립한다. 러너 호출 시 같은 환경변수를 명시하라.
- **재현성**: 장애는 부하 시작 후 `OUTAGE_AT`초에 1회 주입된다. 주입 시점이 너무 늦거나(부하 끝난 뒤) 너무 짧으면 유실이 0으로 보일 수 있다 — 부하 구간(`DURATION`) 중앙에 오도록 맞춰라.
- **lag 회복 시간**: `run-w3-chaos.sh`는 부하 종료 후 잔여 적체 드레인 시간을 측정한다. 더 정밀한 곡선은 `results/w3-*-lag.json`(`rabbit_messages_ready` 시계열)을 본다.
- **E2E p99**: `received_at`(컨슈머)와 `event_timestamp`(producer)는 같은 앱 JVM 시계라 시계 오차가 작다. 분산 환경이라면 시계 동기화를 전제로 해석하라.
