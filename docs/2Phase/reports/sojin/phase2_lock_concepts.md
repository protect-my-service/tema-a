

# DB 락 시나리오 학습 노트 — A02 / A03 / A05

> 작성일: 2026-05-09
> 목적: ATK-A02 / A03 / A05 발표 전 본인 학습 정리. **비유 → 코드 매핑** 순으로 풀어쓴 노트.
> 발표 본편은 `docs/2Phase/attack_scenario/공방전_공격팀_지식전달.pdf`. 이 문서는 그 자료를 본인이 이해한 언어로 다시 풀어쓴 것.

---

## 0. 한 줄 정리 — 셋이 어떻게 연결되나

> "**같은 락 경합이 어디까지 번질 수 있는가**" 의 3단계 확장

**셋 다 "락 경합" 이 뿌리. 단지 어디까지 번지느냐가 다름:**

- **A02** = *순수 락 경합 자체.* 같은 row를 다 같이 잡으려 함 → p99 폭증
- **A03** = 락 경합이 *풀 고갈로 번진 결과.* 락 대기로 트랜잭션이 안 끝남 → 좌석(커넥션)도 같이 묶임
- **A05** = 락 경합의 *변형.* 두 명이 락을 *역순으로* 잡으려 함 → 데드락

```
A02              A03                    A05
같은 row 락        같은 락 + 풀 고갈        역순 락 → 데드락
  ↓                  ↓                       ↓
p99 폭증          사이트 전체 멈춤          DB가 강제 롤백
"그 상품만 느림"  "무관한 페이지도 멈춤"   "영문 모를 500"
```

같은 비관적 락에서 출발하지만, *어떤 자원이 추가로 묶이느냐 / 어떻게 잡으려 하느냐*에 따라 결과가 갈림.

→ 그래서 **"락 경합 푸는 일반 해법"은 §2 (A02) 자리에 둠.** 셋의 *공통 뿌리*가 A02니까.
A02 해결법이 A03엔 그대로 효과, A05엔 부분적 (A05는 §4의 *락 순서 정렬*이 정답).

---

## 1. 기본 개념 3가지 — 비유로 잡고 가기

### 1-1. 락 (Lock) — 메뉴 카드 비유

상품 X의 재고가 100개여도, **재고가 적힌 카드(= product row)는 한 장**.

100명이 그 상품을 동시 주문하면, 카드 한 장 두고 100명이 줄 섬. DB가 *"한 명이 손대는 동안 다른 사람 못 손대게 잠가"* → **비관적 락** (`SELECT ... FOR UPDATE`).

### 1-2. 트랜잭션 (Transaction) — ATM 출금 비유

ATM 출금 = 3단계:
1. 잔고 확인
2. 잔고 차감
3. 현금 토출

**셋이 다 되거나 다 취소**되어야 함. 한 묶음으로 처리. 이게 트랜잭션.

`@Transactional` 어노테이션 = "이 메서드 안의 모든 DB 작업을 한 묶음으로 처리".

**중요:** 트랜잭션이 끝날 때까지 안에서 잡은 락은 안 풀림.
→ **트랜잭션 길이 = 락 보유 시간.**

### 1-3. 커넥션 풀 (Connection Pool) — 식당 좌석 비유

서버가 DB와 대화하려면 *연결선*이 필요. 우리 시스템엔 **연결선 10개**만 있음.

- 식당 좌석 10개
- `@Transactional` 시작 = 좌석 1개 잡음
- 메서드 끝 = 좌석 반납

좌석 다 차면 신규 손님은 줄 섬. 30초 기다려도 못 들어가면 503 (`connection-timeout: 30000`).

---

## 2. ATK-A02 · 동일 상품 집중 주문 락 경합

### 한 줄
인기 상품 한 개에 100명이 동시 주문 → 같은 상품 row를 잡으려 줄 서기 → 응답 시간 폭증.

### 비유
인기 메뉴 카드 1장에 100명이 동시 주문.
- 1번 손님: 0.1초 만에 받음
- 100번 손님: 10초 기다림

### 사용자 영향
"버튼이 안 먹힌다." 첫 1명은 정상, 뒤로 갈수록 느려지다 일부 timeout.

### 코드
```java
// OrderService.createOrder 안
Product product = productRepository.findByIdWithLock(...);  // 메뉴 카드 잡기
product.deductStock(qty);                                    // 재고 차감
```

`findByIdWithLock` 의 `@Lock(LockModeType.PESSIMISTIC_WRITE)` = `SELECT ... FOR UPDATE`.

### K6
- executor: `constant-arrival-rate`
- RPS=100, duration=3m
- 동일 productId=1
- think time 1~3초

### 메트릭
- `pg_locks` (waiting / granted)
- `http_server_requests` p99 ★
- `tomcat_threads_busy`

### ⚠ 주의사항 — 데이터 준비 / 종료 조건 / 회복 절차

- **데이터 준비**: 인기 상품 1개 재고 ≥ 10,000 (`data-attack.sql` 의 P1 = 99,800)
- **종료 조건**: p99 ≥ 5초 또는 5xx ≥ 30% → 즉시 K6 stop + 캡처
- **회복 절차**: 컨테이너 재시작 + `data-attack.sql` 재실행

### 테스트 후 확인 체크리스트

A02 실행 후 **4곳**에서 결과 확인:

| 위치 | 메트릭 | A02 발현 기준 |
|---|---|---|
| K6 콘솔 | `http_req_duration` p99 | ≥ 3,000ms (lock.timeout 도달) |
| K6 콘솔 | `order_5xx_total` | ≥ 100건 |
| K6 콘솔 | `order_failed_rate` | ≥ 5% |
| K6 콘솔 | `health_latency_during_attack` p99 | ≥ 500ms (사이트 전체 영향) |
| Grafana | `hikaricp_connections_active` | 10 도달 (max) |
| Grafana | `tomcat_threads_busy` | max 도달 |
| DB 쿼리 | `pg_stat_activity` wait_event='Lock' | 수십 행 |
| DB 쿼리 | `pg_locks` NOT granted | 누적 |

→ 위 신호 중 **3개 이상 같이** 나오면 A02 가설 입증.

#### DB 실시간 진단 (다른 터미널에서)

```bash
docker exec -it phase2-postgres-1 psql -U pms -d pms_order
```

```sql
-- 1) 락 대기 트랜잭션
SELECT pid, state, wait_event, query
FROM pg_stat_activity
WHERE wait_event_type = 'Lock';

-- 2) 잡힌 락 종류별 카운트
SELECT mode, count(*) FROM pg_locks WHERE NOT granted GROUP BY mode;

-- 3) 트랜잭션 길이 Top 5 (3초 이상이면 비정상)
SELECT pid, now() - xact_start AS duration, query
FROM pg_stat_activity
WHERE xact_start IS NOT NULL
ORDER BY duration DESC LIMIT 5;
```

#### 결과 저장 위치 (회고록 첨부용)

- `reports/loadtests/k6/results/a02-YYYYMMDD-HHMMSS.json` (raw)
- `reports/loadtests/k6/results/a02-YYYYMMDD-HHMMSS-summary.json` (요약)

#### 종료 조건 — STOP 외칠 시점

다음 중 *하나라도* 도달 시 즉시 K6 stop + 메트릭 캡처:
- p99 ≥ 5,000ms 지속 30초 이상
- 5xx 비율 ≥ 30%
- DB CPU ≥ 90% 5분 이상

### 해결 방법 — 락 경합 푸는 일반 해법
> 이 3가지는 **A03에도 그대로 효과** (A03은 락 경합의 *결과*니까 뿌리를 자르면 같이 해결됨)

#### 1) 트랜잭션 짧게 ★ 우리 시스템 1순위
- 락 잡고 있는 시간 = 트랜잭션 길이. 짧을수록 줄이 빨리 빠짐.
- `@Transactional` 안에 *핵심 작업만* 두고 잡일은 밖으로 빼기
- 예: `createOrder` 의 시퀀스 INSERT / 카트 비우기 / 이벤트 발행 → 트랜잭션 밖으로

#### 2) 재고 차감 시점 이동
- 주문 생성 시 차감 → **결제 시점** 차감으로 변경
- 미결제 PENDING 주문이 재고를 묶는 일 사라짐
- 네이버·쿠팡 등 이커머스 표준
- 단점: 결제 직전 재고 부족 발견 시 사용자 경험 약간 나빠짐 (트레이드오프)

#### 3) Redis 카운터로 분리
**비유 — 자판기 번호표**
- 지금: 메뉴 카드 1장(=row)을 100명이 줄 서서 잡음
- Redis: 번호표 자판기를 옆에 두고 손님은 거기서 번호표만 받음
- 자판기는 한 번에 한 장씩 발급해서 충돌 없음 (Redis는 단일 스레드라 명령 자체가 원자적)

```
Redis.DECR(stock:productId:1)   → 재고 -1, 0.1ms 안에 끝남
```

| | 현재 (DB row 락) | Redis 카운터 |
|---|---|---|
| 한 명 처리 시간 | 수십 ms ~ 수 초 (트랜잭션 길이) | 0.1ms |
| 락 보유? | 트랜잭션 끝까지 | 사실상 없음 |
| 100명 처리 시간 | 100 × 트랜잭션 길이 | 100 × 0.1ms ≈ 10ms |

→ 핵심: 처리가 직렬화되는 건 똑같은데 **한 명당 처리 시간이 압도적으로 짧음**.

한계:
- Redis ↔ DB 동기화 로직 필요 (정합성 관리 복잡)
- Redis 다운 시 모든 재고 처리 멈춤 → HA 구성 필수
- **블랙프라이데이급 트래픽 아니면 굳이 도입 안 함**

---

## 3. ATK-A03 · 락 대기 누적 → 커넥션 풀 고갈

### 한 줄
A02랑 같은 락 경합인데, *줄 서 있는 동안 트랜잭션이 안 끝남* → 좌석(커넥션)까지 같이 묶임 → 사이트 전체 멈춤.

### 비유
A02 + 식당 좌석 비유의 결합:
- 100명이 메뉴 카드 줄 섬 (A02 그대로)
- 동시에 그 100명이 **좌석도 점유 중** (트랜잭션 안 끝남)
- 좌석 10개 다 차서 신규 손님 못 들어옴
- 상품 조회·카트 담기 등 *무관한 페이지 사용자도* 멈춤

### 사용자 영향
A02는 "그 상품 사는 사람만 느림" → A03은 **"사이트 전체가 응답하지 않음"**.

### 코드
```yaml
# application.yml — 좌석 수 설정
hikari:
  maximum-pool-size: 10        # 좌석 10개
  connection-timeout: 30000    # 30초 기다려서 못 들어가면 503
```

### K6
- executor: `ramping-arrival-rate` (RPS 단계 상승: 100 → 150 → 200)
- 임계점 발견이 목적

### 메트릭
- `hikaricp_connections_active` (수렴치 = 10) ★
- `hikaricp_connections_pending` ↑
- `hikaricp_connections_timeout_total` ↑

### ⚠ 주의사항 — 데이터 준비 / 종료 조건 / 회복 절차

- **데이터 준비**: A02와 동일 (`data-attack.sql` 의 핫 상품 P1)
- **종료 조건**: `hikaricp_connections_timeout_total` ≥ 100 또는 DB CPU ≥ 90% 5분 → 즉시 중단 + 캡처
- **회복 절차**: 컨테이너 재시작 + `data-attack.sql` 재실행 + 풀 사이즈 원복 확인

### 테스트 후 확인 체크리스트

A03 실행 후 **풀 고갈 자체** + **사이트 전체 영향** 둘 다 확인:

| 위치 | 메트릭 | A03 발현 기준 |
|---|---|---|
| K6 콘솔 | `hikaricp_connections_active` | 10 도달 + 유지 (Grafana 동시) |
| K6 콘솔 | `hikaricp_connections_pending` | > 0 (대기 큐) |
| K6 콘솔 | `hikaricp_connections_timeout_total` | ≥ 100 |
| K6 콘솔 | `pool_timeout_estimated` (커스텀) | > 0 (30초+ 응답) |
| K6 콘솔 | `health_latency_during_attack` p99 | **≥ 1초 (사이트 전체 멈춤 입증)** |
| Grafana | `hikaricp_connections_pending` | 그래프 위로 튐 |
| DB 쿼리 | active 트랜잭션 수 | 풀 max(10) 근처 도달 |

→ 위 신호 중 **3개 이상** + health 지연이 같이 나오면 A03 가설 입증.
→ A03 의 핵심은 *health 도 같이 느려진다* = 사이트 전체 영향. 이게 A02 와 결정적 차이.

#### DB 실시간 진단

```sql
-- 1) 동시 active 트랜잭션 수 (풀 점유 추정)
SELECT count(*) FROM pg_stat_activity WHERE state = 'active';

-- 2) 가장 오래된 트랜잭션 Top 5
SELECT pid, now() - xact_start AS duration, state, query
FROM pg_stat_activity
WHERE xact_start IS NOT NULL
ORDER BY duration DESC LIMIT 5;

-- 3) 락 + 풀 합쳐 보기
SELECT pid, state, wait_event, now() - xact_start AS duration
FROM pg_stat_activity
WHERE state != 'idle';
```

#### 종료 조건

- `hikaricp_connections_timeout_total` ≥ 100
- DB CPU ≥ 90% 5분 이상
- `health_latency` p99 ≥ 5초 (사이트 전체 마비 신호)

→ 즉시 K6 stop + 메트릭 캡처. *풀 고갈 상태로 오래 두면 회복 시간 길어짐*.

#### 결과 저장 위치
- `reports/loadtests/k6/results/a03-YYYYMMDD-HHMMSS.json`
- `reports/loadtests/k6/results/a03-YYYYMMDD-HHMMSS-summary.json`

### 해결 방법 — 풀 고갈 추가 보완
> §2 의 락 경합 해법 3가지(트랜잭션 짧게 / 재고 시점 이동 / Redis 카운터)가 **그대로 가장 큰 효과.** 락이 줄면 풀 점유도 줄어드니까.
> 그 외에 풀 자체를 다루는 보완책:

#### 1) 트랜잭션 안 외부 호출 빼기
- 외부 API 호출, 메시지 발행 등을 트랜잭션 밖으로 (Saga / Outbox 패턴)
- 락이 짧아도 트랜잭션이 길면 풀이 묶임 → **본질은 트랜잭션 길이**

#### 2) 풀 사이즈 정밀 조정
- 무조건 키우면 오히려 손해 (`study_hikari_pool_sizing.md` 참고)
- 공식: `(CPU 코어 × 2) + 디스크 수`
- 키우는 것보다 *코드 고치는 게* 답인 경우가 더 많음

#### 3) Bulkhead — 자원 격리
- 외부 호출 전용 풀을 메인 DB 풀과 분리
- 외부 호출 장애가 메인 트래픽까지 죽이지 않게 격벽

---

## 4. ATK-A05 · 락 획득 순서 교차 데드락

### 한 줄
두 명이 같은 두 상품을 *반대 순서로* 잡으려 하면 서로 무한 대기 → DB가 한 명을 강제 롤백.

> ⚠ **A02/A03과 결이 완전히 다른 락 문제** — 트래픽 *강도* 문제가 아니라 *순서* 문제

| | A02 / A03 | A05 |
|---|---|---|
| 본질 | 같은 락에 *몰림* | 락을 *역순으로* 잡으려 함 |
| 결과 | 줄이 길어짐 (느려짐) | 무한 대기 (DB가 강제 죽임) |
| 해결 방향 | 락 *짧게* 잡기 | 락 *순서* 통일 |
| 트래픽 강도와 관계 | 강해야 발생 | 강도 무관, 순서만 어긋나면 발생 |

### 비유 — 회의실 두 개

회의실 X, Y. 각자 열쇠 한 개씩.

**김부장:** "X → Y 순서로 둘 다 빌릴게"
1. X 열쇠 잡음 ✅
2. Y 열쇠 기다림 (이부장이 갖고 있음) ⏳

**이부장:** "Y → X 순서로 둘 다 빌릴게"
1. Y 열쇠 잡음 ✅
2. X 열쇠 기다림 (김부장이 갖고 있음) ⏳

→ 김부장은 *이부장이 Y 놓길* 영원히 기다림
→ 이부장은 *김부장이 X 놓길* 영원히 기다림
→ **둘 다 영원히 못 움직임. 데드락.**

DB는 영원히 안 기다리고 **한 명을 강제로 죽임** (= victim, 트랜잭션 롤백). 죽은 쪽은 영문 모를 500 에러.

→ 회의실 = 메뉴 카드(= product row), 열쇠 = 락(= `SELECT ... FOR UPDATE`)

### 사용자 영향

| | A02 | A03 | A05 |
|---|---|---|---|
| 누가 영향? | 인기 상품 사는 사람만 | 모든 사용자 | 운 나쁜 한 명만 |
| 어떻게 보임? | 응답이 점점 느려짐 | 사이트 전체 멈춤 | 영문 모를 500 (재시도하면 성공) |
| 디버깅 난이도 | 쉬움 (패턴 명확) | 쉬움 (풀 보면 됨) | **어려움 — 재현 안 됨** ★ |

A05의 무서움: *재현이 안 됨*. 운 나쁘게 두 요청이 동시에 반대 순서로 들어왔을 때만 발생. 운영팀 미스터리: *"왜 가끔 500 에러 나지?"*

### 코드
```java
// OrderService.cancelOrder 의 for 루프 — 의도된 공격 표면
for (TargetItem t : targets) {
    Product product = productRepository.findByIdWithLock(...);  // 입력 순서대로!
    ...
}
```

→ 클라이언트가 `items=[X, Y]` 와 `items=[Y, X]` 를 동시 보내면 데드락 발생.

### K6
- RPS=50, duration=2m
- VU 절반은 [P1, P2] 순서, 절반은 [P2, P1] 순서로 cancel 호출

### 메트릭
- `pg_stat_database.deadlocks` (counter) ★ — *증가 자체가 가설 입증*
- ERROR 로그 SQLSTATE=40P01
- 5xx 비율

### ⚠ 주의사항 — 데이터 준비 / 종료 조건 / 회복 절차

- **데이터 준비**: 같은 두 상품(P1, P2)을 가진 PAID 주문 페어 ≥ 200쌍 (`data-attack.sql` 의 `ORD-A05-000001 ~ 000400`)
- **종료 조건**: `pg_stat_database.deadlocks` ≥ 1 → *발생 자체가 가설 입증*. 즉시 캡처
- **회복 절차**: `data-attack.sql` 재실행 (데드락은 자동 롤백되므로 컨테이너 재시작 불필요)

### 테스트 후 확인 체크리스트

A05 는 **데드락 1회 발생 자체가 가설 입증**. 임계치 불필요.

| 위치 | 메트릭 | A05 발현 기준 |
|---|---|---|
| K6 콘솔 | `cancel_5xx_total` (커스텀) | > 0 |
| K6 콘솔 | `deadlock_suspected_total` (커스텀) | > 0 |
| DB 쿼리 | `pg_stat_database.deadlocks` | **단조 증가 시 입증** |
| 서버 로그 | `SQLSTATE=40P01` | 발견 시 입증 |
| 서버 로그 | `deadlock detected` | 발견 시 입증 |
| Grafana | deadlocks counter 패널 | 위로 튐 |

→ deadlocks 카운트가 *0 → 1* 이 되는 순간 가설 입증 끝.

#### DB 실시간 진단 — 핵심 쿼리

```sql
-- 누적 데드락 카운트 (단조 증가 보면 입증)
SELECT datname, deadlocks
FROM pg_stat_database
WHERE datname = 'pms_order';
```

→ A05 시작 *전*에 한 번 찍어두고 (예: deadlocks = 0), *실행 중* 또는 *끝난 후* 다시 찍어서 (예: deadlocks = 5) 차이 확인.

#### 서버 로그에서 데드락 검색

```bash
# PostgreSQL 로그
docker logs pms-order-bteam-postgres-1 2>&1 | grep -i deadlock

# 앱 로그 (SQLSTATE 40P01 검색)
docker logs <앱-컨테이너> 2>&1 | grep -i "40P01\|deadlock"
```

#### 종료 조건

- 데드락 1회 이상 발생 → 즉시 K6 stop + 메트릭 캡처
- 또는 K6 자체 duration (30초) 끝까지 진행

→ A02/A03 처럼 *오래 둘 필요 없음*. 발현 확인되면 바로 종료.

#### 결과 저장 위치
- `reports/loadtests/k6/results/a05-YYYYMMDD-HHMMSS.json`
- `reports/loadtests/k6/results/a05-YYYYMMDD-HHMMSS-summary.json`

### 해결 방법 — 데드락 전용
A05의 정답은 *락을 줄이는* 게 아니라 **모든 클라이언트가 같은 순서로 락을 잡게** 하는 것.

#### 락 순서 정렬 — 한 줄로 해결
```java
// OrderService.cancelOrder 의 for 루프 직전에 한 줄 추가
targets.sort(Comparator.comparing(t -> t.orderItem.getProduct().getId()));

// 기존 for 루프 그대로
for (TargetItem t : targets) {
    Product product = productRepository.findByIdWithLock(...);
    ...
}
```

- 모든 요청이 `product.id` 오름차순으로 락 획득 → 순환 대기 자체가 안 생김
- 한 줄 추가만으로 데드락 *완벽 차단*
- 트랜잭션 길이엔 영향 없음 (A02/A03엔 효과 X — A05 전용)

#### 보조: 데드락 발생 시 자동 재시도
- 데드락은 막더라도, 다른 이유로 발생하면 자동 재시도
- `@Retryable` 또는 try-catch로 SQLSTATE=40P01 잡아서 재시도
- 단, **idempotency 보장된 작업에만** (취소는 보통 안전)

---

## 5. 발표 흐름 — 한 묶음으로

```
A02 시작 → 락 경합 (메뉴 카드) → p99 폭증
            ↓ "그 상품 사는 사람만 느림"
A03 추가 → 락 대기 + 좌석 점유 → 풀 고갈 → 사이트 전체 멈춤
            ↓ "무관한 다른 페이지도 멈춤"
A05 변형 → 역순 락 → 데드락 → DB가 victim 죽임
            ↓ "영문 모를 500 에러"
```

→ 셋을 한 흐름으로 발표: ***"같은 락 경합이 어디까지 번질 수 있는가"***

---

## 6. 해결 방법 매핑 — 시나리오별 한눈에

> 자세한 설명은 각 시나리오 안 (§2 A02 / §3 A03 / §4 A05) 참조

| 방법 | A02 | A03 | A05 |
|---|---|---|---|
| 트랜잭션 짧게 | ✅ 큰 효과 | ✅ 큰 효과 | △ 부분적 (발생 빈도만 ↓) |
| 재고 차감 시점 이동 | ✅ 큰 효과 | ✅ 큰 효과 | ❌ 효과 없음 (cancelOrder 영역) |
| Redis 카운터 | ✅ 큰 효과 | ✅ 큰 효과 | ❌ 효과 없음 |
| 락 순서 정렬 | ❌ 의미 없음 (단일 row 락) | ❌ 의미 없음 | ✅ **A05 정답** (한 줄 코드) |
| 풀 모니터링/Bulkhead | △ 보조 | ✅ 보조 큰 효과 | △ 보조 |

### 패턴
- **A02·A03 묶음** — "락 보유 시간을 줄이는" 방향이면 다 통함
- **A05** — 다른 방법은 부분적 / *락 순서 통일*이 정답. 한 줄 코드로 해결 가능

### 발표 시 한 줄 정리
> *"A02·A03은 락을 짧게 잡는 전략, A05는 락 순서를 통일하는 전략. 해결 방향이 달라요."*

---

## 7. 새 용어 정리

| 용어 | 한 줄 정의 |
|---|---|
| 락 (Lock) | 같은 데이터를 동시에 못 고치게 막는 잠금 |
| 트랜잭션 (Transaction) | 여러 DB 작업을 한 묶음으로 처리. 다 되거나 다 취소 |
| `@Transactional` | 자바에서 트랜잭션을 시작/끝내는 어노테이션 |
| 비관적 락 (Pessimistic) | "충돌 가능성 있다고 보고" 미리 잠그는 방식. `SELECT FOR UPDATE` |
| 낙관적 락 (Optimistic) | "충돌 거의 없다고 보고" 나중에 검증. `@Version` 컬럼. 우리 시스템 미사용 |
| 데드락 (Deadlock) | 두 트랜잭션이 서로 상대 락 풀리길 무한 대기. DB가 한 쪽 강제 롤백 |
| 커넥션 풀 (Connection Pool) | DB 연결을 미리 만들어두고 재사용하는 통. 우리 = HikariCP 10개 |
| p99 | 100명 응답 시간 중 99번째로 빠른 사람의 시간. "거의 모든 사용자가 느려졌다"의 직접 측정 |
| FOR UPDATE | SQL에서 "이 row 잠가" 명령 |
| SQLSTATE 40P01 | PostgreSQL 데드락 에러 코드 |
| READ COMMITTED | PostgreSQL 기본 격리 레벨. 커밋된 데이터만 보임 |

---

## 8. 진단 SQL 쿼리 (공방전 중 실시간 확인용)

```sql
-- 1. 현재 트랜잭션 상태 (어디서 뭘 기다리는지)
SELECT pid, state, wait_event, query
FROM pg_stat_activity
WHERE state != 'idle';

-- 2. 대기 중인 락 (granted = false 인 것들)
SELECT * FROM pg_locks WHERE NOT granted;

-- 3. 누적 데드락 카운트 (A05 입증)
SELECT datname, deadlocks
FROM pg_stat_database
WHERE datname = 'pms_order';
```

---

## 9. 발표 시 자주 나올 질문 + 답

| 질문 | 답 |
|---|---|
| 왜 풀 사이즈를 키우면 안 돼요? | 풀 키워도 처리 능력은 DB 자체 자원에서 결정. 키우면 락 경합·메모리 점유가 늘어 오히려 악화. (`study_hikari_pool_sizing.md` 참고) |
| 데드락은 자동 해결되는데 왜 문제예요? | DB가 한 쪽 강제 롤백 → 그 사용자는 영문 모를 500 에러. 재시도 로직 없으면 사용자 손실. 패턴이 안 보여 디버깅 어려움. |
| 트랜잭션 짧게 하면 정합성은 안 깨져요? | 짧게 = 핵심 작업만 트랜잭션 안에 두는 것. 원자성은 그대로 보장. 잡일(이벤트 발행 등)을 밖에서 처리. |
| 낙관적 락은 왜 안 쓰나요? | 우리 시스템에 `@Version` 컬럼 없음. 충돌 빈도 높으면 재시도 폭주 위험도 있어 일률적으로 더 좋다 할 수 없음. |
| 락 보유 시간을 어떻게 줄일 수 있어요? | for 루프 안 시퀀스 INSERT, refresh, deleteAll 같은 잡일을 트랜잭션 밖으로 빼기. |

---

## 10. 작업 진행 체크리스트 (5/6 회의록 5단계 기준)

회의록의 5단계 작업 순서에 시나리오 3개를 매핑해서 진행도 추적.

| 단계 | 작업 | A02 | A03 | A05 |
|---|---|---|---|---|
| 1 | 가설 / 의도 세우기 | ✅ | ✅ | ✅ |
| 2 | 필요한 메트릭 선정 | ✅ | ✅ | ✅ |
| 3 | K6 스크립트 + 더미 데이터 | DB ✅ / K6 ⏳ | DB ✅ / K6 ⏳ | DB ✅ / K6 ⏳ |
| 4 | 로컬 환경 테스트 | ❌ | ❌ | ❌ |
| 5 | 일요일 최종 점검 + 실행 | ❌ | ❌ | ❌ |

> 더미 데이터 = `pms-order/data-attack.sql` (완성)
> K6 코드 = 팀 공통 작업. 김소진은 *트리거(실행)* 만

### 일요일(5/10 10시) 전 남은 작업

1. **K6 코드 작성자에게 시드 ID 합의 공유** — `data-attack.sql` 상단 주석 4줄을 슬랙/노션으로 공유
2. **로컬에서 K6 1회 시뮬레이션 시도** — 풀이 진짜 터지는지 직접 확인 (발표 자신감 ↑)
3. **PR 업데이트 후 머지** — 회의록 본인 액션 아이템

---

## 11. 학습 출처

- `docs/2Phase/attack_scenario/공방전_공격팀_지식전달.pdf` — 발표 본편 (37p)
- `docs/study_hikari_pool_sizing.md` — HikariCP 풀 사이즈 결정 기준
- `pms-order/src/main/java/.../OrderService.java` — createOrder, cancelOrder 코드
- `pms-order/src/main/java/.../ProductRepository.java` — findByIdWithLock
- `pms-order/src/main/resources/application.yml` — Hikari 설정
