# 1주차 과제 — 동시성 버그 재현 공격 스크립트 실행 가이드

> **대상 이슈**: [인프라 레벨 동시성 제어 #20](https://github.com/protect-my-service/pms-order-bteam/issues/20)
> **대상 브랜치**: `bug/remove-product-lock-for-concurrency-study` ([PR #24](https://github.com/protect-my-service/pms-order-bteam/pull/24))

---

## 재현 대상 버그

주문 생성 시 상품 재고 차감에 동시성 제어가 없어 **갱신 분실(lost update)** 이 발생합니다.

```
TX-A: stock=100 읽음 → stock=99로 UPDATE
TX-B: stock=100 읽음 → stock=99로 UPDATE  ← TX-A의 차감이 덮어씌워짐
```

결과: 재고 100개 상품에 수백 건의 주문이 성공하고, 실제 재고는 100만 차감됩니다.

---

## 사전 준비

### 1. 필수 도구 설치

```bash
# k6 (부하 테스트 도구)
brew install k6

# Docker (PostgreSQL, RabbitMQ 실행용)
# https://docs.docker.com/desktop/install/mac-install/
```

### 2. 프로젝트 클론

```bash
git clone https://github.com/protect-my-service/pms-order-bteam.git
cd pms-order-bteam

# 취약한 상태의 브랜치로 전환
git checkout bug/remove-product-lock-for-concurrency-study
```

### 3. 공격 스크립트 클론 (별도 저장소)

```bash
# pms-order-bteam과 같은 상위 디렉토리에 클론
cd ..
git clone https://github.com/protect-my-service/tema-a.git
```

디렉토리 구조:
```
.
├── pms-order-bteam/     ← 서버 코드
└── tema-a/              ← k6 공격 스크립트
    └── loadtests/k6/
        ├── config/env.js
        ├── lib/http.js, data.js
        ├── data.sql
        └── tests/attack/a02-order-hot-row-lock.js
```

---

## 실행 순서

### Step 1: 인프라 기동 (PostgreSQL + RabbitMQ)

```bash
cd pms-order-bteam
docker compose up -d
```

PostgreSQL 준비 대기:
```bash
pg_isready -h localhost -p 5432
# "accepting connections" 출력까지 대기
```

### Step 2: 애플리케이션 빌드 및 기동

```bash
./gradlew build -x test
java -jar build/libs/pms-order-0.0.1-SNAPSHOT.jar --spring.profiles.active=local
```

기동 확인:
```bash
curl http://localhost:8080/actuator/health
# {"status":"UP"} 응답 확인
```

### Step 3: 시드 데이터 적재

```bash
PGPASSWORD=pms1234 psql -h localhost -p 5432 -U pms -d pms_order \
  -f ../tema-a/loadtests/k6/data.sql
```

적재 결과:
- 회원 100명 (member 1~100)
- 카테고리 10개
- 상품 50개 (product 1~50)
- 회원별 장바구니 100개

### Step 4: 공격 대상 상품 재고 설정

재고를 100으로 고정하여 overselling을 쉽게 관찰합니다:
```bash
PGPASSWORD=pms1234 psql -h localhost -p 5432 -U pms -d pms_order \
  -c "UPDATE product SET stock_quantity = 100 WHERE id = 1;"
```

공격 전 재고 확인:
```bash
PGPASSWORD=pms1234 psql -h localhost -p 5432 -U pms -d pms_order \
  -c "SELECT id, name, stock_quantity FROM product WHERE id = 1;"

#  id |   name    | stock_quantity
# ----+-----------+----------------
#   1 | Product-1 |            100
```

### Step 5: Smoke 테스트 (기본 동작 확인)

공격 전에 주문 흐름이 정상인지 확인합니다:
```bash
cd ..   # tema-a와 같은 상위 디렉토리로 이동
k6 run tema-a/loadtests/k6/tests/smoke/order-create.smoke.js
```

기대 결과:
```
✓ cart add 2xx
✓ order create 2xx
http_req_failed: 0.00%
```

> **모든 check가 ✓이면** 환경이 정상입니다. 실패하면 앱 기동/시드 데이터를 다시 확인하세요.

### Step 6: 공격 실행 (동시성 버그 재현)

```bash
k6 run \
  -e VUS=50 \
  -e DURATION=10s \
  -e TARGET_PRODUCT=1 \
  -e SLEEP=0 \
  -e RAMP_UP=1s \
  -e PROBE_DURATION=20s \
  tema-a/loadtests/k6/tests/attack/a02-order-hot-row-lock.js
```

파라미터 설명:
| 파라미터 | 값 | 설명 |
|----------|-----|------|
| `VUS` | 50 | 동시 가상 사용자 수 |
| `DURATION` | 10s | 최대 부하 유지 시간 |
| `TARGET_PRODUCT` | 1 | 공격 대상 상품 ID |
| `SLEEP` | 0 | 요청 간 대기 시간 (0 = tight loop) |
| `RAMP_UP` | 1s | VU가 0→50까지 증가하는 시간 |
| `PROBE_DURATION` | 20s | health check 프로브 지속 시간 |

### Step 7: 결과 검증

k6 실행이 끝나면 DB에서 정합성을 확인합니다:

```bash
PGPASSWORD=pms1234 psql -h localhost -p 5432 -U pms -d pms_order -c "
SELECT
  p.stock_quantity                     AS remaining_stock,
  (SELECT COUNT(*)
     FROM order_item oi
     JOIN orders o ON oi.order_id = o.id
    WHERE oi.product_id = 1)           AS total_orders,
  (SELECT SUM(oi.quantity)
     FROM order_item oi
     JOIN orders o ON oi.order_id = o.id
    WHERE oi.product_id = 1)           AS total_ordered_qty,
  100 - p.stock_quantity               AS stock_deducted,
  (SELECT SUM(oi.quantity)
     FROM order_item oi
     JOIN orders o ON oi.order_id = o.id
    WHERE oi.product_id = 1)
  - (100 - p.stock_quantity)           AS discrepancy
FROM product p
WHERE p.id = 1;
"
```

**정상(버그 없음)**이면:
```
remaining_stock=0, total_orders=100, discrepancy=0
```

**버그 재현 성공**이면:
```
remaining_stock=0, total_orders=400+, discrepancy=300+
                                       ↑ 재고 차감 없이 성공한 주문 수
```

---

## 실측 재현 결과 (참고)

로컬 환경 (M-시리즈 Mac, PostgreSQL 15, 50 VU, 10초):

| 지표 | 값 |
|------|-----|
| 초기 재고 | 100 |
| 성공한 주문 수 | **482건** |
| 실제 주문 수량 합계 | 554개 |
| 차감된 재고 | 100 |
| **정합성 불일치 (discrepancy)** | **454건** |

재고 100개짜리 상품에 482건의 주문이 성공했으며, 454건은 재고 차감 없이 통과한 **갱신 분실(lost update)** 버그입니다.

---

## 과제 진행 방법

1. 위 공격으로 **버그가 재현되는 것을 확인**합니다
2. 아래 중 하나를 선택하여 **동시성 제어를 구현**합니다:
   - A. Redis 분산락 (Redisson RLock)
   - B. DB 격리수준 변경 + Unique Constraint
   - C. RabbitMQ/Kafka 기반 큐 직렬화
   - D. PostgreSQL Advisory Lock
   - E. 낙관적 락 (@Version) + 재시도
3. 구현 후 **동일한 공격 스크립트**를 다시 실행하여 `discrepancy = 0`이 되는지 검증합니다

---

## 데이터 초기화 (재테스트 시)

```bash
# 시드 데이터 재적재
PGPASSWORD=pms1234 psql -h localhost -p 5432 -U pms -d pms_order \
  -f ../tema-a/loadtests/k6/data.sql

# 대상 상품 재고 설정
PGPASSWORD=pms1234 psql -h localhost -p 5432 -U pms -d pms_order \
  -c "UPDATE product SET stock_quantity = 100 WHERE id = 1;"
```

---

## 인프라 정리

```bash
cd pms-order-bteam
docker compose down
```
