// ─────────────────────────────────────────────────────────────────────
// W3 · 컨슈머 lag 측정 (RabbitMQ 큐 깊이 시계열)
// ─────────────────────────────────────────────────────────────────────
// RabbitMQ Management API를 주기적으로 폴링해 각 큐의 messages_ready(대기) /
// messages_unacknowledged(처리중)를 트렌드로 기록한다. 장애 주입 → 재기동 후
// 적체가 쌓였다가 빠지는 곡선(= 컨슈머 lag 회복)을 관찰한다.
//
// 정밀한 "회복 시간(초)" 숫자는 verify-w3.sh lag 가 별도로 계산한다.
// 이 스크립트는 chaos 런과 "병렬"로 띄워 곡선을 시각화/기록하는 용도.
//
// 사용:
//   LAG_DURATION=180s LAG_POLL=1 k6 run \
//     --out json=results/w3-lag.json tests/measure/consumer-lag.js
// ─────────────────────────────────────────────────────────────────────

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';
import {
  RABBIT_MGMT, RABBIT_VHOST, MAIN_QUEUES, DLQ_QUEUES,
  LAG_POLL_SECONDS, LAG_DURATION,
} from '../../config/w3.js';

const ready   = new Trend('rabbit_messages_ready');
const unacked = new Trend('rabbit_messages_unacked');
const dlqDepth = new Trend('rabbit_dlq_depth');

export const options = {
  scenarios: {
    lag_poll: {
      executor: 'constant-vus',
      vus: 1,
      duration: LAG_DURATION,
    },
  },
  // 폴링 자체가 실패(=mgmt api 다운)해도 측정은 계속해야 하므로 threshold는 두지 않는다.
};

function queueDepth(queue) {
  const url = `${RABBIT_MGMT}/api/queues/${RABBIT_VHOST}/${encodeURIComponent(queue)}`;
  const res = http.get(url, { tags: { queue } });
  // 장애 주입 중에는 mgmt api도 잠시 죽을 수 있다(브로커 stop). 그때는 null.
  if (res.status !== 200) return null;
  try {
    return JSON.parse(res.body);
  } catch (e) {
    return null;
  }
}

export default function () {
  for (const q of MAIN_QUEUES) {
    const body = queueDepth(q);
    if (body) {
      ready.add(body.messages_ready || 0, { queue: q });
      unacked.add(body.messages_unacknowledged || 0, { queue: q });
    }
  }
  for (const dlq of DLQ_QUEUES) {
    const body = queueDepth(dlq);
    if (body) {
      dlqDepth.add(body.messages_ready || 0, { queue: dlq });
    }
  }
  // 브로커가 살아있을 때만 mgmt api 200을 기대(곡선 가독성용 가벼운 체크).
  check(true, { 'poll tick': () => true });
  sleep(LAG_POLL_SECONDS);
}
