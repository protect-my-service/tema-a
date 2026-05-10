-- ─────────────────────────────────────────────────────────────────────
-- C03 시나리오 더미 데이터 생성 스크립트
-- ─────────────────────────────────────────────────────────────────────
-- 목적: PAID 상태의 취소 가능한 주문 50건을 빠르게 만들어둠
-- 사용: psql -h localhost -U pms -d pms_order -f data/seed-c03.sql
-- ─────────────────────────────────────────────────────────────────────
-- 주의:
--   1. 이 스크립트는 PaymentService 정상 흐름을 우회하고 DB 직접 INSERT 함
--      (공방전 준비용 데이터셋이지 비즈니스 흐름 검증이 아님)
--   2. 기존 데이터(data.sql)에 의존: member 100명, product 50개가 미리 있어야 함
--   3. order_number 는 'C03-' prefix 로 시작 → 검증 시 식별 용이
--   4. paid_at 은 현재 시각 기준 → 기본 cancel window(1시간) 이내
-- ─────────────────────────────────────────────────────────────────────

BEGIN;

-- 1) 이전 C03 시드 데이터 정리 (재실행 가능하게)
DELETE FROM payment WHERE payment_key LIKE 'C03-PAY-%';
DELETE FROM order_item WHERE order_id IN (
    SELECT id FROM orders WHERE order_number LIKE 'C03-%'
);
DELETE FROM orders WHERE order_number LIKE 'C03-%';

-- 2) PAID 주문 50건 생성
--    - member_id 는 1~50 사용 (data.sql 에서 100명 생성한 가정)
--    - product_id 는 1~50 순환 (data.sql 에서 50개 생성한 가정)
--    - 수량 1, 가격은 product 의 실제 price 사용
INSERT INTO orders (order_number, member_id, status, total_amount, ordered_at, created_at, updated_at)
SELECT
    'C03-' || LPAD(g::text, 4, '0'),
    g,                                       -- member_id 1~50
    'PAID',
    p.price,                                 -- 단가 그대로 (수량 1)
    NOW() - INTERVAL '5 minutes',
    NOW() - INTERVAL '5 minutes',
    NOW() - INTERVAL '5 minutes'
FROM generate_series(1, 50) AS g
JOIN product p ON p.id = ((g - 1) % 50) + 1;

-- 3) OrderItem 50건 생성 (각 주문에 1개씩)
INSERT INTO order_item (order_id, product_id, product_name, product_price, quantity, cancelled_quantity, created_at)
SELECT
    o.id,
    p.id,
    p.name,
    p.price,
    1,                                       -- quantity = 1
    0,                                       -- cancelled_quantity = 0
    NOW() - INTERVAL '5 minutes'
FROM orders o
JOIN product p ON p.id = ((CAST(SUBSTRING(o.order_number FROM 5) AS INT) - 1) % 50) + 1
WHERE o.order_number LIKE 'C03-%';

-- 4) Payment 50건 생성 (APPROVED 상태)
--    - payment_key prefix 'C03-PAY-' → 검증 시 식별 용이
--    - paid_at = NOW() − 5분 → cancel window 안에 있음
INSERT INTO payment (order_id, payment_key, amount, cancelled_amount, status, paid_at, created_at, updated_at)
SELECT
    o.id,
    'C03-PAY-' || LPAD(CAST(SUBSTRING(o.order_number FROM 5) AS INT)::text, 4, '0'),
    o.total_amount,
    0,
    'APPROVED',
    NOW() - INTERVAL '5 minutes',
    NOW() - INTERVAL '5 minutes',
    NOW() - INTERVAL '5 minutes'
FROM orders o
WHERE o.order_number LIKE 'C03-%';

COMMIT;

-- 5) 검증 출력
\echo '=== C03 시드 데이터 생성 결과 ==='
SELECT
    COUNT(*) FILTER (WHERE status = 'PAID')   AS paid_orders,
    COUNT(*) FILTER (WHERE status = 'CANCELLED') AS already_cancelled,
    MIN(member_id) AS min_member,
    MAX(member_id) AS max_member
FROM orders
WHERE order_number LIKE 'C03-%';

\echo ''
\echo '=== 검증: 위 결과가 paid_orders=50, already_cancelled=0 이어야 정상 ==='
\echo ''
\echo '예시 주문 3건:'
SELECT id, order_number, member_id, status, total_amount
FROM orders
WHERE order_number LIKE 'C03-%'
ORDER BY id
LIMIT 3;
