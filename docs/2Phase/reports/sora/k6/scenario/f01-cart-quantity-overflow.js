import { check, sleep } from "k6";
import { Counter } from "k6/metrics";
import { addCartItem, getCart, parseJsonSafe } from "../common/api.js";

// ============================================================
// ATK-F01 · 장바구니 수량 정수 오버플로우
// ------------------------------------------------------------
// 동일 사용자/동일 상품에 MAX_INT 수량을 반복 추가해 int 오버플로우를 유도한다.
// ============================================================

const MEMBER_ID = parseInt(__ENV.MEMBER_ID || "1", 10);
const PRODUCT_ID = parseInt(__ENV.PRODUCT_ID || "1", 10);
const MAX_INT = 2147483647;
const REPEAT = parseInt(__ENV.REPEAT || "6", 10);
const SLEEP_SECONDS = parseFloat(__ENV.SLEEP || "0.2");

const f01Success = new Counter("f01_status_2xx");
const f01ClientErr = new Counter("f01_status_4xx");
const f01ServerErr = new Counter("f01_status_5xx");
const f01NegativeQuantityDetected = new Counter("f01_negative_quantity_detected_total");
const f01NegativeAmountDetected = new Counter("f01_negative_total_amount_detected_total");

export const options = {
  scenarios: {
    overflow_cart_quantity: {
      executor: "per-vu-iterations",
      vus: parseInt(__ENV.VUS || "1", 10),
      iterations: parseInt(__ENV.ITERATIONS || "1", 10),
      tags: { scenario: "ATK-F01" },
    },
  },
};

export default function () {
  let targetCartItemId = null;

  for (let i = 0; i < REPEAT; i++) {
    const res = addCartItem(MEMBER_ID, PRODUCT_ID, MAX_INT, { atk: "F01" });
    const body = parseJsonSafe(res);
    if (body && body.cartItemId) {
      targetCartItemId = body.cartItemId;
    }

    if (res.status >= 200 && res.status < 300) f01Success.add(1);
    else if (res.status >= 400 && res.status < 500) f01ClientErr.add(1);
    else if (res.status >= 500) f01ServerErr.add(1);

    check(res, {
      "F01 status is 201/200": (r) => r.status === 201 || r.status === 200,
    });
    sleep(SLEEP_SECONDS);
  }

  // 요구사항 검증:
  // 1) 같은 상품 수량 누적 중 int overflow로 음수 수량이 저장되는지
  // 2) 장바구니 총액이 음수화되는지
  const cartRes = getCart(MEMBER_ID, { atk: "F01", step: "verify_cart" });
  const cart = parseJsonSafe(cartRes);

  let negativeQuantityFound = false;
  if (cart && Array.isArray(cart.items)) {
    if (targetCartItemId) {
      const target = cart.items.find((item) => Number(item.cartItemId) === Number(targetCartItemId));
      negativeQuantityFound = !!target && Number(target.quantity) < 0;
    } else {
      negativeQuantityFound = cart.items.some((item) => Number(item.quantity) < 0);
    }
  }

  const totalAmount = cart && cart.totalAmount != null ? Number(cart.totalAmount) : NaN;
  const negativeTotalAmountFound = Number.isFinite(totalAmount) && totalAmount < 0;

  if (negativeQuantityFound) f01NegativeQuantityDetected.add(1);
  if (negativeTotalAmountFound) f01NegativeAmountDetected.add(1);

  check(cartRes, {
    "F01 cart fetch success": (r) => r.status === 200,
  });
  check({ negativeQuantityFound }, {
    "F01 negative quantity detected": (v) => v.negativeQuantityFound === true,
  });
  check({ negativeTotalAmountFound }, {
    "F01 negative total amount detected": (v) => v.negativeTotalAmountFound === true,
  });
}
