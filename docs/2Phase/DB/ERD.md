# 주문 시스템 ERD

## 1. ERD

```mermaid
erDiagram
    Member ||--|| Cart: "1:1"
    Member ||--o{ Order: "1:N"
    Cart ||--o{ CartItem: "1:N"
    Product ||--o{ CartItem: "1:N"
    Category ||--o{ Product: "1:N"
    Category ||--o{ Category: "자기참조"
    Order ||--o{ OrderItem: "1:N"
    Product ||--o{ OrderItem: "1:N"
    Order ||--|| Payment: "1:1 unique"

    Member {
        id bigint PK
        email varchar UK
        name varchar "length 100"
        created_at timestamp 
        updated_at timestamp
    }

    Category {
        id bigint PK
        name varchar "length 100"
        parent_id bigint FK "부모 카테고리 id(자기참조), nullable"
        depth int "깊이"
        sort_order int "정렬 순서"
        created_at timestamp
        updated_at timestamp
    }

    Product {
        id bigint PK
        category_id bigint FK
        name varchar
        price decimal "전체자리 10, 소수점자리 2 | ex. 99,999,999.99"
        stock_quantity int "재고 수량"
        description text
        image_url varchar "length 500"
        status varchar "ON_SALE, SOLD_OUT, HIDDEN"
        created_at timestamp
        updated_at timestamp
    }

    Cart {
        id bigint PK
        member_id bigint FK "unique"
        created_at timestamp
        updated_at timestamp
    }

    CartItem {
        id bigint PK
        cart_id bigint FK "cart_id + product_id 복합 unique"
        product_id bigint FK "cart_id + product_id 복합 unique"
        quantity int
        created_at timestamp
        updated_at timestamp
    }

    Order {
        id bigint PK
        order_number varchar UK "length 50, OrderNumberSequence 사용"
        member_id bigint FK
        status varchar "OrderStatus enum 10단계"
        total_amount decimal "전체자리 12, 소수점 자리 2 | ex. 9,999,999,999.99"
        ordered_at timestamp "주문 시점"
        created_at timestamp
        updated_at timestamp
    }

    OrderItem {
        id bigint PK
        order_id bigint FK
        product_id bigint FK
        product_name varchar "물품명 스냅샷"
        product_price decimal "물품 단가 스냅샷 / 전체자리 10, 소수점 자리 2 | ex. 99,999,999.99"
        quantity int "수량"
        cancelled_quantity int "부분취소 누적 수량"
        created_at timestamp
    }

    Payment {
        id bigint PK
        order_id bigint FK,UK
        payment_key varchar UK "외부 PG 결제 식별 키 / length 100"
        amount decimal "총 금액 / 전체자리 12, 소수점자리 2 | ex. 9,999,999,999.99"
        cancelled_amount decimal "총 취소 금액 / 전체자리 12, 소수점자리 2 | ex. 9,999,999,999.99"
        status varchar "PaymentStatus enum 4단계"
        paid_at timestamp "지불 시간"
        created_at timestamp
        updated_at timestamp
    }

    OrderNumberSequence {
        id bigint PK "주문번호 채번 전용"
    }
```

---

## 2. 엔티티별 참고 사항

### Member (회원)
- `email` unique 제약
- `name` 길이 100자 제한

### Category (카테고리)
- 자기참조 구조 (`parent_id`)
- `depth`, `sort_order`로 계층 트리 표현
```shell
  category 테이블
  ┌────┬────────┬───────────┐
  │ id │ name   │ parent_id │
  ├────┼────────┼───────────┤
  │ 1  │ 전자제품 │ NULL      │ ← 최상위
  │ 6  │ 스마트폰 │ 1         │ ← 부모는 id=1 (전자제품)
  │ 7  │ 노트북  │ 1         │ ← 부모는 id=1 (전자제품)
  └────┴────────┴───────────┘
```
- 비즈니스 로직
    - 부모 → 자식 LAZY 로딩
    - 정렬기준: `@OrderBy("sortOrder ASC")`

### Product (상품)
- 비즈니스 로직
    - `findByIdWithLock` 으로 락 획득
    - `deductStock()`, `restoreStock()` 메서드로 재고 변경
    - 상태(`status`): `ProductStatus` enum (예: `ON_SALE`)

### Cart (장바구니)
- 비즈니스 로직
    - `cascade = ALL`, `orphanRemoval = true` → 회원 삭제 시 같이 삭제

### CartItem (장바구니상품)
- `(cart_id, product_id)` 복합 unique 제약 → 같은 상품 중복 담기 불가
- 수량만 증가 (`addQuantity`, `updateQuantity`)

### Order (주문)
- `ordered_at` 으로 주문 시점 기록
- 상태 전이: **10단계 enum**, 3개 흐름으로 분리 (아래 상태 전이도 참고)
    - **정상 배송**: PENDING → PAID → PREPARING → SHIPPING → DELIVERED → RETURNED
    - **취소**: PENDING/PAID → CANCELLED, PAID ⇄ PARTIALLY_CANCELLED
    - **환불**: PAID/PARTIALLY_CANCELLED → REFUND_REQUESTED → REFUNDED
- 비즈니스 로직
    - 취소 시 비관적 락 (`findByIdForUpdate`)
    - 상태 전이 검증 (`validateTransitionTo`) — 허용되지 않은 전이 시 `BusinessException`

### OrderItem (주문상품)
- **스냅샷 컬럼**: `product_name`, `product_price`
    - 주문 시점 가격을 그대로 저장 → 추후 상품 가격 변경 영향 없음
- `cancelled_quantity`: 부분 취소 누적 추적
- `created_at` : `BaseTimeEntity` 상속하지 않음 (`@CreatedDate` 직접 사용)
- 비즈니스 로직
    - `getActiveQuantity()` = `quantity - cancelled_quantity`

### Payment (결제)
- 상태 전이: `READY → APPROVED → CANCELLED/FAILED`
- `cancelled_amount`: 부분 취소 누적 금액
- `partialCancel()` 메서드로 부분 취소 시 누적

### OrderNumberSequence (주문번호시퀀스)
- 주문번호 채번 전용 테이블

---

## 3. 상태 전이도

### 3-1) 주문 상태 (OrderStatus)

OrderStatus enum은 총 **10단계**로 구성되며, 흐름별로 3개로 나누어 표현

#### ① 정상 배송 흐름

```mermaid
stateDiagram-v2
    [*] --> PENDING : 주문 생성
    PENDING --> PAID : 결제 성공
    PAID --> PREPARING : 배송 준비
    PREPARING --> SHIPPING : 배송 시작
    SHIPPING --> DELIVERED : 배송 완료
    DELIVERED --> RETURNED : 반품
    RETURNED --> [*]
```

#### ② 취소 흐름

```mermaid
stateDiagram-v2
    [*] --> PENDING
    PENDING --> CANCELLED : 결제 실패 / 주문 취소
    PAID --> CANCELLED : 전체 취소
    PAID --> PARTIALLY_CANCELLED : 부분 취소
    PARTIALLY_CANCELLED --> PARTIALLY_CANCELLED : 추가 부분 취소
    PARTIALLY_CANCELLED --> CANCELLED : 잔여 전체 취소
    PARTIALLY_CANCELLED --> PREPARING : 잔여분 배송 진행
    CANCELLED --> [*]
```

#### ③ 환불 흐름

```mermaid
stateDiagram-v2
    [*] --> PAID
    PAID --> REFUND_REQUESTED : 환불 요청
    PARTIALLY_CANCELLED --> REFUND_REQUESTED : 잔여분 환불 요청
    REFUND_REQUESTED --> REFUNDED : 환불 완료
    REFUNDED --> [*]
```

---

### 3-2) 결제 상태 (PaymentStatus)

```mermaid
stateDiagram-v2
    [*] --> READY : 결제 객체 생성
    READY --> APPROVED : 외부 PG 승인
    READY --> FAILED : 외부 PG 실패
    APPROVED --> CANCELLED : 결제 취소 (전액 또는 부분 누적이 전액 도달)
    CANCELLED --> [*]
    FAILED --> [*]
```

> `partialCancel()` 호출 시에는 `cancelled_amount` 만 누적되고 status는 APPROVED 유지.
> 
> 누적 취소 금액이 전체 금액(`amount`)과 같아지면 CANCELLED 로 전이.
