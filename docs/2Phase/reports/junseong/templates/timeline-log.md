# 기록자 타임라인 로그 (당일 실시간 작성)

## TL;DR

> PDF p.26 골든 포맷: `[HH:MM:SS] [시나리오 ID] [상태] 관찰값`
> 8개 시나리오를 같은 형식으로 기록 → 그대로 인시던트 리포트 골격이 됨.

---

## 상태 코드 사전

| 코드 | 의미 |
|---|---|
| `[BASELINE]` | 시작 전 기준값 |
| `[START]` | 시나리오 시작, 트리거 발동 |
| `[TRIGGER]` | 인프라 조작 (pause/stop 등) |
| `[TICK]` | 정기 관찰 (30초 간격, 여유 있을 때) |
| `[WARNING]` | 임계값 근접 (곧 STOP 가능성) |
| `[SIGNAL]` | 가설 입증 결정적 메트릭 도달 |
| `[STOP]` | 종료 조건 충족 또는 수비팀 요청 → 즉시 K6 중단 |
| `[RECOVER]` | 정리 / 재시작 |
| `[READY]` | 다음 시나리오 가능 (cooldown 종료) |

---

## 시나리오별 빈칸 (당일 채우기)

### F01 · 장바구니 정수 오버플로우 (담당: 김소라)

```
[__:__:__] [F01] [START]    payload=quantity=2147483647, RPS=__
[__:__:__] [F01] [SIGNAL]   product.stock_quantity=___, total_amount=___
[__:__:__] [F01] [STOP]     이유: ___
[__:__:__] [F01] [RECOVER]  __
[__:__:__] [F01] [READY]    __
```

### A01 · 음수 수량 주문 (담당: 김소라)

```
[__:__:__] [A01] [START]    payload=quantity=-1, RPS=__
[__:__:__] [A01] [SIGNAL]   stock_quantity=___ (음수 발생: Y/N)
[__:__:__] [A01] [STOP]     __
[__:__:__] [A01] [RECOVER]  __
[__:__:__] [A01] [READY]    __
```

### A02 · 동일 상품 집중 주문 락 경합 (담당: 김소진)

```
[__:__:__] [A02] [BASELINE] pool active __/10, p99 ___ms
[__:__:__] [A02] [START]    RPS=100, productId=1, duration=3m
[__:__:__] [A02] [TICK]     pool=__/10, pending=__, p99=___ms
[__:__:__] [A02] [WARNING]  pool=9/10, p99=___ms
[__:__:__] [A02] [SIGNAL]   pg_locks waiting=__, p99=___ms
[__:__:__] [A02] [STOP]     __
[__:__:__] [A02] [RECOVER]  __
[__:__:__] [A02] [READY]    __
```

### A03 · 락 대기 누적 커넥션 풀 고갈 (담당: 김소진 + 이용선)

```
[__:__:__] [A03] [BASELINE] pool active __/10, p99 ___ms
[__:__:__] [A03] [START]    RPS=100→150→200, executor=ramping-arrival-rate
[__:__:__] [A03] [TICK]     pool active __/10, pending __, p99 ___ms
[__:__:__] [A03] [WARNING]  pool active 9/10, pending __
[__:__:__] [A03] [SIGNAL]   pool=10/10, pending=__, timeout_total=__
[__:__:__] [A03] [STOP]     timeout_total ≥ 100 도달
[__:__:__] [A03] [RECOVER]  K6 stop, 컨테이너 재시작
[__:__:__] [A03] [READY]    pool active 0/10
```

### A05 · 락 획득 순서 교차 데드락 (담당: 김소진)

```
[__:__:__] [A05] [START]    RPS=50, [P1,P2] vs [P2,P1] 절반씩
[__:__:__] [A05] [SIGNAL]   pg_stat_database.deadlocks=__, SQLSTATE=40P01 발생
[__:__:__] [A05] [STOP]     __
[__:__:__] [A05] [RECOVER]  __
[__:__:__] [A05] [READY]    __
```

### B01 · 외부 PG 호출 시 커넥션 점유 (담당: 김소라 + 이용선)

```
[__:__:__] [B01] [BASELINE] hikaricp active __/10, tomcat busy __/__
[__:__:__] [B01] [START]    RPS=100, duration=5m
[__:__:__] [B01] [TICK]     hikaricp=__/10, tomcat=__/__, p99=___ms
[__:__:__] [B01] [SIGNAL]   hikaricp 수렴치 = 10, p99 폭증, 5xx=__%
[__:__:__] [B01] [STOP]     __
[__:__:__] [B01] [RECOVER]  cooldown 10분
[__:__:__] [B01] [READY]    __
```

### B02 · 중복 결제 Race Condition (담당: 김소라)

```
[__:__:__] [B02] [START]    같은 orderId, 100ms 내 2 VU 동시 호출
[__:__:__] [B02] [SIGNAL]   payment row __개 (>1 면 중복) 또는 UNIQUE 제약 발동
[__:__:__] [B02] [STOP]     __
[__:__:__] [B02] [RECOVER]  __
[__:__:__] [B02] [READY]    __
```

### C03 · 취소 이벤트 발행 실패 (담당: 김준성) ★ 본 담당 시나리오

```
[__:__:__] [C03] [BASELINE] DB cancelled=0, MQ published=___
[__:__:__] [C03] [TRIGGER]  docker pause rabbitmq 완료
[__:__:__] [C03] [START]    K6 발사 (vus=10, iter=5)
[__:__:__] [C03] [SIGNAL]   K6 종료, HTTP 200=50/50
[__:__:__] [C03] [TRIGGER]  docker unpause rabbitmq 완료
[__:__:__] [C03] [SIGNAL]   DB cancelled=__, MQ published=__, 유실=__건
[__:__:__] [C03] [STOP]     정상 종료
[__:__:__] [C03] [RECOVER]  reset-data.sh 실행
[__:__:__] [C03] [READY]    다음 시나리오 가능
```

---

## 시나리오 간 cooldown / 순서 메모

| # | 시나리오 | 시작 시각 | 종료 시각 | 비고 |
|---|---|---|---|---|
| 1 | F01 | __ | __ | |
| 2 | A01 | __ | __ | |
| 3 | A02 | __ | __ | |
| 4 | A03 | __ | __ | A02 직후 권장 |
| 5 | A05 | __ | __ | |
| 6 | B01 | __ | __ | cooldown 10분 |
| 7 | B02 | __ | __ | |
| 8 | C03 | __ | __ | |

---

## Slack 채널 stamp 메시지 형식

```
🚀 시나리오 [C03] 시작 (HH:MM:SS)
📊 시나리오 [C03] 신호: DB cancelled=50, MQ published=3 → 유실 47건
✅ 시나리오 [C03] 종료 (HH:MM:SS), 가설 입증
```

---

## 작성 규칙

1. **시각은 항상 HH:MM:SS** (모든 메트릭 캡처 시 동일 시계 기준)
2. **임계값 도달 즉시 외치고 기록** (트리거가 다음 행동 결정)
3. **TICK은 여유 있을 때만** — START/SIGNAL/STOP은 필수
4. **수치는 비울 수 없음** (관측값이 없으면 `?` 또는 `-`로 표기, 사후 채울 때 구분 가능)
