# 공격 시나리오 템플릿

## 키워드 표준

| 키워드 | 사용 의미 | 사용 예시 | 비고 |
| ------- | ------- | ------- | ------- |
| `락경합` | 동일 자원에 대한 동시 락 경쟁 | 동일 상품 집중 주문/취소 | 기본 동시성 이슈 태그 |
| `데드락` | 락 획득 순서 역전 등으로 인한 순환 대기 | 상품 순서 교차 주문/취소 | DB deadlock 의심 시 우선 사용 |
| `락순서` | 자원 락 획득 순서 자체가 공격 표면인 경우 | 입력 순서 기반 상품 락 획득 | `데드락`과 함께 자주 사용 |
| `긴트랜잭션` | 트랜잭션 점유 시간이 길어지는 경우 | 다건 주문/다건 취소 | 락 보유 시간 증가 시 사용 |
| `다중락` | 한 요청이 여러 행/자원을 순차적으로 잠그는 경우 | 다상품 카트 주문 | `긴트랜잭션`과 병행 가능 |
| `리소스소진` | 커넥션 풀, 스레드, 큐 등 자원 고갈 | 커넥션 풀 고갈 | 후행 장애 전파 태그 |
| `커넥션풀` | DB 커넥션 풀 고갈 또는 획득 대기 | HikariCP 고갈 | `리소스소진`과 병행 사용 |
| `핫로우` | 특정 행/상품에 트래픽이 집중되는 경우 | 동일 `productId` 반복 타격 | 영문 `Hot row` 대신 사용 |
| `실패폭주` | 실패 요청이 대량 발생하며 자원을 계속 소모하는 경우 | 재고 부족 주문 폭주 | 실패 자체가 부하 원인일 때 사용 |
| `재시도폭증` | 재시도로 동일 충돌이 증폭되는 경우 | deadlock 후 자동 재시도 | 클라이언트/상위 계층 재시도 포함 |
| `정합성` | 상태 변경과 후행 처리 간 불일치 가능성 | 주문 취소 성공 후 이벤트 누락 | 데이터/이벤트 불일치 태그 |
| `메시지유실` | 메시지 발행 실패, 미전달, 누락 가능성 | RabbitMQ publish 실패 | `정합성`과 병행 사용 |
| `비동기연계` | 외부 MQ/이벤트 기반 후행 처리 리스크 | consumer 부재, 큐 적체 | 단순 비동기 여부보다 연계 리스크 중심 |
| `운영리스크` | 관측, 복구, 운영 대응이 어려운 장애 양상 | consumer 부재, 로그만 남기는 실패 | 운영 가시성 이슈 태그 |

키워드는 위 항목을 참고하여 작성하였음.

<br>


#### [기능 A] 주문 생성

| ID | 시나리오명 | 키워드 | 목표 가설 | 가설 근거(코드) | 트래픽/패턴 | 예상 문제점 | 기술적 근거 | 설계자 | 엔드포인트 |
| ------- | ------- | ------- | ------- | ------- | ------- | ------- | ------- | ------- | ------- |
| ATK-A01 | 동일 상품 집중 주문 락 경합 | `락경합` `핫로우` | 동일 상품에 주문이 집중되면 `PESSIMISTIC_WRITE` 락 대기로 요청이 직렬화되고 일부 요청이 lock timeout으로 실패할 수 있다 | `OrderService.createOrder()`에서 `productRepository.findByIdWithLock()` 반복 호출, `jakarta.persistence.lock.timeout: 3000` | 동일 `productId` 대상 Spike | 응답 지연 증가 / 일부 주문 실패 | 상품 행 `SELECT ... FOR UPDATE` 경합으로 후행 트랜잭션 대기, 3초 초과 시 lock timeout 가능 | 김소라 | `POST /api/v1/orders` |
| ATK-A02 | 락 대기 누적으로 인한 커넥션 풀 고갈 | `리소스소진` `커넥션풀` | 락 대기가 길어지면 대기 중 요청이 DB 커넥션을 점유해 HikariCP 풀 고갈로 확산될 수 있다 | `createOrder()` 전체 `@Transactional`, Hikari `maximum-pool-size: 10`, `connection-timeout: 30000` | 동일 상품 대상 10개 초과 동시 요청, Stepped | 신규 요청 장기 대기 / connection timeout / 실패율 증가 | 락 대기 중 커넥션 반환 불가로 풀 고갈, 후속 요청은 커넥션 획득 단계에서 실패 | 김소라 | `POST /api/v1/orders` |
| ATK-A03 | 다상품 카트 주문 시 다중 락 누적 | `다중락` `긴트랜잭션` | 카트 상품 수가 많을수록 한 요청이 여러 상품 락을 순차 획득해 임계구역이 길어지고 처리량이 저하될 수 있다 | `for (CartItem cartItem : cartItems)` 내부 `findByIdWithLock()`, `entityManager.refresh(product)`, `cartItemRepository.deleteAll(cartItems)` | 카트당 item 수 1/10/30 단계 증가, Constant | 평균/상위 응답시간 증가 / 처리량 저하 | 한 트랜잭션에서 N개 상품 락 + 추가 DB 작업 수행으로 락 보유 시간 증가 | 김소라 | `POST /api/v1/orders` |
| ATK-A04 | 상품 락 획득 순서 교차로 인한 데드락 가능성 | `데드락` `락순서` | 같은 상품 집합을 서로 다른 순서로 처리하는 주문이 동시 유입될 때 특정 조건에서 교차 락 획득으로 데드락이 발생할 수 있다 | `createOrder()`가 cart item 순서대로 `findByIdWithLock()` 수행, 락 정렬 로직 없음 | 서로 다른 회원의 카트에 동일 상품 집합을 역순으로 구성한 뒤 동시 실행 | 데드락 발생 가능 / 트랜잭션 롤백 / 실패 응답 증가 | 두 트랜잭션이 상대가 보유한 다음 락을 기다리는 순환 대기 조건이 충족되면 데드락 가능 | 김소라 | `POST /api/v1/orders` |
| ATK-A05 | 재고 부족 상황의 실패 요청 폭주 | `실패폭주` `리소스소진` | 재고보다 많은 주문이 몰리면 실패 요청도 락 획득과 선행 로직을 수행해 자원 소모를 유발할 수 있다 | `createOrder()`에서 주문 생성 후 상품 락 획득 및 `deductStock()`, 재고 부족 시 예외 발생 | 재고 5개 상품에 50~100개 동시 주문 | 실패율 급증 / 불필요한 DB 작업 증가 | 실패 요청도 락 경쟁에 참여하고 트랜잭션 수행 후 예외 발생 | 김소라 | `POST /api/v1/orders` |

---

#### [기능 B] 주문 취소

| ID | 시나리오명 | 키워드 | 목표 가설 | 가설 근거(코드) | 트래픽/패턴 | 예상 문제점 | 기술적 근거 | 엔드포인트 | 설계자 |
| ------- | ------- | ------- | ------- | ------- | ------- | ------- | ------- | ------- | ------- |
| ATK-B01 | 취소 대상 상품 순서 교차로 인한 데드락 유도 | `데드락` `락순서` | 서로 다른 주문 2개가 같은 상품 집합을 반대 순서로 부분 취소하면 상품 락 획득 순서 역전으로 데드락이 발생할 수 있다 | `cancelOrder()`에서 주문 락 후 `targets` 입력 순서대로 `productRepository.findByIdWithLock()` 호출, 정렬 로직 없음 | 서로 다른 `orderId` 쌍(A/B)을 고정하고 A:`[P1,P2]`, B:`[P2,P1]`로 동시 시작하는 Spike | 데드락 / 트랜잭션 롤백 / 일부 취소 실패 | 주문 락을 각각 보유한 두 트랜잭션이 다음 상품 락에서 순환 대기 형성 가능 | `POST /api/v1/orders/{orderId}/cancel` | 김소라 |
| ATK-B02 | 다수 취소 항목에 따른 장기 트랜잭션 및 lock wait 증가 | `긴트랜잭션` `락경합` | 취소 요청당 상품 수가 많을수록 락 획득 구간이 길어져 lock wait과 지연이 급증할 수 있다 | `cancelOrder()` `@Transactional`, `for (TargetItem t : targets)`에서 상품별 락 획득/재고 복구, `max-items-per-request: 50` | 요청당 item 수 2/10/30 단계 증가, Constant/Stepped | 평균/상위 응답시간 증가 / 처리량 저하 | 주문 락 + 복수 상품 락 장기 보유로 후속 요청 직렬화 | `POST /api/v1/orders/{orderId}/cancel` | 김소라 |
| ATK-B03 | 취소 경합 누적으로 인한 커넥션 풀 고갈 및 타 API 전파 | `리소스소진` `커넥션풀` | 취소 요청이 락 대기 상태로 장시간 머무르면 DB 커넥션 반환 지연으로 타 API까지 장애가 전파될 수 있다 | `cancelOrder()` 트랜잭션 내 주문/상품 락 획득, Hikari `maximum-pool-size: 10`, `connection-timeout: 30000` | 동일 상품 경합 유도 취소 + 조회/주문 API 혼합 Stepped | 신규 요청 장기 대기 / timeout / 취소 외 API 지연 | 락 대기 트랜잭션의 커넥션 점유로 전체 요청 큐잉 증가 | `POST /api/v1/orders/{orderId}/cancel` | 김소라 |
| ATK-B04 | 부분 취소 재시도 폭증에 따른 장애 장기화 | `재시도폭증` `리소스소진` | 데드락/lock timeout 직후 동일 요청을 짧은 간격으로 재시도하면 락 경합이 증폭되어 장애가 장기화될 수 있다 | `cancelOrder()`는 락 예외를 별도 완화하지 않으며 동일 주문/상품 조합 재요청 가능 | 충돌 유발 요청 + 짧은 간격 재시도 결합 Spike | 실패율 증가 / 대기열 적체 / 풀 고갈 가속 | 충돌 해소 전 재유입으로 대기열이 확대되어 timeout/deadlock 빈도 상승 | `POST /api/v1/orders/{orderId}/cancel` | 김소라 |
| ATK-B05 | 취소 완료 후 이벤트 발행 실패에 따른 후행 정합성 공백 | `메시지유실` `정합성` | 주문 취소/재고 복구는 성공했지만 커밋 후 RabbitMQ 발행이 실패하면 외부 시스템은 취소 사실을 받지 못할 수 있다 | `cancelOrder()`에서 이벤트 발행, `OrderEventListener`는 `AFTER_COMMIT`, `RabbitMQEventPublisher.publishOrderCancelled()`는 예외 로그 처리 | RabbitMQ unavailable 상태에서 취소 요청 실행 | 취소 성공 / 외부 보상·알림 누락 / 운영 가시성 공백 | DB 커밋 후 발행 실패는 롤백 불가, outbox 없는 유실 창 존재 | `POST /api/v1/orders/{orderId}/cancel` | 김소라 |

---

#### [기능 C] 결제 요청

| ID | 시나리오명 | 키워드 | 목표 가설 | 가설 근거(코드) | 트래픽/패턴 | 예상 문제점 | 기술적 근거 | 엔드포인트 | 설계자 |
| ------- | ------- | ------- | ------- | ------- | ------- | ------- | ------- | ------- | ------- |
| ATK-C01 | 동일 주문 동시 결제 Race Condition | `정합성` `운영리스크` | 동일 orderId 결제 요청이 동시에 들어오면 중복 체크와 저장 사이 경쟁으로 결제 상태 충돌 또는 DB 유니크 충돌이 발생할 수 있다 | `PaymentService.requestPayment()`의 `findByOrderIdAndStatusNot()`는 락 없는 조회, 이후 `paymentRepository.save()` 수행 | 동일 orderId에 동시 2~10요청 × 100~500세트, Spike | 409/500 혼재 / 중복 결제 시도 충돌 / 상태 불안정 | `payment.order_id` UNIQUE 제약과 조회-저장 시간차가 결합되어 race 창이 생기며, DB 예외는 일반 예외로 처리될 수 있음 | `POST /api/v1/payments` | 김소라 |
| ATK-C02 | PG 지연 누적에 따른 커넥션 풀 고갈 | `리소스소진` `커넥션풀` | 외부 PG 호출 지연(300~500ms, 일부 3~5s)이 트랜잭션 내 커넥션 점유 시간을 늘려 HikariCP 풀 고갈을 유발할 수 있다 | `requestPayment()` 전체 `@Transactional` 상태에서 `externalPaymentClient.requestPayment()` 호출, Hikari `maximum-pool-size: 10` | 10→30→60→100 VU Stepped, 10분 | 결제 지연 급증 / connection timeout / 타 API 응답 전파 지연 | 외부 호출 대기 동안 트랜잭션이 커넥션을 반환하지 못해 pending이 누적됨 | `POST /api/v1/payments` | 김소라 |
| ATK-C03 | 결제 실패 분기 성능 저하(재고복구 락 경합) | `다중락` `실패폭주` | 결제 실패가 다발하면 실패 분기에서 주문 아이템 단위 재고복구 락 획득이 중첩되어 lock wait과 응답 지연이 증가할 수 있다 | `catch (BusinessException)` 분기에서 `order.getItems()` 루프마다 `productRepository.findByIdWithLock()` 후 `restoreStock()` 수행 | fault injection 또는 stub failure mode로 실패율 고정 유도 + 중간 VU Constant 10분 | 실패율 상승 / lock wait 증가 / 응답시간 우상향 | 실패 요청도 상품 락 획득과 DB 갱신을 수행하므로 실패 트래픽 자체가 부하를 증폭시킴 | `POST /api/v1/payments` | 김소라 |
| ATK-C04 | 결제 실패 분기 정합성 리스크(원자성/이벤트) | `정합성` `메시지유실` | 결제 실패 분기에서 재고복구/실패결제저장/주문취소를 수행한 뒤 예외를 다시 던질 때 트랜잭션 경계에 따라 상태 반영과 이벤트 발행이 어긋날 수 있다 | `requestPayment()` 실패 분기에서 상태 변경 수행 후 `throw e`, 이벤트는 `@TransactionalEventListener(AFTER_COMMIT)` 경유 발행 | 실패율 유도 상태에서 반복 결제 요청, Constant | 주문/결제/재고 상태 불일치 가능성 / 취소 이벤트 누락 가능성 | 실패 처리 로직과 예외 재던짐이 동일 트랜잭션에 존재하고, 커밋 실패 시 AFTER_COMMIT 이벤트는 발행되지 않음 | `POST /api/v1/payments` | 김소라 |
