import { check } from "k6";
import { requestPayment } from "../common/api.js";

// ATK-B02: 동일 orderId에 대해 동시 결제 요청을 보내
// 중복 결제 race window를 검증한다.
const MEMBER_ID = Number(__ENV.MEMBER_ID || 1);
// 기본값은 test.sql 기준 ORDER_ID=1001 (필요 시 env로 덮어쓰기)
const ORDER_ID = Number(__ENV.ORDER_ID || 1001);

export const options = {
  scenarios: {
    atk_b02: {
      executor: "per-vu-iterations",
      vus: Number(__ENV.VUS || 20),
      iterations: Number(__ENV.ITERATIONS || 5),
      maxDuration: "2m",
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.8"],
  },
};

export default function () {
  // 모든 VU가 같은 orderId를 호출해 경쟁 구간을 최대화한다.
  const res = requestPayment(MEMBER_ID, ORDER_ID, { atk: "B02" });
  check(res, {
    "B02 response is handled": (r) => [200, 201, 400, 409, 422, 500].includes(r.status),
  });
}
