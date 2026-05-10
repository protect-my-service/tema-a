import { check, sleep } from "k6";
import { Counter } from "k6/metrics";
import { cancelOrder } from "../common/api.js";

// ATK-C02: 취소 아이템 수가 많은 요청을 반복해
// 취소 처리 트랜잭션 장기화에 따른 성능 저하를 측정한다.
const MEMBER_ID = Number(__ENV.MEMBER_ID || 1);
const ORDER_ID = Number(__ENV.ORDER_ID || 3001);
const REASON = __ENV.REASON || "load-test-c02";
// 예: [{"orderItemId":11,"quantity":1},{"orderItemId":12,"quantity":2}]
const CANCEL_ITEMS_JSON =
    __ENV.CANCEL_ITEMS_JSON ||
    '[{"orderItemId":300101,"quantity":1},{"orderItemId":300102,"quantity":1},{"orderItemId":300103,"quantity":1}]';
// 권장: C02_CASES_JSON='[{"orderId":3001,"items":[...]},{"orderId":3002,"items":[...]}]'
// 여러 주문/아이템셋을 순환해 "이미 취소됨"으로 조기 수렴하는 왜곡을 줄인다.
const C02_CASES_JSON =
    __ENV.C02_CASES_JSON ||
    '[{"orderId":3001,"items":[{"orderItemId":300101,"quantity":1},{"orderItemId":300102,"quantity":1}]},{"orderId":3001,"items":[{"orderItemId":300103,"quantity":1},{"orderItemId":300104,"quantity":1}]},{"orderId":3001,"items":[{"orderItemId":300105,"quantity":1},{"orderItemId":300106,"quantity":1}]}]';

let cancelItems = [];
try {
  cancelItems = JSON.parse(CANCEL_ITEMS_JSON);
} catch (_) {
  cancelItems = [];
}

let c02Cases = [];
try {
  c02Cases = JSON.parse(C02_CASES_JSON);
} catch (_) {
  c02Cases = [];
}

const status2xx = new Counter("c02_status_2xx");
const status4xx = new Counter("c02_status_4xx");
const status5xx = new Counter("c02_status_5xx");

export const options = {
  scenarios: {
    atk_c02: {
      executor: "ramping-vus",
      stages: [
        { duration: "2m", target: Number(__ENV.VUS_START || 5) },
        { duration: "3m", target: Number(__ENV.VUS_MID || 20) },
        { duration: "3m", target: Number(__ENV.VUS_PEAK || 40) },
        { duration: "2m", target: 0 },
      ],
      gracefulRampDown: "10s",
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.8"],
    http_req_duration: ["p(95)<10000"],
  },
};

export default function () {
  // 우선순위 1: C02_CASES_JSON 로테이션
  // 우선순위 2: ORDER_ID + CANCEL_ITEMS_JSON 고정 호출(하위 호환)
  let targetOrderId = ORDER_ID;
  let targetItems = cancelItems;

  if (Array.isArray(c02Cases) && c02Cases.length > 0) {
    const c = c02Cases[__ITER % c02Cases.length];
    targetOrderId = Number(c.orderId || 0);
    targetItems = Array.isArray(c.items) ? c.items : [];
  }

  if (!targetOrderId) {
    throw new Error("ORDER_ID or C02_CASES_JSON(orderId) is required for ATK-C02");
  }
  if (!Array.isArray(targetItems) || targetItems.length === 0) {
    throw new Error("CANCEL_ITEMS_JSON or C02_CASES_JSON(items) is required for ATK-C02");
  }

  // 동일 주문에 대해 지정한 취소 아이템 묶음을 반복 호출한다.
  const res = cancelOrder(MEMBER_ID, targetOrderId, targetItems, REASON, { atk: "C02" });

  if (res.status >= 200 && res.status < 300) status2xx.add(1);
  else if (res.status >= 400 && res.status < 500) status4xx.add(1);
  else if (res.status >= 500) status5xx.add(1);

  check(res, {
    "C02 response is handled": (r) => [200, 400, 409, 422, 500].includes(r.status),
  });
  // 짧은 간격 유지로 처리시간 누적 영향을 관찰한다.
  sleep(0.1);
}
