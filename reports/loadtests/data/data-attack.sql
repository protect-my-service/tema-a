-- ============================================================
-- 공방전 시드 데이터 (Phase 2 · 2026-05-10)
-- 담당: 김소진 (DB 레이어)
-- 대상 시나리오: ATK-A02 / A03 / A05
-- ============================================================
-- 사전 합의 (K6 작성자에게)
--   ▸ 회원 ID 범위           : 1 ~ 1000
--   ▸ 핫 상품 ID             : 1 (HotProduct-1, P1) / 2 (HotProduct-2, P2)
--   ▸ A05용 PAID 주문 ID 범위 : 1 ~ 400
--   ▸ A05 페이로드 두 그룹    : items=[P1,P2] 와 items=[P2,P1] (반대 순서)
--   ▸ 시드 시점 기준 주문    : 10분 전 생성 / 9분 전 결제
--                              (cancel 시간 윈도우 1시간 안에 들어옴)
-- ============================================================
-- 실행 방법
--   psql -U pms -d pms_order -f data-attack.sql
--   (또는 docker exec -i <postgres> psql -U pms -d pms_order < data-attack.sql)
-- ============================================================

-- 1. 모든 테이블 초기화 (외래키 CASCADE, IDENTITY 시퀀스도 1로 리셋)
TRUNCATE payment, order_item, orders, order_number_sequence,
         cart_item, cart, product, category, member
RESTART IDENTITY CASCADE;

-- 2. 회원 1,000명
-- [A02/A03] 1,000명 분산 → 같은 상품에 동시 주문 트래픽 만들기 (RPS 100 × 3분)
-- [A05]    PAID 주문의 회원 매핑에 사용 (memberId = ((orderId-1) % 1000) + 1)
INSERT INTO member (email, name)
SELECT
    'user' || g || '@test.com',
    'TestUser' || g
FROM generate_series(1, 1000) AS g;

-- 3. 카테고리 10개
-- [공통] Product 의 NOT NULL FK (category_id) 제약 만족용. 직접 공격엔 사용 X.
INSERT INTO category (id, name, parent_id, depth, sort_order) VALUES
(1,  '전자제품', NULL, 0, 1),
(2,  '의류',    NULL, 0, 2),
(3,  '식품',    NULL, 0, 3),
(4,  '도서',    NULL, 0, 4),
(5,  '홈/리빙', NULL, 0, 5),
(6,  '스마트폰', 1,    1, 1),
(7,  '노트북',  1,    1, 2),
(8,  '상의',    2,    1, 1),
(9,  '하의',    2,    1, 2),
(10, '간편식',  3,    1, 1);
SELECT setval('category_id_seq', 10);

-- 4. 핫 상품 2개 (id 1 = P1, id 2 = P2) 본 시드의 *주인공*
--    재고 = 100,000 - 200 (PAID 주문 200쌍 × P1·P2 각 1개씩 차감) = 99,800
-- [A02]  K6 가 모든 주문을 productId=1 (P1) 으로 보냄 → 같은 row 락 경합
-- [A03]  A02 와 동일. RPS 단계 상승으로 풀 고갈까지 번지게 함
-- [A05]  P1, P2 두 상품을 *반대 순서로* cancel → wait-for cycle 데드락
INSERT INTO product (category_id, name, price, stock_quantity, description, image_url, status) VALUES
(6, 'HotProduct-1', 50000.00, 99800, '인기 상품 P1 (A02/A03/A05 시나리오용)', 'https://cdn.example.com/hot-1.jpg', 'ON_SALE'),
(6, 'HotProduct-2', 60000.00, 99800, '인기 상품 P2 (A05 페어용)',           'https://cdn.example.com/hot-2.jpg', 'ON_SALE');

-- 5. 일반 상품 48개 (id 3 ~ 50) — 비교군
-- [공통] 핫 상품 외 *정상 상품*이 있어야 시스템이 그럴듯해짐. 공격 직접 사용 X.
--    재고/가격 모두 결정론적 (RANDOM() 사용 X — 회차마다 동일 분포 보장)
INSERT INTO product (category_id, name, price, stock_quantity, description, image_url, status)
SELECT
    CASE (g % 5)
        WHEN 0 THEN 6
        WHEN 1 THEN 7
        WHEN 2 THEN 8
        WHEN 3 THEN 9
        WHEN 4 THEN 10
    END,
    'Product-' || g,
    (10000 + g * 1000)::DECIMAL(10,2),
    1000,
    'Description for product ' || g,
    'https://cdn.example.com/product-' || g || '.jpg',
    'ON_SALE'
FROM generate_series(3, 50) AS g;

-- 6. 회원별 빈 카트 1,000개
-- [A02/A03] K6 가 createOrder 호출 전에 cart 에 핫 상품을 add → cartItemId 생성 → 주문 생성 흐름.
--             빈 카트가 미리 있어야 cart/items API 가 작동.
-- [A05]    cancelOrder 만 호출하므로 카트 직접 사용 X. 단, cart 자체는 회원 생성 시 1:1 필요.
INSERT INTO cart (member_id)
SELECT id FROM member;

-- 7. PAID 주문 400건 (= A05 페어 200쌍 × 2)
-- [A05] 데드락 발현의 핵심. 같은 두 상품(P1, P2)을 가진 PAID 주문이 *미리 있어야* cancelOrder 호출 가능
-- [A02/A03] 직접 사용 X (createOrder 만 호출하므로). 단, 데이터 존재해도 무해.
--    회원 ID 1~1000 순환 (회원당 평균 0.4건 보유)
--    order_number 'ORD-A05-XXXXXX' → 다음 단계에서 join 키로 사용
--    ordered_at = NOW() - 10분 (취소 시간 윈도우 1시간 안)
INSERT INTO orders (order_number, member_id, status, total_amount, ordered_at)
SELECT
    'ORD-A05-' || LPAD(g::text, 6, '0'),
    ((g - 1) % 1000) + 1,
    'PAID',
    110000.00,                          -- P1 50000 + P2 60000
    NOW() - INTERVAL '10 minutes'
FROM generate_series(1, 400) AS g;

-- 8. OrderItem 800개 (각 PAID 주문에 P1 + P2)
-- [A05] K6 가 cancel 호출 시 items=[P1,P2] / [P2,P1] 두 그룹으로 보내려면 *각 주문에 두 OrderItem 필수*
--           orderItemId 규칙: 주문 N의 P1 = N, P2 = N+400 (UNION ALL INSERT 순서)
--           → K6 코드에서 이 규칙 그대로 사용
--    가격은 주문 시점 스냅샷 (Product.price 와 동일)
INSERT INTO order_item (order_id, product_id, product_name, product_price, quantity)
SELECT o.id, 1, 'HotProduct-1', 50000.00, 1
FROM orders o
WHERE o.order_number LIKE 'ORD-A05-%'
UNION ALL
SELECT o.id, 2, 'HotProduct-2', 60000.00, 1
FROM orders o
WHERE o.order_number LIKE 'ORD-A05-%';

-- 9. Payment 400건 (APPROVED 상태)
-- [A05] cancelOrder 코드는 PAID/PARTIALLY_CANCELLED 상태에서만 Payment 조회를 함.
--           Payment 가 없으면 환불 분기 자체가 안 가서 데드락 시나리오 깊이가 줄어듦.
--    payment_key 'PAY-A05-XXXXXX' 패턴 (UNIQUE 제약 만족용)
--    paid_at = ordered_at + 1분
INSERT INTO payment (order_id, payment_key, amount, status, paid_at)
SELECT
    o.id,
    'PAY-A05-' || LPAD(o.id::text, 6, '0'),
    110000.00,
    'APPROVED',
    NOW() - INTERVAL '9 minutes'
FROM orders o
WHERE o.order_number LIKE 'ORD-A05-%';

-- ============================================================
-- 검증 쿼리 (실행 후 직접 돌려서 시드 결과 확인)
-- ============================================================
-- SELECT COUNT(*) FROM member;                                  -- 1000
-- SELECT COUNT(*) FROM product;                                  -- 50
-- SELECT id, name, stock_quantity FROM product WHERE id IN (1,2);  -- 99800 × 2
-- SELECT COUNT(*) FROM orders WHERE status='PAID';               -- 400
-- SELECT COUNT(*) FROM order_item;                                -- 800
-- SELECT COUNT(*) FROM payment WHERE status='APPROVED';          -- 400
-- ============================================================
