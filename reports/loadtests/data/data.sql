-- 회원 100명 생성
INSERT INTO member (email, name)
SELECT
    'user' || g || '@test.com',
    'TestUser' || g
FROM generate_series(1, 100) AS g;

-- 카테고리 생성
INSERT INTO category (id, name, parent_id, depth, sort_order) VALUES
(1, '전자제품', NULL, 0, 1),
(2, '의류', NULL, 0, 2),
(3, '식품', NULL, 0, 3),
(4, '도서', NULL, 0, 4),
(5, '홈/리빙', NULL, 0, 5),
(6, '스마트폰', 1, 1, 1),
(7, '노트북', 1, 1, 2),
(8, '상의', 2, 1, 1),
(9, '하의', 2, 1, 2),
(10, '간편식', 3, 1, 1);

-- 시퀀스 동기화
SELECT setval('category_id_seq', 10);

-- 상품 50개 생성 (하위 카테고리별 분산)
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
    (RANDOM() * 90000 + 10000)::DECIMAL(10,2),
    (RANDOM() * 900 + 100)::INT,
    'Description for product ' || g,
    'https://cdn.example.com/product-' || g || '.jpg',
    'ON_SALE'
FROM generate_series(1, 50) AS g;

-- 회원별 장바구니 생성
INSERT INTO cart (member_id)
SELECT id FROM member;
