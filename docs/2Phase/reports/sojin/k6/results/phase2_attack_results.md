# Phase 2 공방전 — 공격 결과 통합 보고서

> 실행일: 2026-05-10
> 작성: 김소진 (DB 레이어, 시드 + timezone 패치 + 분석 정리)
> 대상: 방어팀 서버 (`https://53e9-221-146-217-125.ngrok-free.app`)
> 시드: `tema-a/reports/data/data-attack.sql` (timezone 패치 적용본)
> 부하 도구: k6 (`tema-a/reports/k6/scenrio/`)
> 분석 보고서 (시나리오별):
> - [ATK-A02 상세](a02-20260510-121335-analysis.md)
> - [ATK-A03 상세](a03-20260510-123712-analysis.md)
> - [ATK-A05 상세](a05-20260510-141606-analysis.md)

---

## 1. 한눈 요약

| 시나리오 | 부하 | 핵심 의도 | 5xx | latency p99 | health max | 가설 입증 |
|---|---|---|---|---|---|---|
| **A02** · 한정판 락 경합 | RPS 100 × 3m | hot row(P1) `SELECT FOR UPDATE` 직렬화 | 8 | 530ms | 203ms | 부분 (락 경합 자체는 발현, 다운까지 X) |
| **A03** · 풀 고갈 | RPS 50→200 ramp × 3.5m | A02가 풀 고갈로 번지는지 | 7 | 217ms | 288ms | **실패** (차단/터널 한계가 부하 상한선) |
| **A05** · 데드락 | RPS 5+5 × 30s | 반대 순서 락 획득 → wait-for cycle | **147** | **34s** | **29s** | **성공** (+ 부수적으로 풀 고갈까지 동반 입증) |

**핵심 관찰**: 부하의 양이 아니라 **패턴(반대 순서 락 획득)** 이 락 표면을 정확히 때렸을 때 가장 큰 임팩트가 나옴. A05가 RPS 10으로 RPS 100~200 시나리오들을 압도.

---

## 2. 실행 환경과 사전 차단 두 단계

### 2.1 환경

- 방어팀 서버: ngrok 무료 티어 터널 (RPS ≈ 100 부근에서 차단/throttle 발생)
- 헤더: `X-Member-Id`, `Content-Type: application/json`, `ngrok-skip-browser-warning: true`
- 시드: 회원 1,000 / 카테고리 10 / 핫 상품 P1·P2 (재고 99,800) / PAID 주문 400 / OrderItem 800 / Payment 400
- 헬퍼 lib (이번 회차 신규 작성):
  - `tema-a/config/env.js` — `BASE_URL`, `baseThresholds`
  - `tema-a/lib/http.js` — `postCartItem`, `postOrder`, `getHealth`
  - `tema-a/lib/data.js` — `pickMember()` (1~1000 random)

### 2.2 A05에서 부딪힌 두 단계의 사전 차단 (이번 회차에 해결)

| # | 증상 | 원인 | 해결 |
|---|---|---|---|
| 1 | 모든 cancel 100% **400** | 방어팀 DB에 `PAYTEST-XXXXXX` 시드만 있고 우리 ORD-A05 시드 미적용 | 방어팀에 `data-attack.sql` 적용 요청 |
| 2 | 모든 cancel 100% **409** CANCEL_WINDOW_EXPIRED | DB 컨테이너 timezone=UTC, JVM=KST 미스매치 → `paid_at`이 9시간 36분 과거로 인식 | `data-attack.sql`의 `NOW()` → `(NOW() AT TIME ZONE 'Asia/Seoul')` 패치 + 재적용 |

→ 이 두 단계를 거쳐야 **데드락 표면까지 트래픽이 도달**한다는 점은, 다음 공방전 시드 합의에서 사전 점검할 만한 항목.

---

## 3. 시나리오별 결과

### 3.1 ATK-A02 · 한정판 락 경합

- 12:13:35 ~ 12:16:55 (KST)
- postOrder 4,045 / cart 11,743 / health 107
- order p99 530ms, max 929ms, 5xx 8건
- **CPU 두 번 튄 패턴 관측**: 12:13(1차) → 12:14 cart timeout 5,775건 (방어/터널 차단) → 12:15(2차, 더 강함, max 929ms)
- 의미: 1차 공격 → 방어 대응 → 차단 해제 → 2차 공격이 한 번의 실행 안에서 자연스럽게 발생. 차단 해제 직후가 더 위험.

→ 상세: [a02-20260510-121335-analysis.md](a02-20260510-121335-analysis.md)

### 3.2 ATK-A03 · 풀 고갈

- 12:37:13 ~ 12:41:19 (KST)
- postOrder 4,039 / cart 14,825 / health 114
- order p99 217ms, max 318ms, 5xx 7건, **pool_timeout(30s+) 0건**
- RPS를 50→200으로 올렸지만 order 성공량은 A02와 거의 같음(3,985 vs 3,970). **실제 서버에 도달한 부하는 오히려 작아서 레이턴시가 더 낮음**.
- cart 단계 status=0이 71%까지 올라감 → ngrok/방어 차단이 RPS ≈ 100 부근에서 부하 상한선 역할.
- 가설(풀 고갈 → 사이트 다운) **입증 실패** — 풀 고갈은 K6/ngrok 만으로는 못 깨짐.

→ 상세: [a03-20260510-123712-analysis.md](a03-20260510-123712-analysis.md)

### 3.3 ATK-A05 · 데드락

- 14:16:06 ~ 14:17 (KST), 30초
- cancel 168 attempts / health 5
- **5xx 147건** (group_xy 73 + group_yx 74, 거의 1:1 동수 → 데드락 victim 패턴)
- latency p99 **34초**, max **34.9초**, **≥30s 응답 39건 (23%)** → HikariCP connection-timeout 도달
- **health max 29.2초** → 사이트 전체가 사실상 응답 불가
- 200 성공도 평균 13.8초 — 락 큐 끝에서 겨우 통과
- 가설(데드락) **입증 성공** + 부수적으로 A03 가설(풀 고갈 → 사이트 다운)도 동시 입증

→ 상세: [a05-20260510-141606-analysis.md](a05-20260510-141606-analysis.md)

---

## 4. 비교 표 (전체 지표)

| 지표 | A02 | A03 | A05 |
|---|---|---|---|
| 부하 패턴 | constant-rate 100 RPS | ramping 50→200 RPS | constant 5+5 RPS, 반대순서 페이로드 |
| 실행 시간 | 3분 (+health 4분) | 3.5분 ramp (+health 4분) | 30초 |
| 주요 호출 수 | order 4,045 | order 4,039 | cancel 168 |
| 성공 수 | order 201: 3,970 | order 201: 3,985 | cancel 200: 11 |
| 4xx | 67 | 47 | 4 (409) |
| 5xx | 8 | 7 | **147** |
| status=0 (응답 못받음) | 7,436 (cart) | 10,512 (cart) | 6 |
| latency p50 | 105ms | 102ms | **20.7s** |
| latency p99 | 530ms | 217ms | **34.0s** |
| latency max | 929ms | 318ms | **34.9s** |
| ≥30s 응답 (풀 고갈 시그널) | — | 0 | **39건 (23%)** |
| health max | 203ms | 288ms | **29.2s** |
| 가설 입증 | 부분 | 실패 | **성공** |

---

## 5. 인사이트

1. **부하의 양 ≠ 임팩트의 크기**
   A05가 가장 낮은 RPS(10)인데 가장 큰 피해. **표면을 정확히 때리는 패턴**이 단순 폭격보다 효율적.

2. **방어팀의 사전 차단이 A02/A03 가설을 가림**
   ngrok/방어 단의 RPS 차단(≈100)이 부하 상한선 역할. 그래서 A03 풀 고갈이 K6 만으로는 못 깨졌고, A02도 핫패스가 직접 받은 부하는 제한적이었음. 다음 회차는 **직접 IP/안정 터널**로 우회하는 게 의미 있을 듯.

3. **A05의 부수효과 = A03 가설**
   A05 데드락 victim들의 롤백/재시도가 풀을 묶고, 그 사이 헬스 체크조차 10초+. **데드락 → 풀 고갈 → 사이트 다운**의 다단 효과가 단일 시나리오에서 발현.

4. **시드 timezone 미스매치는 보고할 만한 발견**
   DB UTC + JVM KST + `timestamp without time zone` 컬럼 조합은 cancel 윈도우/만료 정책이 있는 모든 시나리오를 침묵 차단함. 시드 작성자(나)와 방어팀 모두에게 학습 포인트.

---

## 6. 방어팀에 제안할 만한 보강 포인트

> A05가 통과한 표면 기준. 방어팀 코드 (`OrderService.cancelOrder`) 에 적용하면 효과가 큼.

1. **상품 락 획득 순서를 입력 순서에서 → `product.id` 오름차순으로 정렬**
   for-loop이 입력 그대로 `findByIdWithLock` 호출하는 한 데드락 표면이 살아있음. 정렬 한 줄로 제거 가능.

2. **외부 PG/refund 호출을 `@Transactional` 밖으로 분리**
   PG 호출(수백 ms) 동안 Order락 + N개 Product락이 묶여 풀 고갈 가속. saga/이벤트로 빼면 락 점유 시간 급감.

3. **HikariCP `connection-timeout` 단축 + 백오프**
   30초 매달림이 23% 발생 → 더 빨리 fail-fast 후 재시도/큐잉으로 복구 빨라짐.

4. **DB timezone을 KST로 통일하거나 컬럼을 `timestamptz`로 변경**
   이번 시드 사고와 같은 묵음 차단을 막음.

---

## 7. 재현 절차

```bash
# 1) 시드 (timezone 패치본)
docker exec -i <postgres> psql -U pms -d pms_order \
  < tema-a/reports/data/data-attack.sql

# 2) 시드 적용 직후 1시간 안에 실행
cd /Users/kimsojin/Git/protect-my-service
BASE_URL=https://<defender-host>:<port> ./tema-a/reports/k6/scripts/sojin/run-a02.sh
BASE_URL=https://<defender-host>:<port> ./tema-a/reports/k6/scripts/sojin/run-a03.sh
BASE_URL=https://<defender-host>:<port> ./tema-a/reports/k6/scripts/sojin/run-a05.sh
```

각 실행 결과는 `tema-a/reports/k6/results/<시나리오>-<타임스탬프>.json` 으로 저장.
대시보드 HTML(`-dashboard.html`)은 K6_WEB_DASHBOARD_EXPORT 옵션으로 함께 생성됨.

---

## 8. 첨부 파일 인덱스

| 종류 | 경로 |
|---|---|
| 시드 | `tema-a/reports/data/data-attack.sql` |
| 시나리오 (k6 .js) | `tema-a/reports/k6/scenrio/a02-hot-row-lock.js`, `a03-pool-exhaustion.js`, `a05-cancel-deadlock.js` |
| 실행 스크립트 | `tema-a/reports/k6/scripts/sojin/run-a02.sh`, `run-a03.sh`, `run-a05.sh` |
| 헬퍼 lib | `tema-a/config/env.js`, `tema-a/lib/http.js`, `tema-a/lib/data.js` |
| 시나리오별 분석 | `tema-a/reports/k6/results/<시나리오>-<TS>-analysis.md` |
| 대시보드 (HTML) | `tema-a/reports/k6/results/<시나리오>-<TS>-dashboard.html` (A03·A05만, 그래프용) |
| Raw JSON | 정리 시 삭제. 필요 시 k6 재실행으로 재생성 (재현 절차 참조) |
| 본 통합 보고서 | `tema-a/reports/phase2_attack_results.md` |
| 학습 노트 (사전 자료) | `tema-a/reports/phase2_lock_concepts.md` |
