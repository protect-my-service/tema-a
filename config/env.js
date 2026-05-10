export const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';

export const baseThresholds = {
    'http_req_failed': ['rate<1.00'],
};