import { check } from "k6";
import { Counter } from "k6/metrics";
import { createOrder, getCart, getProduct, parseJsonSafe } from "../common/api.js";

// ============================================================
// ATK-A01 · 음수 수량 주문 및 재고 부풀리기
// ------------------------------------------------------------
// 음수 수량 cartItem으로 주문 생성이 가능한지(201) 또는 차단되는지(4xx) 확인한다.
// ============================================================

const MEMBER_ID = parseInt(__ENV.MEMBER_ID || "1", 10);
const CART_ITEM_ID = parseInt(__ENV.CART_ITEM_ID || "1", 10);
const vulnerable201 = new Counter("a01_vulnerable_201");
const blocked4xx = new Counter("a01_blocked_4xx");
const server5xx = new Counter("a01_server_5xx");
const negativeOrderAmountDetected = new Counter("a01_negative_order_amount_detected_total");
const stockInflationDetected = new Counter("a01_stock_inflation_detected_total");

export const options = {
  scenarios: {
    negative_order_create: {
      executor: "per-vu-iterations",
      vus: parseInt(__ENV.VUS || "1", 10),
      iterations: parseInt(__ENV.ITERATIONS || "1", 10),
      tags: { scenario: "ATK-A01" },
    },
  },
};

export default function () {
  // 주문 전 cart 조회로 대상 cartItem의 productId를 식별한다.
  const cartRes = getCart(MEMBER_ID, { atk: "A01", step: "read_cart" });
  const cart = parseJsonSafe(cartRes);
  const targetItem = cart && Array.isArray(cart.items)
      ? cart.items.find((item) => Number(item.cartItemId) === CART_ITEM_ID)
      : null;
  const productId = targetItem ? Number(targetItem.productId) : NaN;

  // 주문 전 재고 스냅샷
  let stockBefore = NaN;
  if (Number.isFinite(productId)) {
    const beforeRes = getProduct(productId, { atk: "A01", step: "stock_before" });
    const before = parseJsonSafe(beforeRes);
    stockBefore = before && before.stockQuantity != null ? Number(before.stockQuantity) : NaN;
  }

  // 단일 cartItem 기준으로 주문 1건을 생성한다.
  const res = createOrder(MEMBER_ID, [CART_ITEM_ID], { atk: "A01" });
  const order = parseJsonSafe(res);

  if (res.status === 201) vulnerable201.add(1);
  else if (res.status >= 400 && res.status < 500) blocked4xx.add(1);
  else if (res.status >= 500) server5xx.add(1);

  // 주문 응답의 총액 음수화 여부 검증
  const totalAmount = order && order.totalAmount != null ? Number(order.totalAmount) : NaN;
  const isNegativeOrderAmount = Number.isFinite(totalAmount) && totalAmount < 0;
  if (isNegativeOrderAmount) negativeOrderAmountDetected.add(1);

  // 주문 후 재고 증가 여부 검증
  let stockIncreased = false;
  if (res.status === 201 && Number.isFinite(productId) && Number.isFinite(stockBefore)) {
    const afterRes = getProduct(productId, { atk: "A01", step: "stock_after" });
    const after = parseJsonSafe(afterRes);
    const stockAfter = after && after.stockQuantity != null ? Number(after.stockQuantity) : NaN;
    stockIncreased = Number.isFinite(stockAfter) && stockAfter > stockBefore;
  }
  if (stockIncreased) stockInflationDetected.add(1);

  check(cartRes, {
    "A01 cart fetch success": (r) => r.status === 200,
  });
  check(res, {
    "A01 response is handled": (r) => [201, 400, 409, 422, 500].includes(r.status),
  });
  check({ productId }, {
    "A01 target product resolved": (v) => Number.isFinite(v.productId),
  });
  check({ isNegativeOrderAmount }, {
    "A01 negative totalAmount detected": (v) => v.isNegativeOrderAmount === true,
  });
  check({ stockIncreased }, {
    "A01 stock inflation detected": (v) => v.stockIncreased === true,
  });
}
