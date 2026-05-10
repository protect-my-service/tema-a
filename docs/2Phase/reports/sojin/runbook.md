# 공방전 당일 운영 매뉴얼 — 김소진 (트리거)

> 작성일: 2026-05-10
> 대상 시나리오: ATK-A02 / A03 / A05
> 역할: 트리거 (K6 실행 + 환경변수 조절 + 상태 외침)

---

## 0. 손에 익혀야 할 명령어 5개

```bash
# 시드
./tema-a/docs/2Phase/reports/sojin/k6/scripts/seed.sh

# 시나리오
./tema-a/docs/2Phase/reports/sojin/k6/scripts/run-a02.sh
./tema-a/docs/2Phase/reports/sojin/k6/scripts/run-a03.sh
./tema-a/docs/2Phase/reports/sojin/k6/scripts/run-a05.sh

# 회복 (시나리오 사이 매번)
./tema-a/docs/2Phase/reports/sojin/k6/scripts/recover.sh
```

→ 모든 sh 는 환경변수로 BASE_URL / PG_CONTAINER 주입 가능.

---

## 1. 시작 전 체크 (5분)

### 시드 검증 (pgAdmin 또는 한 줄 쿼리)

```bash
docker exec pms-order-bteam-postgres-1 psql -U pms -d pms_order -c "
SELECT 'member' AS t, COUNT(*) FROM member
UNION ALL SELECT 'product', COUNT(*) FROM product
UNION ALL SELECT 'orders PAID', COUNT(*) FROM orders WHERE status='PAID'
UNION ALL SELECT 'order_item', COUNT(*) FROM order_item
UNION ALL SELECT 'payment APPROVED', COUNT(*) FROM payment WHERE status='APPROVED';
"
```

기대값: member 1000 / product 50 / orders PAID 400 / order_item 800 / payment 400

### 핫 상품 재고 확인
```sql
SELECT id, name, stock_quantity FROM product WHERE id IN (1,2);
-- P1, P2 재고 99800 × 2 나와야
```

### 수비팀 헬스 체크
```bash
curl http://pms-order-alb-1379619291.us-east-1.elb.amazonaws.com/actuator/health
# {"status":"UP"} 정상
```

### Grafana 패널 (이용선 확인)
- `pg_locks`
- `hikaricp_connections_*` (active / pending / timeout)
- `http_req_duration` p99
- `pg_stat_database.deadlocks`
- `tomcat_threads_busy`
- `health_latency` (사이트 전체 영향 측정)

---

## 2. ATK-A02 — 동일 상품 락 경합 (15분)

### 명령어

```bash
BASE_URL=http://pms-order-alb-1379619291.us-east-1.elb.amazonaws.com \
PG_CONTAINER=pms-order-bteam-postgres-1 \
  ./tema-a/docs/2Phase/reports/sojin/k6/scripts/run-a02.sh
```

기본 설정: RPS 100 고정 / 3분 / TARGET_PRODUCT=1 (P1)

### Grafana 봐야 할 4개

| 패널 | A02 발현 시 |
|---|---|
| `http_req_duration` p99 | 3초 이상 (lock.timeout 도달) |
| `hikaricp_connections_pending` | > 0 (대기 큐) |
| `pg_locks` waiting | 수십 행 |
| `tomcat_threads_busy` | max 도달 |

### 외칠 멘트

```
시작:       "A02 START — RPS 100, TARGET=P1"
임계 도달:  "A02 SIGNAL — pool pending, p99 4초"
종료:       "A02 STOP — 캡처"
```

### 종료 조건 (하나라도 도달 시)

- p99 ≥ 5초 지속 30초
- 5xx ≥ 30%
- DB CPU ≥ 90% 5분

---

## 3. ATK-A03 — 풀 고갈 (15분)

### 명령어

```bash
BASE_URL=http://pms-order-alb-1379619291.us-east-1.elb.amazonaws.com \
PG_CONTAINER=pms-order-bteam-postgres-1 \
  ./tema-a/docs/2Phase/reports/sojin/k6/scripts/run-a03.sh
```

자동 스테이지: 50 → 100 → 150 → 200 RPS (총 3분 30초)

### Grafana 봐야 할 4개 (A02 + 추가)

| 패널 | A03 발현 시 |
|---|---|
| `hikaricp_connections_active` | 10 도달 + 유지 |
| `hikaricp_connections_timeout_total` | 단조 증가 |
| `health_latency_during_attack` p99 | 1초 이상 (사이트 전체 영향) |
| `http_req_duration` p99 | 30초 도달 (connection-timeout) |

### 외칠 멘트

```
시작:       "A03 START — RPS 50→200 단계 상승"
임계점:     "A03 SIGNAL — pool max 10, RPS 150 시점 터짐"
사이트 영향: "A03 health 1.5초 — 사이트 전체 영향 확인"
종료:       "A03 STOP — 캡처"
```

### 종료 조건

- `timeout_total` ≥ 100
- DB CPU ≥ 90% 5분
- `health_latency` p99 ≥ 5초

→ 풀 마비 상태 오래 두면 회복 시간 길어짐. 빠르게 STOP.

---

## 4. ATK-A05 — 데드락 (10분)

### 명령어

```bash
BASE_URL=http://pms-order-alb-1379619291.us-east-1.elb.amazonaws.com \
PG_CONTAINER=pms-order-bteam-postgres-1 \
  ./tema-a/docs/2Phase/reports/sojin/k6/scripts/run-a05.sh
```

기본 설정: 두 그룹(group_xy + group_yx) 5 RPS 각 / 30초

### Grafana / DB 봐야 할 것

| 위치 | 메트릭 | A05 발현 시 |
|---|---|---|
| Grafana | `pg_stat_database.deadlocks` | 0 → 1 이상 |
| Grafana | cancel 5xx 비율 | > 0 |
| 서버 로그 | `SQLSTATE=40P01` | 발견 |
| pgAdmin | 직접 조회 | 단조 증가 |

### pgAdmin 직접 확인 쿼리 (시작 전 + 끝난 후 두 번)

```sql
SELECT datname, deadlocks
FROM pg_stat_database
WHERE datname = 'pms_order';
```

→ 시작 전 0, 끝나고 1 이상이면 가설 입증.

### 외칠 멘트

```
시작:       "A05 START — group_xy + group_yx 동시"
입증:       "A05 SIGNAL — deadlocks 카운트 증가"
종료:       "A05 STOP"
```

### 종료 조건

- deadlocks 카운터 1 이상 발생 → 즉시 STOP
- 또는 DURATION (30초) 끝까지

---

## 5. 회복 절차 — 매 시나리오 사이 (5분)

```bash
PG_CONTAINER=pms-order-bteam-postgres-1 \
  ./tema-a/docs/2Phase/reports/sojin/k6/scripts/recover.sh
```

자동 진행:
1. `docker compose restart` (HikariCP 풀 초기화)
2. 5초 안정화
3. 시드 재실행

외침: `"A02 RECOVER → READY"`

---

## 6. 결과 회수 (공방전 끝나고)

### K6 결과 JSON

```bash
ls -la tema-a/docs/2Phase/reports/sojin/k6/results/
# a02-20260510-100515.json + summary.json
# a03-...
# a05-...
```

→ summary JSON 안에 최종 통계. 회고록에 첨부.

### DB / Grafana 캡처

- pgAdmin `deadlocks` 카운트 (A05 입증 자료)
- Grafana 패널 시간 그래프 (이용선 협조)
- 서버 로그 `SQLSTATE=40P01` grep 결과

---

## 7. 전체 타임라인 한눈에

```
[09:55] 시작 전 체크 (시드 / 수비팀 헬스 / Grafana)
[10:00] A02 START → 15분 → STOP → 캡처
[10:15] RECOVER (5분)
[10:20] A03 START → 15분 → STOP → 캡처
[10:35] RECOVER
[10:40] A05 START → 10분 → STOP (데드락 발생 시 즉시) → 캡처
[10:50] 종료 → 결과 회수
```

---

## 8. 트리거 역할 핵심 — 외침 표준

PDF 슬라이드 26 골든 포맷.

| 시점 | 상태 | 외칠 멘트 형식 |
|---|---|---|
| K6 시작 | START | `"<ID> START — <설정>"` |
| 임계 근접 | WARNING | `"<ID> WARNING — <메트릭값>"` (선택) |
| 가설 입증 | SIGNAL | `"<ID> SIGNAL — <결정적 메트릭>"` |
| 종료 | STOP | `"<ID> STOP"` (Ctrl+C 또는 자동 종료) |
| 회복 | RECOVER | `"<ID> RECOVER 시작"` |
| 다음 가능 | READY | `"<ID> READY"` |

---

## 9. 비상 상황 대응

### K6 가 멈추지 않을 때
```bash
# Ctrl+C 가 안 먹으면 강제 종료
pkill -f "k6 run"
```

### 컨테이너 응답 없을 때
```bash
docker ps                                    # 살아있나 확인
docker logs <컨테이너이름> --tail 100        # 로그 확인
docker compose down && docker compose up -d   # 완전 재시작
```

### 시드 적용 실패
- DB 컨테이너 헬스 확인
- `data-attack.sql` 의 TRUNCATE 가 외래키 제약으로 막히면 `CASCADE` 옵션 확인 (이미 들어있음)

### Grafana 패널 안 보일 때 (이용선 부재)
- 직접 PostgreSQL 쿼리로 백업 검증 (`pg_locks`, `pg_stat_database.deadlocks`)
- pgAdmin 으로 실시간 확인

---

## 10. 한 줄 요약

> **5개 sh 파일 + 5개 외칠 멘트 + 4개 Grafana 패널. 이 셋이 손에 익으면 트리거 역할 완료.**
