import http from "k6/http";
import { BASE_URL, memberHeader } from "./config.js";

export function addCartItem(memberId, productId, quantity, tags = {}) {
  const payload = JSON.stringify({ productId, quantity });
  return http.post(`${BASE_URL}/api/v1/cart/items`, payload, {
    headers: memberHeader(memberId),
    tags,
  });
}

export function createOrder(memberId, cartItemIds, tags = {}) {
  const payload = JSON.stringify({ cartItemIds });
  return http.post(`${BASE_URL}/api/v1/orders`, payload, {
    headers: memberHeader(memberId),
    tags,
  });
}

export function requestPayment(memberId, orderId, tags = {}) {
  const payload = JSON.stringify({ orderId });
  return http.post(`${BASE_URL}/api/v1/payments`, payload, {
    headers: memberHeader(memberId),
    tags,
    timeout: __ENV.PAYMENT_TIMEOUT || "35s",
  });
}

export function cancelOrder(memberId, orderId, items, reason = "", tags = {}) {
  const payload = JSON.stringify({ reason, items });
  return http.post(`${BASE_URL}/api/v1/orders/${orderId}/cancel`, payload, {
    headers: memberHeader(memberId),
    tags,
  });
}

export function parseJsonSafe(response) {
  try {
    return response.json();
  } catch (_) {
    return null;
  }
}

