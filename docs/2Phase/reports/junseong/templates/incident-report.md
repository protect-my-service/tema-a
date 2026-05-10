# 인시던트 리포트 — ATK-C03

> PDF p.28 양식 기반. 공방전 직후 30분 내 작성 → 회고 자료.

---

## TL;DR

| 항목 | 값 |
|---|---|
| 시나리오 ID | ATK-C03 |
| 가설 입증 여부 | [ ] 입증 / [ ] 반증 / [ ] 보류 |
| 발생 시점 | __:__:__ |
| 핵심 수치 | DB cancelled +__, MQ published +__, 유실 __건 (__%) |
| 1순위 개선안 | Publisher Confirm + Outbox 패턴 도입 |

---

## 1. 가설 (사전 정의)

> RabbitMQ를 5초간 차단한 상태에서 취소 요청 50건을 발사하면, DB는 모두 CANCELLED 커밋되지만 MQ에는 거의/전혀 발행되지 않아 `DB cancelled count` ≫ `MQ published_total` 이 된다.

---

## 2. 실행 조건

| 항목 | 값 |
|---|---|
| executor | `per-vu-iterations` |
| vus / iterations | 10 / 5 = 50건 |
| duration | __ 초 |
| 페이로드 | `POST /api/v1/orders/{id}/cancel`, body=`{"reason":"..."}` |
| 인프라 조작 | `docker pause rabbitmq` 5초 |
| 환경 | 로컬 docker compose / 공방전 환경 (해당사항 ✓) |

---

## 3. 발생 시점 / 타임라인

| 시각 | 이벤트 | 핵심 수치 |
|---|---|---|
| __:__:__ | BASELINE | DB cancelled=0, MQ published=__ |
| __:__:__ | TRIGGER (pause) | — |
| __:__:__ | START (K6) | — |
| __:__:__ | SIGNAL (K6 종료) | HTTP 200=__/50 |
| __:__:__ | TRIGGER (unpause) | — |
| __:__:__ | SIGNAL (검증) | DB cancelled=__, MQ published=__ |
| __:__:__ | RECOVER | reset-data.sh 완료 |

---

## 4. 관찰 메트릭

| 메트릭 | Before | During (peak) | After |
|---|---|---|---|
| DB `orders` cancelled count | 0 | — | __ |
| MQ `order.cancelled.queue` published_total | __ | — | __ |
| MQ `order.cancelled.queue` ready | 0 | __ | 0 |
| MQ `order.cancelled.dlq` messages | 0 | 0 | **0** ★ |
| 앱 로그 `Failed to publish ...` 카운트 | 0 | — | __ |
| HTTP 5xx 비율 | 0% | __% | 0% |

★ DLQ가 비어있는 것이 핵심 증거 — 발행 자체가 실패해 라우팅될 메시지조차 없었음.

### 첨부 (스크린샷)

- [ ] RabbitMQ Mgmt UI — `order.cancelled.queue` Message rates 그래프
- [ ] RabbitMQ Mgmt UI — `order.cancelled.dlq` Total = 0
- [ ] `docker compose logs app | grep "Failed to publish"` 출력
- [ ] (선택) Prometheus Grafana 패널

---

## 5. 장애 원인

| 레벨 | 원인 |
|---|---|
| 직접 원인 (Direct) | RabbitMQ가 5초간 차단된 상태에서 발행 시도 → AmqpException |
| 근본 원인 (Root) | `RabbitMQEventPublisher.publishOrderCancelled` 의 try-catch가 예외를 삼킴 + Publisher Confirm 미설정 + Outbox 미적용 → 발행 실패 시 재시도/복구 경로 부재 |

### 코드 위치

```
src/main/java/com/pms/order/infra/rabbitmq/RabbitMQEventPublisher.java:39-46
src/main/java/com/pms/order/event/OrderEventListener.java:24-27
src/main/resources/application.yml (rabbitmq 섹션, publisher-confirm-type 미설정)
```

---

## 6. 수비팀 대응 평가

| 방어 전략 | 시도 여부 | 효과 |
|---|---|---|
| 메시지 중계자 재시작 자동화 | [ ] | __ |
| Publisher Confirm 설정 추가 | [ ] | __ |
| 알림으로 발행 실패 즉시 감지 | [ ] | __ |
| 그 외: ___ | [ ] | __ |

| 효과 평가 |
|---|
| 효과 있던 방어: __ |
| 효과 없던 방어: __ |
| 시도하지 않은 방어: __ |

---

## 7. 운영 환경 개선안 (우선순위)

| 순위 | 개선안 | 근거 | 다음 PR 가능성 |
|---|---|---|---|
| 1 | **Publisher Confirm 활성화** | 발행 실패를 호출자가 인지 가능 | ⭐ 즉시 (yml 1줄 + 콜백 구현) |
| 2 | **Outbox 패턴 도입** | DB-MQ 정합성 보장 (재시도 가능) | ⭐ 다음 스프린트 |
| 3 | `RabbitMQEventPublisher` try-catch 제거 또는 재시도 로직 | 예외 silent swallow 방지 | ⭐⭐ 즉시 |
| 4 | RabbitMQ 클러스터링 (HA) | 단일 노드 SPOF 제거 | 인프라 비용 검토 필요 |

---

## 8. 남은 질문 (회고 토론거리)

- [ ] Outbox 패턴을 도입한다면 어떤 구현 방식이 우리 시스템에 적합한가? (poller vs Debezium CDC)
- [ ] Publisher Confirm을 켰을 때 성능 영향은? 트랜잭션 처리량 감소 폭은?
- [ ] 메시지 유실을 운영 환경에서 어떻게 사전 감지할 것인가? (DB-MQ delta 메트릭)
- [ ] 본 시나리오에서 시뮬레이션하지 못한 인접 장애 패턴: ___
- [ ] 추가로 필요한 메트릭: ___

---

## 9. 자가 평가

| 평가 항목 | 점수 (1~5) | 메모 |
|---|---|---|
| 가설을 메트릭으로 명확히 입증/반증했는가 | __ | __ |
| 시간 박스(30분)를 지켰는가 | __ | __ |
| 기록자 골든 포맷을 끝까지 유지했는가 | __ | __ |
| 회복 절차가 정상 동작했는가 | __ | __ |
| 다음 시나리오에 영향 없이 정리했는가 | __ | __ |

---

## 10. 회고 다음 액션

- [ ] 본 리포트 회고 채널 공유 (담당: 김준성 / 마감: 공방전 종료 +1일)
- [ ] 1순위 개선안 (Publisher Confirm) PR 초안 작성 (담당: __ / 마감: __)
- [ ] 2순위 개선안 (Outbox) 백로그 등록 (담당: __ / 마감: __)
- [ ] 빠진 스터디원 2명 회고 자리 초대 (담당: __ / 마감: __)
