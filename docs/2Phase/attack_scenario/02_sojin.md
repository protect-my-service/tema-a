# 공격 시나리오 — Protect My Service

> **작성 기준일**: 2026-05-03
> **대상 프로젝트**: pms-order / pms-order-bteam / pms-coupon / pms-queue
> **ID 체계**: `ATK-{프로젝트}-{기능}{순번}` — `O`=order, `C`=coupon, `Q`=queue.
> **근거 표기**: 라인 번호 대신 **클래스/메서드/심볼명**. IDE 점프 또는 grep으로 추적.

## 공통 인프라 전제

| 프로젝트 | 핵심 설정 | 출처 |
| --- | --- | --- |
| pms-order | HikariCP `maximum-pool-size: 10`, `lock.timeout: 3000`, `spring.data.web.pageable.max-page-size` **미설정** | `pms-order/src/main/resources/application.yml` |
| pms-order | RabbitMQ exchange = `order.exchange`, listener `acknowledge-mode: auto` | 동일 파일 + `RabbitMQConfig` |
| pms-coupon | Redis 단일 인스턴스 (`localhost:6379`), Outbox 부재 | `pms-coupon/src/main/resources/application.yml` |
| pms-queue | Redis Stream `events`, Consumer `consumer-1` 하드코딩 | `RedisEventConsumer.CONSUMER_NAME` |

---

## 1. pms-order

### [기능 A] 주문 생성 — 신규 표면

| ID         | 시나리오명          | 키워드                  | 목표 가설                                                                                         | 가설 근거(코드)                                                                                                                                      | 트래픽/패턴                              | 예상 문제점                          | 기술적 근거                                                                                                          | 설계자 | 엔드포인트                 |
| ---------- | -------------- | -------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------- | --- | --------------------- |
| ATK-O-A04  | OrderNumberSequence Hot row | `리소스소진` `숨겨진락` | createOrder 안에서 호출되는 주문번호 생성이 **단일 시퀀스 테이블 INSERT**라 모든 주문이 그 row에서 또 한 번 직렬화 → 상품 락과 별개의 병목 | `OrderService.generateOrderNumber()` 가 `orderNumberSequenceRepository.save(new OrderNumberSequence())` 호출 (`@GeneratedValue(IDENTITY)` 사용 단일 row 테이블), 이 호출이 `@Transactional createOrder()` 안에 포함됨 | 1,000 VU, 서로 다른 상품에 동시 주문<br>Stepped, 10분 | 상품 락이 분산돼 있어도 주문 생성 자체가 직렬화됨 | 단일 시퀀스 row의 INSERT lock contention. createOrder 트랜잭션 길이 = 시퀀스 INSERT + 카트 락 N개 + refresh + deleteAll → 모두 한 트랜잭션 | (TBD) | `POST /api/v1/orders` |
| ATK-O-A05  | Cart 수량 누적 오버플로 | `경계값` `int오버플로`     | `AddCartItemRequest`에 `@Max` 없음 → 같은 상품 반복 addItem으로 `CartItem.quantity` (int) 누적 → 음수로 wrap-around → `deductStock` 검증 우회 → 재고 증가/비정상 주문 가능 | `AddCartItemRequest.quantity` 가 `@Min(1)` 만 있고 `@Max` 없음. `Product.deductStock(int)` 가 `stockQuantity < quantity` 만 검증 (음수 차감 방어 없음). Cart 정책상 같은 상품은 수량 합산 | 동일 회원 × 동일 상품 addItem 반복 (수량 ≈ Integer.MAX_VALUE/2 × 2회) | 재고 정합성 파괴 / 무료 주문 가능 | Java int 오버플로 → 음수 quantity → `deductStock(-N)` → `stockQuantity -= (-N)` 즉 재고 증가. BigDecimal 가격 계산도 오작동 | (TBD) | `POST /api/v1/cart/items` → `POST /api/v1/orders` |

### [기능 E] 인증 / 정찰 — 신규 표면

| ID         | 시나리오명               | 키워드                | 목표 가설                                                                                | 가설 근거(코드)                                                                                                              | 트래픽/패턴                              | 예상 문제점               | 기술적 근거                                       | 설계자 | 엔드포인트 |
| ---------- | ------------------- | ------------------ | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | -------------------- | -------------------------------------------- | --- | ---- |
| ATK-O-E02  | 인증 없는 카탈로그 정찰    | `정찰` `RateLimit부재` | `ProductController` / `CategoryController` GET 엔드포인트가 `X-Member-Id` 요구 안 함 → 익명 자동화 크롤러로 전 상품·재고·가격·카테고리 트리 수집 + 기준점 측정 가능 | `ProductController.getProducts(...)` / `getProduct(productId)`, `CategoryController.getCategories()` 모두 `@RequestHeader` 없음. Rate Limit 어노테이션도 없음 | 익명 100 RPS × 24h, 무한 페이징 | 데이터 외부 유출 + 가격/재고 변화 추적 + 후속 공격 페이로드 설계 | 인증·인가 자체가 없음. Spring Security 미적용. `@PageableDefault(size=20)` 디폴트만 있고 max 미설정 → 큰 size 가능 | (TBD) | `GET /api/v1/products`, `GET /api/v1/products/{id}`, `GET /api/v1/categories` |

### [기능 F] 이벤트 / 조회 인프라 — 신규 표면

| ID         | 시나리오명                          | 키워드                  | 목표 가설                                                                                                                | 가설 근거(코드)                                                                                                                                                                          | 트래픽/패턴                                  | 예상 문제점                              | 기술적 근거                                                                                                  | 설계자 | 엔드포인트                          |
| ---------- | ------------------------------ | -------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------- | --- | ------------------------------ |
| ATK-O-F01  | Outbox 부재 → 도메인 이벤트 영구 유실 | `정합성` `이벤트유실` `Outbox`  | DB COMMIT 후 RabbitMQ 발행 사이 윈도우에서 브로커 단절 시 `OrderCreatedEvent`/`OrderPaidEvent`/`OrderCancelledEvent` 영구 유실 → 다운스트림(배송·정산·통계) 정합성 깨짐 | `OrderEventListener` 가 `@TransactionalEventListener(phase = AFTER_COMMIT)`, 내부에서 호출하는 `RabbitMQEventPublisher.publishOrderCreated/Paid/Cancelled` 모두 `try { ... } catch (Exception e) { log.error(...) }` 로 예외 삼킴. Outbox 테이블/재시도 큐 없음 | toxiproxy로 RabbitMQ 1~5분 단절 + 100 VU 주문/결제/취소 | 주문은 PAID인데 배송 시스템은 모름 → 환불·CS 폭증 | DB 정합성과 외부 시스템 정합성이 분리됨. AFTER_COMMIT은 DB 롤백 방지엔 옳지만 발행 실패 보상이 없음. Outbox + worker 재발행으로 해결해야 함 | (TBD) | `POST /api/v1/orders` 등 이벤트 발생 모든 엔드포인트 |
| ATK-O-F02  | Pageable size 무제한 → 단발 OOM   | `메모리폭파` `대량조회`     | `@PageableDefault(size=20)`은 디폴트일 뿐 → 클라이언트가 `?size=999999` 보내면 그대로 적용 → 한 번에 99만 건 조회 → JVM heap + 응답 직렬화 폭증 → OOM/GC pause | `OrderController.getOrders(memberId, @PageableDefault(size=20) Pageable pageable)` + `application.yml` 에 `spring.data.web.pageable.max-page-size` **미설정** + `OrderService.getOrders` 가 `Page<>` 그대로 반환 (스트림 페이징 안 함) | 익명/인증 클라이언트 단일 GET `?size=999999`         | OOM / GC pause / 동일 풀 점유로 신규 요청 차단 | Spring Data 의 max-page-size 글로벌 캡 미설정. Service 단 size 검증 없음. Pageable JPQL이 LIMIT 999999 그대로 발행 | (TBD) | `GET /api/v1/orders?size=999999` |

---

## 2. pms-coupon

### [기능 A] 쿠폰 발급 — 신규 표면

| ID         | 시나리오명                       | 키워드                | 목표 가설                                                                                                  | 가설 근거(코드)                                                                                                            | 트래픽/패턴                                | 예상 문제점                          | 기술적 근거                                                                                  | 설계자 | 엔드포인트                       |
| ---------- | --------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------- | --- | --------------------------- |
| ATK-C-A04  | ALREADY_DONE 응답 차이로 발급 정찰   | `정찰` `타이밍공격`      | 다른 사용자의 memberId로 발급 호출 시 **응답 차이**로 그 사용자가 이미 발급받았는지 노출 — `ALREADY_DONE`(즉시 멱등 응답) vs `ACQUIRED`(긴 처리 후 응답) | `CouponIssueService.issue()` 의 `MemberRequestAcquireResult` 분기 — `ALREADY_DONE` 시 `getExistingIssueResponse()` 즉시 반환, `ACQUIRED`는 INCR/DB락/INSERT 까지 진행 후 응답 | victim memberId 범위(예: 1~10000)에 1건씩 발급 시도 + 응답 시간/내용 측정 | 사용자별 발급 여부 정찰 → 마케팅 데이터 외부 유출 | 인증 부재(`X-Member-Id` 헤더만) + 응답 코드/시간 차이가 멱등 분기 진입 여부를 그대로 노출. 상수 시간 응답 보장 안 됨        | (TBD) | `POST /coupons/{id}/issue`  |

### [기능 B] Redis-DB 정합성 — 신규 표면

| ID         | 시나리오명                              | 키워드                | 목표 가설                                                                                                            | 가설 근거(코드)                                                                                                                | 트래픽/패턴                              | 예상 문제점                              | 기술적 근거                                                                                                          | 설계자 | 엔드포인트                       |
| ---------- | ---------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------- | --- | --------------------------- |
| ATK-C-B04  | markDone TTL 갱신으로 DONE 키 영구화 → 메모리 누수 | `메모리누수` `TTL갱신`   | `markMemberRequestDone` 이 `set`(NX 아님)이라 호출할 때마다 TTL이 새로 갱신됨 → 같은 회원이 멱등 발급(이미 DONE)을 반복하면 DONE 키가 쿠폰 종료 후에도 영구 유지 → Redis 메모리 누수 | `CouponIssueRedisService.markMemberRequestDone()` 내부 `redisTemplate.opsForValue().set(key, "DONE", ttl)` (NX 없음) → `CouponIssueService.issue()` 의 `ALREADY_ISSUED` catch 분기에서도 호출됨 | 발급 완료된 회원이 매분 발급 호출 반복 (멱등 응답 받지만 호출 자체로 TTL 연장) | Redis 메모리 무한 증가 / 운영자가 인지 못함        | TTL은 매 호출마다 절대값으로 셋 → 만료 직전에 호출하면 만료 카운트다운 리셋. 쿠폰 종료(이벤트 끝) 후에도 키가 살아남음. 정상 운영 가정상 종료 후 키는 만료되어야 하는데 로직상 그렇지 않음 | (TBD) | `POST /coupons/{id}/issue`  |

---

## 3. pms-queue

### [기능 A] Consumer 초기화 — 신규 표면

| ID         | 시나리오명                       | 키워드                | 목표 가설                                                                                                                | 가설 근거(코드)                                                                                              | 트래픽/패턴                              | 예상 문제점                              | 기술적 근거                                                                                          | 설계자 | 엔드포인트       |
| ---------- | --------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------- | --- | ----------- |
| ATK-Q-A04  | createGroup 외 예외까지 삼킴 → 좀비 Consumer | `장애은닉` `silent fail` | `RedisEventConsumer.start()` 의 `try { createGroup } catch (Exception)` 가 BUSYGROUP(이미 그룹 존재) 외의 예외(인증 실패/네트워크 단절/Redis 장애)도 다 무시 → 컨슈머는 시작은 됐지만 그룹 등록은 실패 → XADD는 성공하는데 메시지가 처리되지 않는 좀비 상태 | `RedisEventConsumer.start()` 안 `try { redisTemplate.opsForStream().createGroup(STREAM_KEY, GROUP_NAME); } catch (Exception e) { /* 무시 */ }` (catch 본문 비어 있음). 이후 `listenerContainer.receive(...)` + `start()` 는 정상 호출되어 외부에선 정상으로 보임 | Redis 일시 장애 후 컨슈머 부팅 (또는 Redis ACL 변경 후 재시작) | 메시지 생산은 되는데 소비 안 됨 → Stream 무한 적재 + ATK-Q-A01 OOM 가속 | catch가 `BUSYGROUP` 외 예외 종류를 구분 안 함. 헬스체크가 `listenerContainer.isRunning()` 만 보면 컨슈머는 "정상"으로 보고 → 실제 처리는 0건 | (TBD) | (Consumer 부팅 시점) |
