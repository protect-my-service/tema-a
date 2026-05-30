-- ============================================================
-- Week2 캐싱 조회 성능 측정 시드 (대규모 / 단일 핫상품 + 롱테일)
-- ----------------------------------------------------------
-- 목적: 캐시가 전체 상품을 다 담지 못하게 충분히 크게 시드해
--       캐시 히트(핫상품)와 미스(롱테일 콜드 키)가 동시에 발생하도록 한다.
--       캐시 적용 전(off)/후(on)을 동일 조건에서 비교 측정하기 위한 베이스.
-- ----------------------------------------------------------
-- 협약 (k6 config/env.js 와 일치)
--   ▸ 회원 ID 범위    : 1 ~ 10000   (MEMBER_MIN/MAX 기본값)
--   ▸ 카테고리 ID 범위: 1 ~ 500
--   ▸ 상품 ID 범위    : 1 ~ 50000   (PRODUCT_MIN/MAX 기본값)
--   ▸ 핫 상품 ID      : 1 (TARGET_PRODUCT 기본값) — 재고 매우 큼 / 카테고리 1 고정
--   ▸ 주문 (PAID)     : 200,000건, order_number = 'ORD-W2-' || lpad(g,7,'0')
--   ▸ 결정론적        : RANDOM() 금지. id·값은 generate_series 의 g 에서만 파생.
-- ----------------------------------------------------------
-- 적용 명령 (실제 적용은 측정 담당이 수행 — 본 PR은 파일 생성만)
--   docker exec -i pms-order-bteam-postgres-1 psql -U pms -d pms_order < data-cache.sql
--   ※ 대규모(주문 20만 + order_item 약 40만 + payment 20만)라 시드에 수십 초~수 분 소요.
--   ※ TRUNCATE ... CASCADE 사용 → 기존 주문/장바구니/상품 데이터가 함께 삭제된다.
-- ----------------------------------------------------------
-- 규모 조절: psql -v 로 빠른 소규모 검증이 가능하다(기본은 대규모).
--   예) psql -v n_members=1000 -v n_products=5000 -v n_orders=10000 ... -f data-cache.sql
--   ※ 아래는 "조건부 기본값" — caller가 -v 로 준 값이 있으면 그대로 쓰고, 없을 때만 기본값을 \set 한다.
--     (무조건 \set 하면 -v 가 무시되어 항상 대규모 시드가 돌아간다.)
-- ============================================================

\if :{?n_members}
\else
\set n_members 10000
\endif
\if :{?n_categories}
\else
\set n_categories 500
\endif
\if :{?n_products}
\else
\set n_products 50000
\endif
\if :{?n_orders}
\else
\set n_orders 200000
\endif
\if :{?hot_product_id}
\else
\set hot_product_id 1
\endif

-- 1. 모든 테이블 초기화 (외래키 CASCADE, IDENTITY 시퀀스도 1로 리셋)
TRUNCATE payment, order_item, orders, order_number_sequence,
         cart_item, cart, product, category, member
RESTART IDENTITY CASCADE;

-- 2. 회원 (id 1 ~ :n_members)
INSERT INTO member (email, name)
SELECT
    'user' || g || '@test.com',
    'TestUser' || g
FROM generate_series(1, :n_members) AS g;

-- 3. 카테고리 (id 1 ~ :n_categories)
-- product.category_id NOT NULL FK 충족용. 단순 평면 카테고리(depth 0).
INSERT INTO category (id, name, parent_id, depth, sort_order)
SELECT
    g,
    'Category-' || g,
    NULL,
    0,
    g
FROM generate_series(1, :n_categories) AS g;
SELECT setval('category_id_seq', :n_categories);

-- 4. 상품 (id 1 ~ :n_products) — 단일 핫상품 + 롱테일
--    category_id = ((g-1) % :n_categories) + 1 로 카테고리에 고르게 분산.
--    핫 상품(id = :hot_product_id): 재고를 매우 크게(100,000,000), 카테고리 1 고정.
--    나머지: 롱테일(콜드 키 풀). 가격/재고는 g 에서 결정론적 산출(RANDOM 금지).
--    status 는 ProductStatus enum 유효값 'ON_SALE'.
INSERT INTO product (category_id, name, price, stock_quantity, description, image_url, status)
SELECT
    CASE WHEN g = :hot_product_id THEN 1
         ELSE ((g - 1) % :n_categories) + 1
    END,
    CASE WHEN g = :hot_product_id THEN 'HotProduct-' || g
         ELSE 'Product-' || g
    END,
    (10000 + (g % 90000))::DECIMAL(10,2),                       -- 결정론적 가격 10000~99999
    CASE WHEN g = :hot_product_id THEN 100000000                -- 핫상품: 재고 매우 큼
         ELSE 100 + (g % 900)                                    -- 롱테일: 결정론적 재고 100~999
    END,
    'Description for product ' || g,
    'https://cdn.example.com/product-' || g || '.jpg',
    'ON_SALE'
FROM generate_series(1, :n_products) AS g;

-- 5. 회원별 빈 장바구니 (cart.member_id UNIQUE → 회원당 1개)
--    무효화 측정(cache-invalidation-lag)에서 postCartItem 이 가능하도록 미리 생성.
INSERT INTO cart (member_id)
SELECT id FROM member;

-- 6. 주문 (PAID) :n_orders 건
--    member_id = ((g-1) % :n_members) + 1 로 회원에 순환 분배.
--    order_number = 'ORD-W2-' || lpad(g,7,'0') (UNIQUE 제약 충족).
--    ordered_at = NOW() - (g % 30) 일 → 최근 30일 분포.
--    status 는 OrderStatus enum 유효값 'PAID'. total_amount 는 g 파생 결정론적.
INSERT INTO orders (order_number, member_id, status, total_amount, ordered_at)
SELECT
    'ORD-W2-' || LPAD(g::text, 7, '0'),
    ((g - 1) % :n_members) + 1,
    'PAID',
    (10000 + (g % 90000))::DECIMAL(12,2),
    NOW() - ((g % 30) * INTERVAL '1 day')
FROM generate_series(1, :n_orders) AS g;

-- 7. order_item (주문당 1~3개) — 단일 INSERT ... SELECT (루프/개별 INSERT 금지)
--    주문 o.id 마다 1 + (o.id % 3) 개의 아이템을 generate_series 로 펼친다.
--    상품 id 는 주문/슬롯에서 결정론적으로 파생: ((o.id + s) % :n_products) + 1.
--    product_name / product_price 는 NOT NULL → 스냅샷 값을 결정론적으로 채운다.
--    cancelled_quantity 는 NOT NULL DEFAULT 0 이지만, 취소 baseline 0 을 명시해 self-documenting +
--    향후 default 제거 등 스키마 변경에도 견고하게 둔다(PAID 주문이므로 취소 0).
INSERT INTO order_item (order_id, product_id, product_name, product_price, quantity, cancelled_quantity)
SELECT
    o.id,
    ((o.id + s) % :n_products) + 1                                    AS product_id,
    'Product-' || (((o.id + s) % :n_products) + 1)                    AS product_name,
    (10000 + (((o.id + s) % :n_products) % 90000))::DECIMAL(10,2)     AS product_price,
    1 + (s % 2)                                                       AS quantity,
    0                                                                 AS cancelled_quantity
FROM orders o
CROSS JOIN LATERAL generate_series(0, (o.id % 3)) AS s;  -- 슬롯 0..(0~2) → 주문당 1~3개

-- 8. payment (APPROVED) 주문당 1건
--    payment.order_id UNIQUE, payment_key UNIQUE → order id 기반 결정론적 키.
--    status 는 PaymentStatus enum 유효값 'APPROVED'. paid_at = ordered_at + 1분.
--    cancelled_amount 는 NOT NULL DEFAULT 0 이지만, 취소 baseline 0 을 명시한다(APPROVED/미취소).
INSERT INTO payment (order_id, payment_key, amount, status, paid_at, cancelled_amount)
SELECT
    o.id,
    'PAY-W2-' || LPAD(o.id::text, 7, '0'),
    o.total_amount,
    'APPROVED',
    o.ordered_at + INTERVAL '1 minute',
    0
FROM orders o;

-- ============================================================
-- 검증 쿼리 (적용 후 직접 실행해 시드 결과 확인)
-- ============================================================
-- SELECT COUNT(*) FROM member;                                  -- 10000
-- SELECT COUNT(*) FROM category;                                 -- 500
-- SELECT COUNT(*) FROM product;                                  -- 50000
-- SELECT id, name, stock_quantity FROM product WHERE id = 1;     -- HotProduct-1, 100000000
-- SELECT COUNT(*) FROM cart;                                      -- 10000
-- SELECT COUNT(*) FROM orders WHERE status='PAID';               -- 200000
-- SELECT COUNT(*) FROM order_item;                                -- 약 400000 (주문당 1~3개)
-- SELECT COUNT(*) FROM payment WHERE status='APPROVED';          -- 200000
-- ============================================================
