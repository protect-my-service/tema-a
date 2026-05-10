export const BASE_URL = __ENV.BASE_URL || "http://localhost:8080";

export const DEFAULT_HEADERS = {
  "Content-Type": "application/json",
};

export function memberHeader(memberId) {
  return {
    ...DEFAULT_HEADERS,
    "X-Member-Id": String(memberId),
  };
}
