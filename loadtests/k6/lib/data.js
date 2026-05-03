// k6 테스트에서 사용할 memberId, productId 를 선택하는 공통 유틸
import { MEMBERS, PRODUCTS } from '../config/env.js';

// min/max 양 끝을 포함하는 랜덤 정수.
// 예: randInt(1, 3) => 1, 2, 3 중 하나
export function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// 시드 데이터 범위 안에서 임의의 회원 ID를 고른다.
// 여러 회원에게 부하를 분산시키는 시나리오에서 사용
export function pickMember() {
  return randInt(MEMBERS.min, MEMBERS.max);
}

// 시드 데이터 범위 안에서 임의의 상품 ID를 고른다.
// 특정 상품이 아닌 일반 상품 트래픽을 만들 때 사용
export function pickProduct() {
  return randInt(PRODUCTS.min, PRODUCTS.max);
}

// seed를 기준으로 상품 ID를 순서대로 순환시킨다.
// 랜덤이 아니라 같은 seed에는 항상 같은 productId가 나온다.
// 예: product 1~3 범위라면 seed 0,1,2,3 => product 1,2,3,1
// 같은 카트 안에 여러 상품 row를 고르게 쌓는 시나리오에서 사용
export function rotateProduct(seed) {
  const span = PRODUCTS.max - PRODUCTS.min + 1;
  return PRODUCTS.min + (seed % span);
}
