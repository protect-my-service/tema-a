import http from 'k6/http';
import { BASE_URL } from '../config/env.js';

function memberHeaders(memberId) {
    return {
        'Content-Type': 'application/json',
        'X-Member-Id': String(memberId),
        'ngrok-skip-browser-warning': 'true',
    };
}

export function postCartItem(memberId, body) {
    return http.post(`${BASE_URL}/api/v1/cart/items`, JSON.stringify(body), {
        headers: memberHeaders(memberId),
        tags: { name: 'postCartItem' },
    });
}

export function postOrder(memberId, body) {
    return http.post(`${BASE_URL}/api/v1/orders`, JSON.stringify(body), {
        headers: memberHeaders(memberId),
        tags: { name: 'postOrder' },
    });
}

export function getHealth() {
    return http.get(`${BASE_URL}/actuator/health`, {
        headers: { 'ngrok-skip-browser-warning': 'true' },
        tags: { name: 'getHealth' },
    });
}