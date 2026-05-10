-- 회원 100명 생성
TRUNCATE TABLE member RESTART IDENTITY CASCADE;

INSERT INTO member (email, name, created_at, updated_at)
SELECT
    'user' || g || '@test.com',
    'TestUser' || g,
    now(),
    now()
FROM generate_series(1, 100) AS g;

-- 카테고리 생성
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

-- 시퀀스 동기화
SELECT setval('category_id_seq', 10);

-- 상품 50개 생성 (하위 카테고리별 분산)
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
    (RANDOM() * 900 + 100)::INT,
    'Description for product ' || g,
    'https://cdn.example.com/product-' || g || '.jpg',
    'ON_SALE',
    now(),
    now()
FROM generate_series(1, 50) AS g;

-- 회원별 장바구니 생성
TRUNCATE TABLE cart RESTART IDENTITY CASCADE;
INSERT INTO cart (member_id, created_at, updated_at)
SELECT id, created_at, updated_at FROM member;
