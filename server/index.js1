import { createZarinpal } from './zarinpal.js';
import { createMockGateway } from './mock.js';

export function createGateway({ config, db, clock, fetchImpl }) {
  if (config.payment.gateway === 'zarinpal') return createZarinpal(config.payment.zarinpal, fetchImpl);
  return createMockGateway({ db, baseUrl: config.baseUrl, clock });
}
