# k6 Grafana 연동

k6 실행 결과를 터미널 요약뿐 아니라 Grafana 대시보드에서 시간 흐름으로 보기 위한 로컬 관측 구성입니다.

구성은 다음 흐름을 사용합니다.

```text
k6
→ Prometheus remote write
→ Prometheus
→ Grafana
```

각 도구의 역할은 다음과 같습니다.

| 구성 요소 | 역할 |
|---|---|
| `k6` | smoke/attack 시나리오를 실행하고 `http_req_duration`, `http_req_failed`, `order_latency_ms` 같은 테스트 지표를 생성 |
| `Prometheus remote write` | k6가 생성한 지표를 Prometheus로 밀어 넣는 출력 방식 |
| `Prometheus` | k6 지표를 시간 순서대로 저장하고 Grafana가 조회할 수 있는 PromQL API 제공 |
| `Grafana` | Prometheus에 저장된 지표를 대시보드 그래프로 시각화 |

즉, k6는 부하를 만들고, Prometheus는 지표를 저장하며, Grafana는 저장된 지표를 보여줍니다.

## 1. 구성 파일

```text
observability/
├── README.md
├── docker-compose.yml
├── prometheus/
│   └── prometheus.yml
└── grafana/
    ├── dashboards/
    │   └── k6-atk-a02.json
    └── provisioning/
        ├── dashboards/
        │   └── k6.yml
        └── datasources/
            └── prometheus.yml
```

| 파일 | 역할 |
|---|---|
| `docker-compose.yml` | Prometheus와 Grafana 실행 |
| `prometheus/prometheus.yml` | Prometheus 기본 설정 |
| `grafana/provisioning/datasources/prometheus.yml` | Grafana에 Prometheus datasource 자동 등록 |
| `grafana/provisioning/dashboards/k6.yml` | Grafana dashboard provider 설정 |
| `grafana/dashboards/k6-atk-a02.json` | ATK-A02용 k6 대시보드 |

## 2. Grafana/Prometheus 실행

```bash
cd ~/Desktop/protectMyService/tema-a/loadtests/k6/observability

docker compose up -d
```

접속 정보:

```text
Grafana:    http://localhost:3000
Prometheus: http://localhost:9090
계정:       admin / admin
```

Grafana에 접속하면 Prometheus datasource와 `k6 ATK-A02` 대시보드가 자동으로 등록됩니다.

## 3. k6 결과를 Grafana로 전송

k6 워크스페이스로 이동합니다.

```bash
cd ~/Desktop/protectMyService/tema-a/loadtests/k6
```

smoke 테스트:

```bash
docker exec -i phase2-postgres-1 psql -U pms -d pms_order < data.sql

K6_PROMETHEUS_RW_SERVER_URL=http://localhost:9090/api/v1/write \
K6_PROMETHEUS_RW_TREND_STATS=p(90),p(95),p(99),min,max,avg \
k6 run -o experimental-prometheus-rw \
  --tag testid=order-create-smoke \
  tests/smoke/order-create.smoke.js
```

ATK-A02 공격 시나리오:

```bash
docker exec -i phase2-postgres-1 psql -U pms -d pms_order < data.sql

K6_PROMETHEUS_RW_SERVER_URL=http://localhost:9090/api/v1/write \
K6_PROMETHEUS_RW_TREND_STATS=p(90),p(95),p(99),min,max,avg \
k6 run -o experimental-prometheus-rw \
  --tag testid=a02-hot-row-vus20 \
  tests/attack/a02-order-hot-row-lock.js
```

공격 강도를 조정할 때도 같은 방식으로 환경변수를 추가합니다.

```bash
docker exec -i phase2-postgres-1 psql -U pms -d pms_order < data.sql

TARGET_PRODUCT=9 VUS=50 DURATION=10s \
K6_PROMETHEUS_RW_SERVER_URL=http://localhost:9090/api/v1/write \
K6_PROMETHEUS_RW_TREND_STATS=p(90),p(95),p(99),min,max,avg \
k6 run -o experimental-prometheus-rw \
  --tag testid=a02-hot-row-vus50 \
  tests/attack/a02-order-hot-row-lock.js
```

`testid` 태그는 Grafana에서 실행 결과를 구분하기 위한 값입니다. 테스트를 여러 번 실행할 때는 매번 다른 이름을 주면 비교하기 쉽습니다.

## 4. Prometheus에서 확인할 것

Prometheus는 대시보드 분석 화면이라기보다, k6 지표가 정상적으로 들어왔는지 확인하고 Grafana에서 사용할 PromQL을 검증하는 곳입니다.

접속:

```text
http://localhost:9090
```

Prometheus 상단 검색창에서 아래 쿼리를 실행해 봅니다.

| 확인 목적 | PromQL | 의미 |
|---|---|---|
| k6 지표 유입 확인 | `k6_http_reqs_total` | k6가 Prometheus로 지표를 보내고 있는지 확인 |
| 특정 실행 결과 확인 | `k6_http_reqs_total{testid="a02-hot-row-vus20"}` | `--tag testid=...`로 지정한 실행 결과가 들어왔는지 확인 |
| 초당 요청 수 확인 | `rate(k6_http_reqs_total{testid="a02-hot-row-vus20"}[1m])` | 최근 1분 기준 초당 요청 수 |
| HTTP 실패율 확인 | `k6_http_req_failed_rate{testid="a02-hot-row-vus20"}` | 전체 HTTP 요청 실패율 |
| 주문 지연 확인 | `k6_order_latency_ms_p95{testid="a02-hot-row-vus20"}` | 주문 요청 p95 지연 시간 |
| 주문 5xx 확인 | `increase(k6_order_5xx_total{testid="a02-hot-row-vus20"}[1m])` | 최근 1분 동안 증가한 주문 5xx 수 |

대시보드가 비어 있으면 먼저 Prometheus에서 `k6_http_reqs_total`을 조회합니다.

| Prometheus 결과 | 해석 |
|---|---|
| `k6_http_reqs_total`이 없음 | k6가 Prometheus로 지표를 보내지 못한 상태. `K6_PROMETHEUS_RW_SERVER_URL`, `-o experimental-prometheus-rw`, Prometheus 실행 상태 확인 |
| `k6_http_reqs_total`은 있지만 `testid` 조건 결과가 없음 | k6 실행 시 지정한 `--tag testid=...` 값과 Grafana 변수 값이 맞는지 확인 |
| Prometheus에는 결과가 있는데 Grafana가 비어 있음 | Grafana 시간 범위, datasource, dashboard query를 확인 |

## 5. 대시보드에서 보는 지표

대시보드는 테스트 결과를 끝내기 위한 화면이 아니라, 공격 시나리오의 가설이 실제로 재현됐는지 판단하기 위한 관측 화면입니다.

ATK-A02의 가설은 “동일 상품 주문이 몰리면 product row 락 경합으로 주문 지연과 실패가 증가할 수 있다”입니다. 따라서 대시보드에서는 아래 순서로 봅니다.

| 순서 | 확인할 것 | 이유 |
|---|---|---|
| 1 | `Virtual Users`가 의도한 값까지 올라갔는지 | 실제로 원하는 강도의 부하가 들어갔는지 확인 |
| 2 | `Request Rate`가 테스트 중 유지됐는지 | 요청이 너무 적으면 공격 조건이 만들어지지 않음 |
| 3 | `Latency p95`에서 주문 지연이 튀는지 | 락 대기나 커넥션 대기로 응답 시간이 밀리는지 확인 |
| 4 | `Failure Rate`가 증가하는지 | 주문 실패가 정상 흐름보다 증가했는지 확인 |
| 5 | `Order Errors`에서 4xx/5xx가 늘어나는지 | 실패가 재고 부족/클라이언트 오류인지, 서버 오류인지 구분 |
| 6 | `Checks`가 떨어지는지 | k6 코드에서 정의한 핵심 검증이 실패했는지 확인 |

`k6 ATK-A02` 대시보드의 각 패널 의미는 다음과 같습니다.

| 패널 | 주요 지표 | 의미 | 확인 포인트 |
|---|---|---|---|
| `Latency p95` | `http_req_duration_p95`, `order_latency_ms_p95`, `health_latency_during_attack_p95` | 요청 95%가 몇 ms 안에 끝났는지 보여줌 | `order p95`만 튀면 주문 경로 병목 가능성이 크고, `health p95`도 같이 튀면 서버 전체 영향 가능성이 있음 |
| `Failure Rate` | `http_req_failed_rate`, `order_failed_rate` | 전체 HTTP 실패율과 주문 실패율 | `order_failed_rate`가 높고 `http failed`도 같이 오르면 주문 API 실패가 전체 실패율을 끌어올리는 상태 |
| `Request Rate` | `rate(k6_http_reqs_total[1m])` | 초당 HTTP 요청 수 | VU를 올렸는데 요청 수가 낮으면 응답 지연, sleep, 서버 병목 때문에 처리량이 막혔을 수 있음 |
| `Virtual Users` | `k6_vus`, `k6_vus_max` | 현재 실행 중인 VU와 최대 VU | 설정한 `VUS`까지 올라갔는지, ramp-down 구간에서 정상적으로 내려오는지 확인 |
| `Order Errors` | `order_4xx_total`, `order_5xx_total` | 주문 오류 증가량 | 4xx는 재고 부족 같은 비즈니스 실패일 수 있고, 5xx는 서버 예외나 락 timeout 처리 문제일 수 있음 |
| `Checks` | `k6_checks_rate` | k6 `check()` 성공률 | `order 2xx`, `order no 5xx`, `health 200` 같은 검증이 전체적으로 얼마나 통과했는지 확인 |

ATK-A02에서는 `order_latency_ms_p95`, `order_failed_rate`, `order_5xx_total`, `health_latency_during_attack_p95`를 중심으로 봅니다.

대시보드만 보고 결론을 내리지는 않습니다. 대시보드에서 이상 징후를 확인한 뒤에는 아래 자료를 같이 봅니다.

| 추가 확인 | 봐야 하는 이유 |
|---|---|
| k6 터미널 결과 | threshold 통과 여부, 최종 p95, 실패율, check 실패 항목 확인 |
| Spring 애플리케이션 로그 | 5xx 원인, lock timeout, 예외 stack trace 확인 |
| DB 상태 | 대상 상품 재고, 주문 생성 수, 장바구니 누적 여부 확인 |
| 실행 조건 | `TARGET_PRODUCT`, `VUS`, `DURATION`, `testid`가 기록과 일치하는지 확인 |

결과를 정리할 때는 “대시보드 캡처 + k6 터미널 요약 + 서버 로그 주요 에러 + 실행 명령”을 함께 남깁니다.

## 6. 종료

```bash
cd ~/Desktop/protectMyService/tema-a/loadtests/k6/observability

docker compose down
```

저장된 Prometheus/Grafana 데이터를 같이 삭제하려면 volume까지 제거합니다.

```bash
docker compose down -v
```
