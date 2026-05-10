import { check, sleep } from "k6";
import { Counter } from "k6/metrics";
import { requestPayment } from "../common/api.js";

// ============================================================
// ATK-B01 · 외부 PG 호출 시 커넥션 점유
// ------------------------------------------------------------
// 결제 API 부하를 점진 증가시켜 트랜잭션 내 외부 PG 호출 영향(지연/풀 점유)을 측정한다.
// ============================================================

const MEMBER_IDS = (__ENV.MEMBER_IDS || "1,2,3,4,5,6,7,8,9,10")
    .split(",")
    .map((v) => Number(v.trim()))
    .filter((v) => !Number.isNaN(v));

// 결제 대상 orderId 목록(쉼표 구분) 예: 1001,1002,1003
const ORDER_IDS = (__ENV.ORDER_IDS || "1001,1002,1003,1004,1005,1006,1007,1008,1009,1010")
    .split(",")
    .map((v) => Number(v.trim()))
    .filter((v) => !Number.isNaN(v) && v > 0);

// MEMBER_ORDER_PAIRS="1:1001,2:1002,3:1003" 형식 권장
// 소유권 불일치로 인한 빠른 실패를 줄이고 B01 의도(외부 PG 지연/커넥션 점유)에 집중한다.
const MEMBER_ORDER_PAIRS = (__ENV.MEMBER_ORDER_PAIRS || "1:1001,2:1002,3:1003,4:1004,5:1005,6:1006,7:1007,8:1008,9:1009,10:1010")
    .split(",")
    .map((pair) => pair.trim())
    .filter((pair) => pair.includes(":"))
    .map((pair) => {
      const [m, o] = pair.split(":").map((v) => Number(v.trim()));
      return { memberId: m, orderId: o };
    })
    .filter((p) => !Number.isNaN(p.memberId) && !Number.isNaN(p.orderId));

const status2xx = new Counter("b01_status_2xx");
const status4xx = new Counter("b01_status_4xx");
const status5xx = new Counter("b01_status_5xx");
const requestErr = new Counter("b01_request_error_total");

export const options = {
  scenarios: {
    atk_b01: {
      executor: "ramping-vus",
      stages: [
        { duration: "2m", target: 10 },
        { duration: "3m", target: 30 },
        { duration: "3m", target: 60 },
        { duration: "2m", target: 100 },
      ],
      gracefulRampDown: "10s",
      tags: { scenario: "ATK-B01" },
    },
  },
};

export default function () {
  if (MEMBER_ORDER_PAIRS.length === 0 && ORDER_IDS.length === 0) {
    throw new Error("ORDER_IDS or MEMBER_ORDER_PAIRS env is required for ATK-B01");
  }

  // 우선순위 1: 명시 매핑(MEMBER_ORDER_PAIRS)
  // 우선순위 2: 동일 인덱스 매핑(MEMBER_IDS[i] <-> ORDER_IDS[i], 길이가 같을 때)
  // 우선순위 3: 기존 독립 분산(하위 호환)
  let memberId;
  let orderId;

  if (MEMBER_ORDER_PAIRS.length > 0) {
    const pair = MEMBER_ORDER_PAIRS[__ITER % MEMBER_ORDER_PAIRS.length];
    memberId = pair.memberId;
    orderId = pair.orderId;
  } else if (MEMBER_IDS.length === ORDER_IDS.length) {
    const idx = __ITER % MEMBER_IDS.length;
    memberId = MEMBER_IDS[idx];
    orderId = ORDER_IDS[idx];
  } else {
    memberId = MEMBER_IDS[__VU % MEMBER_IDS.length];
    orderId = ORDER_IDS[__ITER % ORDER_IDS.length];
  }

  const res = requestPayment(memberId, orderId, { atk: "B01" });

  if (res.status === 0) requestErr.add(1);
  else if (res.status >= 200 && res.status < 300) status2xx.add(1);
  else if (res.status >= 400 && res.status < 500) status4xx.add(1);
  else if (res.status >= 500) status5xx.add(1);

  check(res, {
    "B01 response is handled": (r) => [200, 400, 409, 422, 500].includes(r.status),
  });
  // 요청 간격을 짧게 유지해 부하 곡선을 안정적으로 만든다.
  sleep(0.1);
}
