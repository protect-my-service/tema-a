import { check } from "k6";
import { createOrder } from "../common/api.js";

// ATK-A01: 음수 수량이 저장된 cartItem으로 주문을 생성해 검증 누락 여부를 확인한다.
const MEMBER_ID = Number(__ENV.MEMBER_ID || 1);
// 기본값은 test.sql 기준 cartItemId=1 (필요 시 env로 덮어쓰기)
const CART_ITEM_ID = Number(__ENV.CART_ITEM_ID || 1);

export const options = {
  vus: Number(__ENV.VUS || 1),
  iterations: Number(__ENV.ITERATIONS || 1),
  thresholds: {
    http_req_failed: ["rate<0.05"],
  },
};

export default function () {
  // 단일 cartItem 기준으로 주문 1건을 생성한다.
  const res = createOrder(MEMBER_ID, [CART_ITEM_ID], { atk: "A01" });
  check(res, {
    "A01 status is 201": (r) => r.status === 201,
  });
}
