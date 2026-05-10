# 테스트 리포트 템플릿

## 1. 시나리오 개요

| 항목 | 내용 |
|---|---|
| ATK/SMOKE ID |  |
| 시나리오명 |  |
| 대상 API |  |
| 목표 가설 |  |
| 기대 관측값 |  |

## 2. 실행 조건

| 항목 | 내용 |
|---|---|
| 실행 일시 |  |
| 실행자 |  |
| 대상 서버 |  |
| 브랜치 / 커밋 |  |
| DB 초기화 여부 |  |
| `testid` |  |
| `TARGET_PRODUCT` |  |
| `VUS` |  |
| `DURATION` |  |

실행 명령:

```bash

```

## 3. Grafana 관측 결과

대시보드는 결론이 아니라 관측 근거입니다. 각 패널마다 “무엇이 보였는지”와 “그것이 가설과 어떤 관련이 있는지”를 같이 적습니다.

### 3-1. Virtual Users

캡처:

```text
이미지 또는 링크
```

관측:

```text

```

해석:

```text

```

### 3-2. Request Rate

캡처:

```text
이미지 또는 링크
```

관측:

```text

```

해석:

```text

```

### 3-3. Latency p95

캡처:

```text
이미지 또는 링크
```

관측:

```text

```

해석:

```text

```

### 3-4. Failure Rate

캡처:

```text
이미지 또는 링크
```

관측:

```text

```

해석:

```text

```

### 3-5. Order Errors

캡처:

```text
이미지 또는 링크
```

관측:

```text

```

해석:

```text

```

### 3-6. Checks

캡처:

```text
이미지 또는 링크
```

관측:

```text

```

해석:

```text

```

## 4. Prometheus 확인

Grafana가 비어 있거나 지표가 의심스러우면 Prometheus에서 원시 지표를 확인합니다.

| 확인 항목 | PromQL | 결과 |
|---|---|---|
| k6 지표 유입 | `k6_http_reqs_total` |  |
| testid 확인 | `k6_http_reqs_total{testid="..."}` |  |
| 초당 요청 수 | `rate(k6_http_reqs_total{testid="..."}[1m])` |  |
| HTTP 실패율 | `k6_http_req_failed_rate{testid="..."}` |  |
| 주문 p95 지연 | `k6_order_latency_ms_p95{testid="..."}` |  |
| 주문 5xx 증가량 | `increase(k6_order_5xx_total{testid="..."}[1m])` |  |

## 5. k6 터미널 결과

핵심 결과:

| 항목 | 결과 | 해석 |
|---|---|---|
| `http_req_duration` |  |  |
| `http_req_failed` |  |  |
| `checks_succeeded` |  |  |
| 주요 custom metric |  |  |
| threshold 통과 여부 |  |  |

터미널 출력:

```text

```

## 6. 서버 로그 및 DB 상태

### 6-1. 서버 로그

```text

```

확인한 내용:

```text

```

### 6-2. DB 상태

확인 쿼리:

```sql

```

확인 결과:

```text

```

## 7. 결론

| 항목 | 내용 |
|---|---|
| 판단 | 가설 재현됨 / 일부 재현됨 / 재현 안 됨 |
| 핵심 근거 |  |
| 주요 리스크 |  |

결론 상세:

```text

```

## 8. 후속 조치

| 우선순위 | 조치 | 이유 |
|---|---|---|
| P1 |  |  |
| P2 |  |  |
| P3 |  |  |
