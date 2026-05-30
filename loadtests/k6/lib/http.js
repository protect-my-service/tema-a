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

// 장바구니 아이템 삭제. 무효화 측정의 self-clean(측정 후 baseline 복원)에 사용한다.
// DELETE /api/v1/cart/items/{cartItemId} -> 204
export function deleteCartItem(memberId, cartItemId, params = {}) {
  return http.del(
    `${BASE_URL}/api/v1/cart/items/${cartItemId}`,
    null,
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

// ===== Week2 캐싱 조회 성능 측정용 GET 헬퍼 =====
// products/categories는 인증/회원 헤더가 없는 공개 조회 API이므로 헤더를 붙이지 않는다.
// orders/cart만 X-Member-Id 헤더가 필요하다.

// 상품 단건 상세 조회. 캐시 핫스팟 측정의 주 대상.
// GET /api/v1/products/{productId} -> ProductDetailResponse(id=id)
export function getProduct(productId, params = {}) {
  return http.get(`${BASE_URL}/api/v1/products/${productId}`, params);
}

// 상품 목록 조회. query로 categoryId/page/size를 넘긴다.
// GET /api/v1/products?categoryId=&page=&size= -> Page<ProductListResponse>
// 예: getProductList({ categoryId: 1, page: 0, size: 20 })
export function getProductList(query = {}, params = {}) {
  const qs = Object.entries(query)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  const url = qs
    ? `${BASE_URL}/api/v1/products?${qs}`
    : `${BASE_URL}/api/v1/products`;
  return http.get(url, params);
}

// 주문 단건 조회. 회원 헤더가 필요하다.
// GET /api/v1/orders/{orderId} (헤더 X-Member-Id) -> OrderResponse(id=orderId)
export function getOrder(memberId, orderId, params = {}) {
  return http.get(
    `${BASE_URL}/api/v1/orders/${orderId}`,
    { headers: headers(memberId), ...params },
  );
}

// 카테고리 전체 조회. 변동이 거의 없는 정적 데이터.
// GET /api/v1/categories
export function getCategories(params = {}) {
  return http.get(`${BASE_URL}/api/v1/categories`, params);
}
