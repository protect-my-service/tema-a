import { check } from 'k6';
import { TARGET_PRODUCT, MEMBERS, PRODUCTS } from '../../config/env.js';
import {
  getProduct,
  getProductList,
  getCategories,
  getCart,
  getOrder,
} from '../../lib/http.js';

// Week2 캐시 측정 베이스의 조회 엔드포인트가 실제로 동작하는지 확인하는 smoke.
// 공격/부하가 아니라 환경 확인이 목적이므로 1 VU로 소수 iteration만 돈다.
// 여기서 실패하면 본 측정(a02-product-hotspot-read / cache-invalidation-lag)을 돌리기 전에
// BASE_URL, 시드 데이터(특히 TARGET_PRODUCT 상품 존재), 엔드포인트 경로를 먼저 점검한다.

export const options = {
  vus: 1, // smoke는 부하 테스트가 아니므로 가상 사용자 1명만 사용한다.
  iterations: 5, // 같은 흐름을 5번 반복해 조회 응답 형식과 시드 데이터가 안정적인지 확인한다.
  thresholds: {
    // ★ 응답 "형식(check)"까지 모두 통과해야 preflight가 통과하도록 checks rate에 게이트를 건다.
    //   k6는 check 실패만으로는 종료코드를 바꾸지 않으므로(2xx인데 body가 틀려도 exit 0),
    //   threshold가 없으면 잘못된 API 계약으로도 preflight가 통과해 벤치마크가 "깨진 응답"을 측정하게 된다.
    //   'rate==1' 이면 product id/content 등 스키마 check가 하나라도 깨지면 smoke가 fail → 러너가 abort한다.
    checks: ['rate==1.00'],
    http_req_failed: ['rate<0.05'], // 요청 자체 실패율(비-2xx/연결 실패)
    http_req_duration: ['p(95)<1000'], // 95%의 요청이 1초 안에 끝나는지 확인한다.
  },
};

export default function () {
  // 1) 핫상품 단건 조회: 2xx 이고 body에 id가 존재하는지 확인.
  const detailRes = getProduct(TARGET_PRODUCT);
  check(detailRes, {
    'product detail 2xx': (r) => r.status >= 200 && r.status < 300,
    'product detail has id': (r) => {
      try {
        return JSON.parse(r.body).id !== undefined;
      } catch (e) {
        return false;
      }
    },
  });

  // 2) 상품 목록 조회: 2xx 이고 Page 응답의 content 배열이 존재하는지 확인.
  const listRes = getProductList({ page: 0, size: 20 });
  check(listRes, {
    'product list 2xx': (r) => r.status >= 200 && r.status < 300,
    'product list has content': (r) => {
      try {
        return Array.isArray(JSON.parse(r.body).content);
      } catch (e) {
        return false;
      }
    },
  });

  // 3) 카테고리(정적) 조회: 2xx 응답인지 확인.
  const catRes = getCategories();
  check(catRes, {
    'categories 2xx': (r) => r.status >= 200 && r.status < 300,
  });

  // 4) ★ 벤치마크가 "실제로 사용할 ID 범위의 경계"가 시드에 존재하는지 확인한다.
  //    러너가 MEMBER_MAX/PRODUCT_MAX 를 preflight로 전달하므로, 그 경계 상품/회원 카트가 없으면
  //    (소형 시드에 대규모 범위 등 seed/range drift) 여기서 check가 깨져 smoke가 fail → 러너 abort.
  //    이게 없으면 핫상품(1)만 있는 시드도 preflight를 통과한 뒤 콜드 키 404 폭주를 벤치마킹하게 된다.
  const boundaryProductRes = getProduct(PRODUCTS.max);
  check(boundaryProductRes, {
    'boundary product (PRODUCT_MAX) 2xx': (r) => r.status >= 200 && r.status < 300,
    'boundary product has id': (r) => {
      try {
        return JSON.parse(r.body).id !== undefined;
      } catch (e) {
        return false;
      }
    },
  });

  const boundaryCartRes = getCart(MEMBERS.max);
  check(boundaryCartRes, {
    'boundary member (MEMBER_MAX) cart 2xx': (r) => r.status >= 200 && r.status < 300,
  });

  // 5) 시드된 PAID 주문 1건 조회 — 가이드가 주문 조회도 측정면으로 두므로 주문 시드/읽기 경로까지 확인한다.
  //    data-cache.sql 협약상 주문 1은 회원 1 소유(member_id = ((id-1) % n_members) + 1).
  //    주문 시드가 없거나 깨졌으면 여기서 fail → 러너 abort.
  const orderRes = getOrder(1, 1);
  check(orderRes, {
    'seeded order 2xx': (r) => r.status >= 200 && r.status < 300,
    'seeded order has orderId': (r) => {
      try {
        return JSON.parse(r.body).orderId !== undefined;
      } catch (e) {
        return false;
      }
    },
  });
}
