# Week3 비동기 순서 보장 리포트 (Before / After)

> 발표 슬라이드 **첫 페이지 = 아래 2장 Before/After 표**.
> 베이스라인(ATK-C03 재현, 방어 없음) = Before, 본인 방어 1개 적용 = After.
> 두 런은 **동일 강도·동일 장애 타이밍**이어야 비교가 성립한다(공정성).
> 모든 수치는 `verify-w3.sh compute`(관찰 싱크 `consumed_events` + DB + 큐 잔량 + k6 summary)가 산출한다.

## 1. 측정 환경 (Before / After 동일해야 비교 성립)

| 항목 | 내용 |
|---|---|
| 대상 서버 커밋 (Before) |  |
| 대상 서버 커밋 (After) |  |
| 선택한 방어 (A Outbox / B Saga / C Kafka 파티션키 / D Confirms+DLQ / E CDC) |  |
| 멱등성 구현 방식 (event_id 기반? upsert? dedup 테이블?) |  |
| consumer 설정 (ack mode / concurrency / prefetch / retry) |  |
| 교란요인 차단 (`consumer.simulation.failure-rate=0` 여부) |  |
| k6 버전 / 시드 (`data.sql` 규모) |  |
| 강도 `VUS` / `DURATION` / `THINK` / `QTY` |  |
| 장애 `MODE` / `OUTAGE_AT` / `OUTAGE_SECONDS` |  |
| 측정 시각 (Before / After) |  |

실행 명령 (강도·타이밍을 before/after 동일하게 고정):

```bash
# 0) 정상 기준선(무장애: 유실 0·중복 0 확인. 순서 꼬임은 구조적으로 >0 가능)
VUS=30 DURATION=60s ./scripts/run-w3-steady.sh

# 1) BEFORE — 방어 없음, 장애 주입
VUS=30 DURATION=60s OUTAGE_AT=20 OUTAGE_SECONDS=10 ./scripts/run-w3-chaos.sh before

# 2) 본인 방어 적용 후 앱 재빌드·재기동 → AFTER (동일 강도·타이밍)
VUS=30 DURATION=60s OUTAGE_AT=20 OUTAGE_SECONDS=10 ./scripts/run-w3-chaos.sh after
```

## 2. 필수 지표 (측정 강제 — 빈칸 금지)

| 지표 | 측정 출처 | Before | After | 개선 |
|---|---|---|---|---|
| **메시지 유실률** (RabbitMQ stop 시) | `verify-w3.sh compute` → `유실 / expected` | | | |
| **순서 꼬임 발생률** | `compute` → `순서 꼬임 (orders 위반 비율)` | | | |
| **컨슈머 lag 회복 시간** | `verify-w3.sh lag` (재기동→drain 초) | | | |
| **중복 처리 발생 수** | `compute` → `dup` / `redelivered` | | | |
| **End-to-end 처리 지연 p99** | `compute` → `E2E p99 ms` (received_at − event_timestamp) | | | |

> 개선: 유실/순서/중복/지연·회복시간은 **감소**가 개선.
> 유실률 = 발행됐어야 할 이벤트(k6 `w3_expected_*`) 중 도착도 큐잔량도 아닌 수.
> 중복은 `redelivered=true`(브로커 재기동 재전달)가 직접 신호. dup = 전체 도착행 − distinct(event_id).

### 보조 신호

| 신호 | Before | After | 비고 |
|---|---|---|---|
| `w3_expected_created/paid/cancelled` (k6) | | | producer 발행 기대 수(진실 P) |
| `consumed_events` distinct / total | | | consumer 도착(진실 C) / 중복 포함 총행 |
| DLQ 적체 (`order.*.dlq` messages) | | | 컨슈머 실패 격리분 |
| `w3_payment_failed` (k6) | | | 결제 ~5% 실패(롤백→PENDING 잔류, 이벤트 미발행). expected 미포함 |
| lag 곡선 (`results/w3-*-lag.json`) | | | `rabbit_messages_ready` 시계열 |

## 3. 장애 주입 실험 결과 (없으면 다음 주 보강 대상)

```text
- 장애 시점/지속: OUTAGE_AT=__s, OUTAGE_SECONDS=__s, MODE=__
- 중단 동안 관측: 발행 실패(로그) __건 / HTTP 200인데 유실된 이벤트 __건
- 재기동 직후 큐 적체 피크(messages_ready): __
- lag 회복(드레인) 시간: __s
- 재전달(redelivered)로 인한 중복 처리: __건
- 방어 적용 후 위 수치가 어떻게 바뀌었는가:
```

## 4. 발표 필수 답변 4종

### ① at-least-once 보장 시 컨슈머 멱등성 구현

```text
- 멱등 키는 무엇인가? (event_id / (orderId,eventType) / 업무 자연키)
- 중복 도착을 어떻게 무해화하는가? (dedup 테이블 upsert / 상태 가드 / 조건부 update)
- 측정: After의 dup/redelivered는 그대로지만 "중복 처리로 인한 부작용"이 0인가?
```

### ② 동일 Aggregate 순서 / 다른 Aggregate 간 순서

```text
- 동일 주문(aggregate)의 created→paid→cancelled 순서를 무엇으로 보장했는가?
  (단일 파티션/큐 직렬화, 파티션 키=orderId, 버전/시퀀스 가드 등)
- 다른 주문끼리의 순서는 보장 안 해도 되는 이유(업무적 근거):
- 측정: 순서 꼬임 발생률 Before __% → After __%
```

### ③ 컨슈머 장애 시 재처리 전략

```text
- 재시도 정책: 무한 재시도? 횟수 제한 + 백오프? 즉시 DLQ?
- DLQ로 보낸 메시지의 재처리(리드라이브) 절차와 수동 개입 임계:
- poison message(영구 실패) 격리 기준:
```

### ④ exactly-once delivery가 환상인 이유 (본인 경험으로)

```text
- 네트워크/ack 타이밍상 "정확히 한 번 전달"이 왜 불가능한가:
- 그래서 무엇을 택했는가: at-least-once + 멱등(effectively-once) / at-most-once:
- 이번 실험에서 그 한계를 본 지점(redelivered>0 등):
```

## 5. 결론

| 항목 | 내용 |
|---|---|
| 판단 (방어 효과 입증 여부) |  |
| 핵심 근거 (유실/순서/중복/회복 비교) |  |
| 트레이드오프와 한계 |  |
| 운영 적용 시 고려사항 |  |
| ADR 링크 (`docs/adr/NNNN-{slug}.md`) |  |
