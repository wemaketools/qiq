import { DEMO_PASSWORD } from './demoAccountList';

/**
 * The password the card signs in with. Local stacks are seeded with DEMO_PASSWORD; the deployed
 * environments' demo users use 123456. Public on purpose (owner's decision): the deployed demo
 * users exist only to show prospective customers the product.
 */
export const CARD_PASSWORD = import.meta.env.DEV ? DEMO_PASSWORD : '123456';
