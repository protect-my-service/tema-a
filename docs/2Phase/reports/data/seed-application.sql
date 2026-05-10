-- =========================================================
-- 통합 더미데이터 (k6 시나리오: ATK-F01/A01/A06/B01/B02/C02)
-- =========================================================

-- 필요 시 초기화
TRUNCATE TABLE payment, order_item, orders, cart_item, cart, product, category, member, order_number_sequence RESTART IDENTITY CASCADE;

-- 1) 회원 200명
INSERT INTO member (id, email, name, created_at, updated_at)
SELECT
    g,
    'user' || g || '@test.com',
    'TestUser' || g,
    NOW(),
    NOW()
FROM generate_series(1, 200) AS g;

-- 2) 카테고리
INSERT INTO category (id, name, parent_id, depth, sort_order, created_at, updated_at) VALUES
                                                                                          (1, '전자제품', NULL, 0, 1, NOW(), NOW()),
                                                                                          (2, '의류', NULL, 0, 2, NOW(), NOW()),
                                                                                          (3, '식품', NULL, 0, 3, NOW(), NOW()),
                                                                                          (4, '도서', NULL, 0, 4, NOW(), NOW()),
                                                                                          (5, '홈/리빙', NULL, 0, 5, NOW(), NOW()),
                                                                                          (6, '스마트폰', 1, 1, 1, NOW(), NOW()),
                                                                                          (7, '노트북', 1, 1, 2, NOW(), NOW()),
                                                                                          (8, '상의', 2, 1, 1, NOW(), NOW()),
                                                                                          (9, '하의', 2, 1, 2, NOW(), NOW()),
                                                                                          (10, '간편식', 3, 1, 1, NOW(), NOW());

-- 3) 상품 100개 (테스트용 고정 상품 포함)
-- product 1: F01/A01 대상 (재고 충분)
-- product 2: A06 품절 대상
-- product 3: A06 저재고 대상
INSERT INTO product (id, category_id, name, price, stock_quantity, description, image_url, status, created_at, updated_at) VALUES
                                                                                                                               (1, 6, 'Product-F01-A01', 29900.00, 100000, 'F01/A01 target', 'https://cdn.example.com/p1.jpg', 'ON_SALE', NOW(), NOW()),
                                                                                                                               (2, 6, 'Product-A06-SOLDOUT', 19900.00, 0, 'A06 soldout target', 'https://cdn.example.com/p2.jpg', 'ON_SALE', NOW(), NOW()),
                                                                                                                               (3, 7, 'Product-A06-LOWSTOCK', 15900.00, 3, 'A06 low stock target', 'https://cdn.example.com/p3.jpg', 'ON_SALE', NOW(), NOW());

INSERT INTO product (id, category_id, name, price, stock_quantity, description, image_url, status, created_at, updated_at)
SELECT
    g,
    CASE (g % 5)
        WHEN 0 THEN 6
        WHEN 1 THEN 7
        WHEN 2 THEN 8
        WHEN 3 THEN 9
        WHEN 4 THEN 10
        END,
    'Product-' || g,
    (10000 + (g * 321) % 90000)::DECIMAL(10,2),
    (100 + (g * 37) % 1000),
    'Description for product ' || g,
    'https://cdn.example.com/product-' || g || '.jpg',
    'ON_SALE',
    NOW(),
    NOW()
FROM generate_series(4, 100) AS g;

-- 4) 회원별 장바구니
INSERT INTO cart (id, member_id, created_at, updated_at)
SELECT id, id, NOW(), NOW() FROM member;

-- 5) cart_item 구성
-- member 1: F01/A01 대상 cartItem (id=1, product=1, quantity=1)
INSERT INTO cart_item (id, cart_id, product_id, quantity, created_at, updated_at)
VALUES (1, 1, 1, 1, NOW(), NOW());

-- member 2~61: A06용 품절 상품 cartItem (id=2~61)
INSERT INTO cart_item (id, cart_id, product_id, quantity, created_at, updated_at)
SELECT
    g,
    g,
    2,
    1,
    NOW(),
    NOW()
FROM generate_series(2, 61) AS g;

-- member 62~121: A06용 저재고 상품 cartItem (id=62~121)
INSERT INTO cart_item (id, cart_id, product_id, quantity, created_at, updated_at)
SELECT
    g,
    g,
    3,
    2,
    NOW(),
    NOW()
FROM generate_series(62, 121) AS g;

-- member 122~200: 일반 상품 cartItem
INSERT INTO cart_item (id, cart_id, product_id, quantity, created_at, updated_at)
SELECT
    g,
    g,
    4 + ((g - 122) % 20),
    1 + ((g - 122) % 3),
    NOW(),
    NOW()
FROM generate_series(122, 200) AS g;

-- 6) B01/B02용 PENDING 주문 80건 (id: 1001~1080, member 1~80)
INSERT INTO orders (id, order_number, member_id, status, total_amount, ordered_at, created_at, updated_at)
SELECT
    1000 + g,
    'ORD-20260510-' || LPAD(g::text, 6, '0'),
    g,
    'PENDING',
    (15000 + (g * 91))::DECIMAL(12,2),
    NOW(),
    NOW(),
    NOW()
FROM generate_series(1, 80) AS g;

INSERT INTO order_item (id, order_id, product_id, product_name, product_price, quantity, cancelled_quantity, created_at)
SELECT
    10000 + g,
    1000 + g,
    4 + (g % 20),
    'Product-' || (4 + (g % 20)),
    (12000 + (g * 13))::DECIMAL(10,2),
    1 + (g % 2),
    0,
    NOW()
FROM generate_series(1, 80) AS g;

-- 7) C02용 PAID 주문 1건 + order_item 50개 + APPROVED 결제
INSERT INTO orders (id, order_number, member_id, status, total_amount, ordered_at, created_at, updated_at)
VALUES (3001, 'ORD-20260510-C02-000001', 1, 'PAID', 2500000.00, NOW(), NOW(), NOW());

INSERT INTO order_item (id, order_id, product_id, product_name, product_price, quantity, cancelled_quantity, created_at)
SELECT
    300100 + g,
    3001,
    4 + ((g - 1) % 40),
    'Product-' || (4 + ((g - 1) % 40)),
    (10000 + (g * 50))::DECIMAL(10,2),
    2,
    0,
    NOW()
FROM generate_series(1, 50) AS g;

INSERT INTO payment (id, order_id, payment_key, amount, cancelled_amount, status, paid_at, created_at, updated_at)
VALUES (9001, 3001, 'PAY-C02-0001', 2500000.00, 0, 'APPROVED', NOW(), NOW(), NOW());

-- 8) 시퀀스 동기화
SELECT setval('member_id_seq', (SELECT MAX(id) FROM member));
SELECT setval('category_id_seq', (SELECT MAX(id) FROM category));
SELECT setval('product_id_seq', (SELECT MAX(id) FROM product));
SELECT setval('cart_id_seq', (SELECT MAX(id) FROM cart));
SELECT setval('cart_item_id_seq', (SELECT MAX(id) FROM cart_item));
SELECT setval('orders_id_seq', (SELECT MAX(id) FROM orders));
SELECT setval('order_item_id_seq', (SELECT MAX(id) FROM order_item));
SELECT setval('payment_id_seq', (SELECT MAX(id) FROM payment));

-- =========================================================
-- k6 실행 시 바로 사용할 수 있는 환경변수 예시
-- ---------------------------------------------------------
-- F01:
--   MEMBER_ID=1 PRODUCT_ID=1
-- A01:
--   MEMBER_ID=1 CART_ITEM_ID=1
-- A06:
--   MEMBER_IDS=2,3,4,5,6,7,8,9,10
--   CART_ITEM_IDS=2,3,4,5,6,7,8,9,10,62,63,64,65,66
-- B01:
--   MEMBER_IDS=1,2,3,4,5,6,7,8,9,10
--   ORDER_IDS=1001,1002,1003,1004,1005,1006,1007,1008,1009,1010
-- B02:
--   MEMBER_ID=1 ORDER_ID=1001
-- C02:
--   MEMBER_ID=1 ORDER_ID=3001
--   CANCEL_ITEMS_JSON=[{"orderItemId":300101,"quantity":1},{"orderItemId":300102,"quantity":1}]
-- =========================================================
