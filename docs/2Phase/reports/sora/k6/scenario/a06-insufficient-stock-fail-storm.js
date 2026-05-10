import { check, sleep } from "k6";
import { Counter } from "k6/metrics";
import { createOrder } from "../common/api.js";

// ATK-A06: 품절/저재고 cartItem으로 실패 주문을 지속 유입해
// 실패 요청 폭주 시 자원 소모 양상을 측정한다.
const MEMBER_IDS = (__ENV.MEMBER_IDS || "2,3,4,5,6,7,8,9,10")
    .split(",")
    .map((v) => Number(v.trim()))
    .filter((v) => !Number.isNaN(v));

// 실패를 유도할 cartItemId 목록(쉼표 구분) 예: 101,102,103
const CART_ITEM_IDS = (__ENV.CART_ITEM_IDS || "2,3,4,5,6,7,8,9,10,62,63,64,65,66")
    .split(",")
    .map((v) => Number(v.trim()))
    .filter((v) => !Number.isNaN(v) && v > 0);

// MEMBER_CART_PAIRS="2:2,3:3,62:62" 형식으로 주입하면
// memberId/cartItemId 소유권 불일치 없이 의도한 실패(재고부족)에 집중할 수 있다.
const MEMBER_CART_PAIRS = (__ENV.MEMBER_CART_PAIRS || "2:2,3:3,4:4,5:5,6:6,7:7,8:8,9:9,10:10,62:62,63:63,64:64,65:65,66:66")
    .split(",")
    .map((pair) => pair.trim())
    .filter((pair) => pair.includes(":"))
    .map((pair) => {
      const [m, c] = pair.split(":").map((v) => Number(v.trim()));
      return { memberId: m, cartItemId: c };
    })
    .filter((p) => !Number.isNaN(p.memberId) && !Number.isNaN(p.cartItemId));

const status201 = new Counter("a06_status_201");
const status4xx = new Counter("a06_status_4xx");
const status5xx = new Counter("a06_status_5xx");

export const options = {
  scenarios: {
    atk_a06: {
      executor: "ramping-vus",
      stages: [
        { duration: "2m", target: Number(__ENV.VUS_START || 20) },
        { duration: "3m", target: Number(__ENV.VUS_MID || 80) },
        { duration: "3m", target: Number(__ENV.VUS_PEAK || 150) },
        { duration: "2m", target: 0 },
      ],
      gracefulRampDown: "10s",
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.8"],
  },
};

export default function () {
  if (MEMBER_CART_PAIRS.length === 0 && CART_ITEM_IDS.length === 0) {
    throw new Error("CART_ITEM_IDS or MEMBER_CART_PAIRS env is required for ATK-A06");
  }

  // 우선순위 1: 명시 매핑(MEMBER_CART_PAIRS)
  // 우선순위 2: 동일 인덱스 매핑(MEMBER_IDS[i] <-> CART_ITEM_IDS[i], 길이가 같을 때)
  // 우선순위 3: 기존 독립 분산(하위 호환)
  let memberId;
  let cartItemId;

  if (MEMBER_CART_PAIRS.length > 0) {
    const pair = MEMBER_CART_PAIRS[__ITER % MEMBER_CART_PAIRS.length];
    memberId = pair.memberId;
    cartItemId = pair.cartItemId;
  } else if (MEMBER_IDS.length === CART_ITEM_IDS.length) {
    const idx = __ITER % MEMBER_IDS.length;
    memberId = MEMBER_IDS[idx];
    cartItemId = CART_ITEM_IDS[idx];
  } else {
    memberId = MEMBER_IDS[__VU % MEMBER_IDS.length];
    cartItemId = CART_ITEM_IDS[__ITER % CART_ITEM_IDS.length];
  }

  const res = createOrder(memberId, [cartItemId], { atk: "A06" });

  if (res.status === 201) status201.add(1);
  else if (res.status >= 400 && res.status < 500) status4xx.add(1);
  else if (res.status >= 500) status5xx.add(1);

  check(res, {
    "A06 response is handled": (r) => [201, 400, 409, 422, 500].includes(r.status),
  });
  // 짧은 간격으로 요청을 유지해 폭주 상황을 재현한다.
  sleep(0.1);
}
