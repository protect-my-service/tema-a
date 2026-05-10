import { check, sleep } from "k6";
import { addCartItem } from "../common/api.js";

// ATK-F01: 동일 사용자/동일 상품에 MAX_INT 수량을 반복 추가해 int 오버플로우를 유도한다.
const MEMBER_ID = Number(__ENV.MEMBER_ID || 1);
const PRODUCT_ID = Number(__ENV.PRODUCT_ID || 1);
const MAX_INT = 2147483647;
// 반복 횟수 기본값 6회 (요구 시나리오 기준)
const REPEAT = Number(__ENV.REPEAT || 6);

export const options = {
  vus: Number(__ENV.VUS || 1),
  iterations: Number(__ENV.ITERATIONS || 1),
  thresholds: {
    http_req_failed: ["rate<0.05"],
  },
};

export default function () {
  // 동일 payload를 연속 전송해 수량 누적 경로를 강하게 자극한다.
  for (let i = 0; i < REPEAT; i++) {
    const res = addCartItem(MEMBER_ID, PRODUCT_ID, MAX_INT, { atk: "F01" });
    check(res, {
      "F01 status is 201/200": (r) => r.status === 201 || r.status === 200,
    });
    // 요청 간 짧은 간격으로 서버 처리 순서를 안정화한다.
    sleep(0.2);
  }
}
