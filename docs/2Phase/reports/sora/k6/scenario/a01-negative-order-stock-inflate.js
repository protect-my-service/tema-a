import { check } from "k6";
import { Counter } from "k6/metrics";
import { createOrder } from "../common/api.js";

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
  // 단일 cartItem 기준으로 주문 1건을 생성한다.
  const res = createOrder(MEMBER_ID, [CART_ITEM_ID], { atk: "A01" });

  if (res.status === 201) vulnerable201.add(1);
  else if (res.status >= 400 && res.status < 500) blocked4xx.add(1);
  else if (res.status >= 500) server5xx.add(1);

  check(res, {
    "A01 status is 201": (r) => r.status === 201,
  });
}
