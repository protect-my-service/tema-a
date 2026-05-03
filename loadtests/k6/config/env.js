// k6 공통 환경 설정.
//
// 모든 테스트는 이 파일을 import해서 타겟 URL, 시드 ID 범위,
// 공통 threshold를 공유한다. 필요하면 실행 시 환경변수로 덮어쓴다.

export const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';

// phase2/data.sql 기준 기본 시드 범위.
// 다른 시드 데이터를 쓰는 경우 MEMBER_MIN/MAX, PRODUCT_MIN/MAX로 조정한다.
export const MEMBERS = {
  min: parseInt(__ENV.MEMBER_MIN || '1', 10),
  max: parseInt(__ENV.MEMBER_MAX || '100', 10),
};

export const PRODUCTS = {
  min: parseInt(__ENV.PRODUCT_MIN || '1', 10),
  max: parseInt(__ENV.PRODUCT_MAX || '50', 10),
};

// 공격 테스트는 실패를 유도할 수 있으므로 기본 threshold를 느슨하게 둔다.
// 개별 테스트에서 spread 후 필요한 기준만 추가하거나 덮어쓴다.
export const baseThresholds = {
  http_req_failed: ['rate<0.95'],
  http_req_duration: ['p(95)<60000'],
};
