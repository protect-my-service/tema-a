import { check } from "k6";
import { Counter } from "k6/metrics";
import { requestPayment } from "../common/api.js";

// ============================================================
// ATK-B02 · 중복 결제 Race Condition
// ------------------------------------------------------------
// 동일 orderId 동시 결제 요청으로 중복 결제 경쟁 구간을 검증한다.
// ============================================================

const MEMBER_ID = parseInt(__ENV.MEMBER_ID || "1", 10);
const ORDER_ID = parseInt(__ENV.ORDER_ID || "1001", 10);
const status2xx = new Counter("b02_status_2xx");
const status4xx = new Counter("b02_status_4xx");
const status5xx = new Counter("b02_status_5xx");
const requestErr = new Counter("b02_request_error_total");

export const options = {
  scenarios: {
    atk_b02: {
      executor: "per-vu-iterations",
      vus: parseInt(__ENV.VUS || "20", 10),
      iterations: parseInt(__ENV.ITERATIONS || "5", 10),
      maxDuration: "2m",
      tags: { scenario: "ATK-B02" },
    },
  },
};

export default function () {
  // 모든 VU가 같은 orderId를 호출해 경쟁 구간을 최대화한다.
  const res = requestPayment(MEMBER_ID, ORDER_ID, { atk: "B02" });

  if (res.status === 0) requestErr.add(1);
  else if (res.status >= 200 && res.status < 300) status2xx.add(1);
  else if (res.status >= 400 && res.status < 500) status4xx.add(1);
  else if (res.status >= 500) status5xx.add(1);

  check(res, {
    "B02 response is handled": (r) => [200, 201, 400, 409, 422, 500].includes(r.status),
  });
}
