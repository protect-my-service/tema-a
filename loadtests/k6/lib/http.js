import http from 'k6/http';
import { BASE_URL } from '../config/env.js';

// phase2 API는 회원 식별을 X-Member-Id 헤더 필요
export function headers(memberId) {
  return {
    'Content-Type': 'application/json',
    'X-Member-Id': String(memberId),
  };
}

// 장바구니에 상품을 추가
export function postCartItem(memberId, body, params = {}) {
  return http.post(
    `${BASE_URL}/api/v1/cart/items`,
    JSON.stringify(body),
    { headers: headers(memberId), ...params },
  );
}

// 특정 회원의 장바구니를 조회
export function getCart(memberId, params = {}) {
  return http.get(
    `${BASE_URL}/api/v1/cart`,
    { headers: headers(memberId), ...params },
  );
}

// 공격 중 서버 생존 여부와 응답 지연을 확인할 때 사용
export function getHealth(params = {}) {
  return http.get(`${BASE_URL}/actuator/health`, params);
}

// 주문 생성 헬퍼
export function postOrder(memberId, body, params = {}) {
  return http.post(
    `${BASE_URL}/api/v1/orders`,
    JSON.stringify(body),
    { headers: headers(memberId), ...params },
  );
}
