# 수비팀 권한 요청 메시지 (슬랙 복붙용)

## TL;DR

> 공방전 당일 C03 시나리오 실행을 위해 **2개 권한 사전 합의 + 1개 모니터링 채널 공유** 요청. 마감: **일요일(5/10) 미팅 전**.

---

## 요청 항목 매트릭스

| # | 요청 사항 | 사유 | 마감 |
|---|---|---|---|
| 1 | `docker pause rabbitmq` 실행 권한 | C03 시나리오 핵심 트리거 (5초 차단) | 일요일 미팅 전 |
| 2 | RabbitMQ Mgmt UI 외부 접근 (`:15672`) | 실시간 큐 메트릭 관측 | 일요일 미팅 전 |
| 3 | Prometheus 메트릭 read 권한 (있다면) | `rabbitmq_queue_messages_*` 시계열 확인 | 가능하면 |

---

## 슬랙 메시지 (복붙)

```
안녕하세요 수비팀 🛡️
공격팀 김준성입니다. C03(메시지 큐 시나리오) 실행 준비 관련해서 사전 합의 필요한 게 3건 있어 정리해서 드립니다.

【 요청 1 — docker pause 권한 】
시나리오 핵심: RabbitMQ 컨테이너를 5초간 일시 정지(`docker pause rabbitmq`) → 메시지 유실 재현
영향 범위: RabbitMQ만 정지, 앱/DB는 정상 / 5초 후 자동 unpause / 안전 trap 적용됨
요청: 당일 공방전 환경에서 공격팀 머신에서 위 명령 실행 가능하도록 합의 부탁드립니다.

【 요청 2 — RabbitMQ Mgmt UI 접근 】
요청: `:15672` (guest/guest 또는 별도 계정) 접근 권한
용도: order.cancelled.queue / order.cancelled.dlq 의 publish/messages 카운터 관측

【 요청 3 — Prometheus 메트릭 (선택) 】
필요 메트릭:
 • rabbitmq_queue_messages_published_total{queue="order.cancelled.queue"}
 • rabbitmq_queue_messages_ready{queue="order.cancelled.queue"}
 • rabbitmq_node_disk_free, rabbitmq_node_mem_used
이미 노출 중이면 대시보드 URL 공유, 아니면 가능 여부만 알려주셔도 됩니다.

【 일정 】
일요일 오전 10시 미팅 전까지 1, 2번이라도 합의되면 진행 가능합니다.
3번은 없어도 docker exec / Mgmt UI 로 대체 가능합니다.

문의 사항 있으시면 편하게 말씀해주세요. 감사합니다 🙏
```

---

## 합의 여부 추적

| # | 항목 | 합의 | 메모 |
|---|---|---|---|
| 1 | docker pause 권한 | [ ] | |
| 2 | RabbitMQ Mgmt UI | [ ] | |
| 3 | Prometheus | [ ] | |

---

## 합의 실패 시 대안

| 실패 항목 | 대안 |
|---|---|
| `docker pause` 거부 | `docker stop rabbitmq` (5초 후 start) — 효과 동일, 약간 더 거침 |
| `docker pause` + `docker stop` 모두 거부 | `docker network disconnect` 로 RabbitMQ 격리 |
| Mgmt UI 미접근 | `docker exec rabbitmq rabbitmqctl list_queues` CLI 출력으로 대체 |
| Prometheus 미접근 | Mgmt API (`/api/queues/.../message_stats`) 로 대체 (verify-loss.sh가 이미 사용) |
