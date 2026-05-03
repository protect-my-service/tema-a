import {pickMember} from "../../lib/data.js";
import {postCartItem, postOrder} from "../../lib/http.js";
import {check} from "k6";

// 주문 smoke에서 사용할 상품 ID.
// 실행 시 TARGET_PRODUCT=3 처럼 덮어쓸 수 있다.
const TARGET_PRODUCT_ID = parseInt(__ENV.TARGET_PRODUCT || '1', 10);

export const options = {
    vus: 1, // smoke는 부하 테스트가 아니므로 가상 사용자 1명만 사용한다.
    iterations: 5, // 같은 흐름을 5번 반복해 요청 형식과 시드 데이터가 안정적인지 확인한다.
    thresholds: {
        http_req_failed: ['rate<0.05'], // smoke에서는 대부분의 요청이 성공해야 한다.
        http_req_duration: ['p(95)<1000'],  // 95%의 요청이 1초 안에 끝나는지 확인한다.
    },
};

export default function () {
    // 매 iteration마다 시드 범위 안에서 회원을 하나 고른다.
    const memberId = pickMember();

    // 주문 생성 API는 cartItemIds를 받으므로, 먼저 장바구니에 상품을 담는다.
    const cartRes = postCartItem(memberId, {
        productId: TARGET_PRODUCT_ID,
        quantity: 1,
    });


    // 장바구니 추가 요청이 정상 응답인지 확인한다.
    check(cartRes, {
        'cart add 2xx': (response) => response.status >= 200 && response.status < 300,
    });

    // 장바구니 추가가 실패하면 cartItemId를 얻을 수 없으므로 주문 생성은 건너뛴다.
    if (cartRes.status < 200 || cartRes.status >= 300) {
        console.error(`Failed to add item to cart for member ${memberId}. Status: ${cartRes.status}`);
        return;
    }

    // AddCartItemResponse에서 주문 생성에 필요한 cartItemId를 꺼낸다.
    const cartBody = JSON.parse(cartRes.body);
    const cartItemId = cartBody.cartItemId;


    // phase2 주문 생성 API는 상품 ID가 아니라 장바구니 아이템 ID 목록을 받는다.
    const orderRes = postOrder(memberId, {
        cartItemIds: [cartItemId],
    });

    if (orderRes.status < 200 || orderRes.status >= 300) {
        console.error(`Failed to create order for member ${memberId}. Status: ${orderRes.status}, Body: ${orderRes.body}`);
    }

    // smoke의 목적은 주문 생성 API가 실제로 성공하는지 확인하는 것이다.
    check(orderRes, {
        'order create 2xx': (response) => response.status >= 200 && response.status < 300,
    });
}
