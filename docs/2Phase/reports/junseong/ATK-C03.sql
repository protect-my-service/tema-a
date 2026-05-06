-- ATK-C03: 취소 이벤트 발행 실패에 따른 후행 정합성 공백 테스트 데이터
-- k6: k6-test/atk-c03.js
-- order_id/member_id 4001~5000: 취소 가능한 PENDING 주문

TRUNCATE TABLE member RESTART IDENTITY CASCADE;

INSERT INTO member (email, name, created_at, updated_at)
SELECT
    'user' || g || '@test.com',
    'TestUser' || g,
    now(),
    now()
FROM generate_series(1, 5000) AS g;

TRUNCATE TABLE category RESTART IDENTITY CASCADE;

INSERT INTO category (id, name, parent_id, depth, sort_order, created_at, updated_at) VALUES
    (1, '전자제품', NULL, 0, 1, now(), now()),
    (2, '의류', NULL, 0, 2, now(), now()),
    (3, '식품', NULL, 0, 3, now(), now()),
    (4, '도서', NULL, 0, 4, now(), now()),
    (5, '홈/리빙', NULL, 0, 5, now(), now()),
    (6, '스마트폰', 1, 1, 1, now(), now()),
    (7, '노트북', 1, 1, 2, now(), now()),
    (8, '상의', 2, 1, 1, now(), now()),
    (9, '하의', 2, 1, 2, now(), now()),
    (10, '간편식', 3, 1, 1, now(), now());

SELECT setval('category_id_seq', 10);

TRUNCATE TABLE product RESTART IDENTITY CASCADE;

INSERT INTO product (category_id, name, price, stock_quantity, description, image_url, status, created_at, updated_at)
SELECT
    CASE (g % 5)
        WHEN 0 THEN 6
        WHEN 1 THEN 7
        WHEN 2 THEN 8
        WHEN 3 THEN 9
        WHEN 4 THEN 10
        END,
    'Product-' || g,
    (RANDOM() * 90000 + 10000)::DECIMAL(10,2),
    CASE
        WHEN g = 1 THEN 1000000
        ELSE (RANDOM() * 900 + 100)::INT
        END,
    'Description for product ' || g,
    'https://cdn.example.com/product-' || g || '.jpg',
    'ON_SALE',
    now(),
    now()
FROM generate_series(1, 50) AS g;

INSERT INTO cart (member_id, created_at, updated_at)
SELECT id, created_at, updated_at FROM member;

INSERT INTO orders (id, order_number, member_id, status, total_amount, ordered_at, created_at, updated_at)
SELECT
    g,
    'CANCELTEST-' || lpad(g::TEXT, 6, '0'),
    g,
    'PENDING',
    p.price,
    now(),
    now(),
    now()
FROM generate_series(4001, 5000) AS g
CROSS JOIN product p
WHERE p.id = 1;

INSERT INTO order_item (id, order_id, product_id, product_name, product_price, quantity, cancelled_quantity, created_at)
SELECT
    g,
    g,
    p.id,
    p.name,
    p.price,
    1,
    0,
    now()
FROM generate_series(4001, 5000) AS g
CROSS JOIN product p
WHERE p.id = 1;

SELECT setval('orders_id_seq', 5000);
SELECT setval('order_item_id_seq', 5000);

COMMIT;
