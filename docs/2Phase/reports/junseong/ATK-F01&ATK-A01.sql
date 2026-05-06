-- ATK-F01&ATK-A01: 장바구니 수량 오버플로우 -> 음수 수량 주문 생성 체인 테스트 데이터
-- k6: k6-test/atk-f01-a01.js
-- 전제: member_id=1, product_id=1을 사용한다.

TRUNCATE TABLE member RESTART IDENTITY CASCADE;

INSERT INTO member (email, name, created_at, updated_at)
VALUES ('user1@test.com', 'TestUser1', now(), now());

TRUNCATE TABLE category RESTART IDENTITY CASCADE;

INSERT INTO category (id, name, parent_id, depth, sort_order, created_at, updated_at) VALUES
    (1, '전자제품', NULL, 0, 1, now(), now()),
    (6, '스마트폰', 1, 1, 1, now(), now());

SELECT setval('category_id_seq', 6);

TRUNCATE TABLE product RESTART IDENTITY CASCADE;

INSERT INTO product (id, category_id, name, price, stock_quantity, description, image_url, status, created_at, updated_at)
VALUES (
    1,
    6,
    'Product-1',
    10000.00,
    1000000,
    'ATK-F01/A01 overflow target product',
    'https://cdn.example.com/product-1.jpg',
    'ON_SALE',
    now(),
    now()
);

SELECT setval('product_id_seq', 1);

INSERT INTO cart (member_id, created_at, updated_at)
VALUES (1, now(), now());

COMMIT;
